'use strict';
const fs = require('node:fs');
const path = require('node:path');

function resolveExecutable(command) {
  const candidates = command.includes(path.sep)
    ? [path.resolve(command)]
    : String(process.env.PATH || "/usr/bin:/bin")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch (_) {
      // Keep looking through PATH.
    }
  }
  throw new Error(`找不到可执行文件：${command}`);
}


function isolatedSpawn(agent, codexArgs, environment) {
    if (process.platform !== "linux") {
      throw new Error("当前开发版只在 Linux 上提供本地 Circuit Agent 隔离；其他平台暂不裸跑 Codex。");
    }
    const systemdRun = resolveExecutable("systemd-run");
    const codex = resolveExecutable(agent.codex);
    const codeModeHost = resolveExecutable(process.env.VIBE_LOGISIM_CODE_MODE_HOST || "codex-code-mode-host");
    const sandboxProfile = "/tmp/codex";
    const sandboxWork = "/tmp/workspace";
    const circuitReference = path.resolve(__dirname, '../circuit-knowledge');
    const readOnlyPaths = [[circuitReference, '/tmp/vibe-circuit-reference']];
    if (agent.runtimeRoot) readOnlyPaths.push([agent.runtimeRoot, '/tmp/vibe-runtime']);
    agent.runtimeWorkDir = sandboxWork;
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

module.exports = {isolatedSpawn, resolveExecutable};
