import { fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const windows = process.platform === "win32";
const commands: [string, string[]][] = [
  ["cargo", ["run", "-p", "vibe-workbench-host"]],
  [
    windows ? "npm.cmd" : "npm",
    ["run", "dev", "-w", "@vibe-logisim/workbench"],
  ],
];
function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/taskkill.exe",
      ),
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("error", (error) => {
      console.error(error.message);
      resolve();
    });
    killer.once("exit", () => resolve());
  });
}
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error);
  }
}

if (process.send) {
  // Keep an owned tree root alive even if npm/cargo exits before its descendants.
  // Windows taskkill /T needs that root to exist; Unix uses its separate process group.
  const [program, args] = commands[Number(process.argv[2])];
  const child = spawn(program, args, {
    stdio: "inherit",
    shell: windows && program === "npm.cmd",
  });
  const report = (code: number) => {
    if (process.connected) process.send?.({ code });
  };
  child.once("error", (error) => {
    console.error(error.message);
    report(1);
  });
  child.once("exit", (code, signal) => report(code ?? (signal ? 1 : 0)));
  process.on("message", () => {}); // Keep the supervisor's IPC channel referenced until cleanup.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  process.on("disconnect", () => {
    if (windows) void killWindowsTree(process.pid);
    else signalGroup(process.pid, "SIGKILL");
  });
} else {
  const children: ChildProcess[] = [];
  let stopping = false;
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    const pids = children.flatMap((child) => (child.pid ? [child.pid] : []));
    if (windows) {
      await Promise.all(pids.map(killWindowsTree));
    } else {
      // Give the host time to shut down Java/Node; then reclaim any resistant descendants.
      pids.forEach((pid) => signalGroup(pid, "SIGTERM"));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      pids.forEach((pid) => signalGroup(pid, "SIGKILL"));
    }
  }
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  for (let index = 0; index < commands.length; index++) {
    if (stopping) break;
    const child = fork(fileURLToPath(import.meta.url), [String(index)], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      detached: !windows,
    });
    children.push(child);
    child.on("message", (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "code" in message &&
        typeof message.code === "number"
      )
        void stop(message.code);
    });
    child.once("error", (error) => {
      console.error(error.message);
      void stop(1);
    });
    child.once("exit", (code, signal) => void stop(code ?? (signal ? 1 : 0)));
  }
}
