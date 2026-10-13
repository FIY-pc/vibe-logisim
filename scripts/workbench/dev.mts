import { spawn, type ChildProcess } from "node:child_process";
const children: ChildProcess[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  process.exitCode = code;
}
for (const [program, args] of [
  ["cargo", ["run", "-p", "vibe-workbench-host"]],
  ["npm", ["run", "dev", "-w", "@vibe-logisim/workbench"]],
] as [string, string[]][]) {
  const child = spawn(
    process.platform === "win32" && program === "npm" ? "npm.cmd" : program,
    args,
    {
      stdio: "inherit",
      shell: process.platform === "win32" && program === "npm",
    },
  );
  children.push(child);
  child.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code || 0));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
