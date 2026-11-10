import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { windowsCommand } from "./windows-command.mts";
import { macosCommand } from "./macos-command.mts";
import { OUTPUT_MOUNT } from "./output-store.mts";

// Process isolation and lifetime only; Pi owns output accumulation and UTF-8.
export async function shellCommand(
  commandText: string,
  {
    root,
    referenceRoot,
    runtimeRoot,
    outputRoot,
    signal,
    timeout = 0,
    onData,
  }: {
    root: string;
    referenceRoot: string;
    runtimeRoot?: string | null;
    outputRoot: string;
    signal?: AbortSignal;
    timeout?: number;
    onData: (data: Buffer) => void;
  },
) {
  if (process.platform === "win32")
    return windowsCommand(commandText, {
      root,
      referenceRoot,
      runtimeRoot,
      signal,
      timeout,
      outputRoot,
      onData,
    });
  if (process.platform === "darwin")
    return macosCommand(commandText, {
      root,
      referenceRoot,
      runtimeRoot,
      outputRoot,
      signal,
      timeout,
      onData,
    });
  if (process.platform !== "linux")
    throw new Error("当前系统尚不支持命令执行，请使用文件和电路工具");
  const unit = `vibe-builtin-${randomUUID()}.service`;
  const bind = (source: any, target: string) =>
    `${JSON.stringify(source)}:${JSON.stringify(target)}`;
  const readOnly = [
    bind(referenceRoot, "/tmp/vibe-circuit-reference"),
    bind(outputRoot, OUTPUT_MOUNT),
  ];
  if (runtimeRoot) readOnly.push(bind(runtimeRoot, "/tmp/vibe-runtime"));
  const args = [
    "--user",
    "--pipe",
    "--quiet",
    "--collect",
    "--service-type=exec",
    "--expand-environment=no",
    `--unit=${unit}`,
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=tmpfs",
    "--property=PrivateTmp=yes",
    "--property=PrivateDevices=yes",
    "--property=PrivateIPC=yes",
    "--property=ProtectProc=invisible",
    "--property=ProcSubset=pid",
    "--property=InaccessiblePaths=/run /var -/opt -/srv -/media -/mnt -/boot -/sys -/.snapshots",
    `--property=BindPaths=${bind(root, "/tmp/workspace")}`,
    `--property=BindReadOnlyPaths=${readOnly.join(" ")}`,
    "--property=NoNewPrivileges=yes",
    "--property=CapabilityBoundingSet=",
    "--property=RestrictSUIDSGID=yes",
    ...(timeout > 0 ? [`--property=RuntimeMaxSec=${timeout + 2}`] : []),
    "--property=UMask=0077",
    "--property=MemoryMax=6442450944",
    "--property=TasksMax=512",
    "--working-directory=/tmp/workspace",
    "/usr/bin/env",
    "-i",
    "HOME=/tmp",
    `PATH=${runtimeRoot ? "/tmp/vibe-runtime/java/bin:" : ""}/usr/bin:/bin`,
    "LANG=C.UTF-8",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
    commandText,
  ];
  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const child = spawn("systemd-run", args, {
      cwd: "/",
      env: {
        PATH: process.env.PATH,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stopped: "aborted" | `timeout:${number}` | undefined;
    let stopTimer: ReturnType<typeof setInterval> | undefined;
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () =>
      execFile(
        "systemctl",
        ["--user", "kill", "--signal=SIGKILL", unit],
        () => {},
      );
    const stop = (reason: "aborted" | `timeout:${number}`) => {
      stopped ??= reason;
      kill();
      stopTimer ||= setInterval(kill, 100);
    };
    const abort = () => stop("aborted");
    const timer =
      timeout > 0
        ? setTimeout(() => stop(`timeout:${timeout}`), timeout * 1000)
        : undefined;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(stopTimer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", (e: any) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code: any) => {
      cleanup();
      stopped ? reject(new Error(stopped)) : resolve({ exitCode: code });
    });
  });
}
