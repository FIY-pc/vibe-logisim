import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A clean shell environment and process group, not a filesystem sandbox. */
export async function macosCommand(
  commandText: string,
  options: {
    root: string;
    referenceRoot: string;
    runtimeRoot?: string | null;
    outputRoot: string;
    signal?: AbortSignal;
    timeout: number;
    onData: (data: Buffer) => void;
  },
): Promise<{ exitCode: number | null }> {
  const {
    root,
    referenceRoot,
    runtimeRoot,
    outputRoot,
    signal,
    timeout,
    onData,
  } = options;
  if (signal?.aborted) throw new Error("aborted");
  const temporary = await mkdtemp(path.join(tmpdir(), "vibe-command-"));
  try {
    const script = path.join(temporary, "command.sh");
    await writeFile(script, commandText, "utf8");
    if (signal?.aborted) throw new Error("aborted");
    return await new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", ["--noprofile", "--norc", script], {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: temporary,
          TMPDIR: temporary,
          LANG: "en_US.UTF-8",
          PATH: [
            path.dirname(process.execPath),
            ...(runtimeRoot ? [path.join(runtimeRoot, "java/bin")] : []),
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            ...(process.env.PATH ? [process.env.PATH] : []),
          ].join(path.delimiter),
          VIBE_PROJECT_ROOT: root,
          VIBE_CIRCUIT_REFERENCE: referenceRoot,
          VIBE_TOOL_OUTPUT: outputRoot,
          ...(runtimeRoot ? { VIBE_RUNTIME: runtimeRoot } : {}),
        },
      });
      let stopped: string | undefined;
      const killGroup = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Darwin can return EPERM for a reaped, now-empty process group.
          if (
            code !== "ESRCH" &&
            !(
              code === "EPERM" &&
              (child.exitCode !== null || child.signalCode !== null)
            )
          )
            throw error;
        }
      };
      const stop = (reason: string) => {
        stopped ??= reason;
        killGroup();
      };
      const abort = () => stop("aborted");
      const timer =
        timeout > 0
          ? setTimeout(() => stop(`timeout:${timeout}`), timeout * 1000)
          : undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      // End background jobs too, before waiting for inherited stdout to close.
      child.once("exit", killGroup);
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code) => {
        cleanup();
        if (stopped) reject(new Error(stopped));
        else resolve({ exitCode: code });
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
