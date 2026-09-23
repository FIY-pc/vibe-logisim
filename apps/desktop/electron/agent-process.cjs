'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WINDOWS = process.platform === "win32";

function executableCandidates(directory, command) {
  if (!WINDOWS) return [path.join(directory, command)];
  // CreateProcess would append PATHEXT itself; do the same here so a bare
  // "codex" resolves to codex.exe when we stat it ahead of spawning.
  const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  const base = path.join(directory, command);
  return path.extname(command) ? [base] : [base, ...extensions.map(ext => base + ext.toLowerCase()), ...extensions.map(ext => base + ext)];
}

function resolveExecutable(command) {
  const explicit = command.includes(path.sep) || (WINDOWS && (command.includes("/") || /^[A-Za-z]:/.test(command)));
  const candidates = explicit
    ? executableCandidates(path.dirname(path.resolve(command)), path.basename(command))
    : String(process.env.PATH || (WINDOWS ? "" : "/usr/bin:/bin"))
      .split(path.delimiter)
      .filter(Boolean)
      .flatMap((directory) => executableCandidates(directory, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      return fs.realpathSync(candidate);
    } catch (_) {
      // Keep looking through PATH.
    }
  }
  throw new Error(`找不到可执行文件：${command}`);
}

// The isolation contract the rest of the harness relies on:
//   linux  -> systemd-run transient unit, workspace bind-mounted at /tmp/workspace,
//             Codex told it runs inside an external sandbox.
//   win32  -> no OS-level confinement is available without extra drivers; the
//             process runs directly and Codex's own workspace-write sandbox
//             policy is used instead (see codex-backend #sandboxPolicy).
function isolationKind() {
  if (process.platform === "linux") return "systemd-linux";
  if (WINDOWS) return "codex-workspace-write";
  return null;
}

function isolatedSpawn(agent, codexArgs, environment) {
    if (WINDOWS) return directSpawn(agent, codexArgs, environment);
    if (process.platform !== "linux") {
      throw new Error("当前版本只支持 Linux 和 Windows 上运行内置 AI；macOS 尚未验收。");
    }
    const systemdRun = resolveExecutable("systemd-run");
    const codex = resolveExecutable(agent.codex);
    const codeModeHost = resolveExecutable(process.env.VIBE_LOGISIM_CODE_MODE_HOST || "codex-code-mode-host");
    const sandboxProfile = "/tmp/codex";
    const sandboxWork = "/tmp/workspace";
    const circuitReference = path.resolve(__dirname, '../circuit-knowledge');
    const referenceMount = '/tmp/vibe-circuit-reference';
    const readOnlyPaths = [[circuitReference, referenceMount]];
    if (agent.runtimeRoot) readOnlyPaths.push([agent.runtimeRoot, '/tmp/vibe-runtime']);
    agent.runtimeWorkDir = sandboxWork;
    agent.referencePath = referenceMount;
    const unit = `vibe-logisim-agent-${process.pid}-${Date.now().toString(36)}.service`;
    let sandboxCodex = codex;
    let sandboxCodeModeHost = codeModeHost;
    const bindProperties = [
      [agent.profileDir, sandboxProfile],
      [agent.workDir, sandboxWork],
    ];
    if (agent.runtimeRoot) {
      sandboxCodex = "/tmp/vibe-runtime/codex/bin/codex";
      sandboxCodeModeHost = "/tmp/vibe-runtime/codex/bin/codex-code-mode-host";
    } else if (!(codex === "/usr" || codex.startsWith("/usr/"))) {
      sandboxCodex = "/tmp/vibe-logisim-codex";
      bindProperties.push([codex, sandboxCodex]);
    }
    if (!agent.runtimeRoot && !codeModeHost.startsWith("/usr/")) {
      sandboxCodeModeHost = "/tmp/codex-code-mode-host";
      bindProperties.push([codeModeHost, sandboxCodeModeHost]);
    }
    if (agent.sharedAuthPath) {
      // Authentication is the sole deliberate shared state. It must remain one
      // writable file so rotating refresh tokens are never forked into two
      // independently refreshed copies.
      bindProperties.push([agent.sharedAuthPath, `${sandboxProfile}/auth.json`]);
    }
    const args = [
      "--user",
      "--pipe",
      "--quiet",
      "--collect",
      "--service-type=exec",
      `--unit=${unit}`,
      "--property=ProtectSystem=strict",
      "--property=ProtectHome=tmpfs",
      "--property=PrivateTmp=yes",
      "--property=PrivateDevices=yes",
      "--property=PrivateIPC=yes",
      "--property=ProtectProc=invisible",
      "--property=ProcSubset=pid",
      "--property=InaccessiblePaths=/run /var -/opt -/srv -/media -/mnt -/boot -/sys -/.snapshots",
      `--property=BindPaths=${bindProperties.map(([source, target]) => `${JSON.stringify(source)}:${JSON.stringify(target)}`).join(" ")}`,
      `--property=BindReadOnlyPaths=${readOnlyPaths.map(([source, target]) => `${JSON.stringify(source)}:${JSON.stringify(target)}`).join(' ')}`,
      "--property=NoNewPrivileges=yes",
      "--property=RestrictSUIDSGID=yes",
      "--property=LockPersonality=yes",
      "--property=RestrictRealtime=yes",
      "--property=ProtectKernelTunables=yes",
      "--property=ProtectKernelModules=yes",
      "--property=ProtectKernelLogs=yes",
      "--property=ProtectControlGroups=yes",
      "--property=ProtectClock=yes",
      "--property=ProtectHostname=yes",
      "--property=CapabilityBoundingSet=",
      "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      // The writable staging project is the execution workspace. System paths
      // remain read-only; do not prohibit Python, shell or generated programs.
      "--property=UMask=0077",
      "--property=MemoryMax=2147483648",
      // App Server plus the V8 tool host each create a worker pool. A 64-task
      // combined cap can prevent the host from starting on multi-core machines.
      "--property=TasksMax=256",
      "--property=CPUQuota=200%",
      `--working-directory=${sandboxWork}`,
    ];
    // systemd copies these values from its environment; values never appear
    // in argv, generated TOML, or another active authentication profile.
    for (const key of Object.keys(agent.providerEnvironment || {})) args.push(`--setenv=${key}`);
    args.push(
      "/usr/bin/env",
      `HOME=${sandboxProfile}`,
      `CODEX_HOME=${sandboxProfile}`,
      agent.runtimeRoot ? "PATH=/tmp/vibe-runtime/codex/bin:/tmp/vibe-runtime/python/bin:/tmp/vibe-runtime/java/bin:/usr/bin" : "PATH=/tmp:/usr/bin",
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      `LANG=${process.env.LANG || "C.UTF-8"}`,
      `LC_ALL=${process.env.LC_ALL || "C.UTF-8"}`,
      "NO_COLOR=1",
      agent.runtimeRoot ? "/tmp/vibe-runtime/python/bin/python3" : (process.env.VIBE_LOGISIM_PYTHON || "/usr/bin/python3"),
      "-c",
      "import os,sys; os.execvpe(sys.argv[2],sys.argv[2:],{k:os.environ[k] for k in sys.argv[1].split(',') if k in os.environ})",
      ["HOME", "CODEX_HOME", "PATH", "SSL_CERT_FILE", "LANG", "LC_ALL", "NO_COLOR", ...Object.keys(agent.providerEnvironment || {})].join(","),
      sandboxCodex,
      ...codexArgs,
    );
    return {
      command: systemdRun,
      args,
      cwd: "/",
      env: environment,
      unit,
    };
  }

// Windows: spawn codex.exe directly. The workspace the model sees is the
// user's real folder path. `environment` is already the reduced allow-list
// built by CodexBackend#childEnvironment; we only add what Windows itself
// needs to run a process (DLL search, TLS, temp dir, PATHEXT).
function directSpawn(agent, codexArgs, environment) {
    const codex = resolveExecutable(agent.codex);
    // Fail early with the same message the Linux path would give.
    resolveExecutable(process.env.VIBE_LOGISIM_CODE_MODE_HOST || "codex-code-mode-host");
    agent.runtimeWorkDir = agent.workDir;
    agent.referencePath = path.resolve(__dirname, '../circuit-knowledge');
    const env = {...environment};
    for (const name of ["SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
      "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "SystemDrive", "USERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
      if (process.env[name] && !(name in env)) env[name] = process.env[name];
    }
    if (!env.TEMP && !env.TMP) env.TEMP = env.TMP = require('node:os').tmpdir();
    const runtimeBins = agent.runtimeRoot
      ? [path.join(agent.runtimeRoot, 'codex', 'bin'), path.join(agent.runtimeRoot, 'python'), path.join(agent.runtimeRoot, 'java', 'bin')]
      : [path.dirname(codex)];
    env.PATH = [...runtimeBins, environment.PATH || process.env.PATH || ""].filter(Boolean).join(path.delimiter);
    return {
      command: codex,
      args: codexArgs,
      cwd: agent.workDir,
      env,
      unit: null,
    };
  }

module.exports = {isolatedSpawn, resolveExecutable, isolationKind};
