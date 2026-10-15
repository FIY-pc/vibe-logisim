import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Check the launcher before any classpath/bridge code, without publishing environment output. */
export async function verifyJavaRuntime(directory: string, label: string) {
  const windows = process.platform === "win32";
  const required = windows
    ? [
        "bin/java.exe",
        "bin/java.dll",
        "bin/jli.dll",
        "bin/server/jvm.dll",
        "lib/modules",
      ]
    : ["bin/java", "lib/server/libjvm.so", "lib/modules"];
  for (const file of required) {
    if (!(await stat(path.join(directory, file))).isFile())
      throw new Error(`${label}: missing runtime member ${file}`);
  }
  const result = await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(path.join(directory, required[0]), ["-version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = "";
      const timer = setTimeout(() => child.kill(), 20_000);
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (data: Buffer) => {
          output = (output + data.toString("utf8")).slice(-8192);
        });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `${label}: launcher spawn failed (${(error as NodeJS.ErrnoException).code || "unknown"})`,
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    },
  );
  if (result.code !== 0) {
    const known = [
      "Error: could not find java.dll",
      "Error: Could not find Java SE Runtime Environment.",
      "Error occurred during initialization of VM",
      "Error: Could not create the Java Virtual Machine.",
      "Error: Path length exceeds maximum length (PATH_MAX)",
    ].filter((line) => result.output.split(/\r?\n/).includes(line));
    throw new Error(
      `${label}: java -version exited ${result.code}; ${known.join("; ") || `no classified diagnostics (${Buffer.byteLength(result.output)} captured bytes)`}`,
    );
  }
  if (!/version "21[."]/u.test(result.output))
    throw new Error(`${label}: bundled launcher did not report Java 21`);
  console.log(
    `Verified ${label}: bundled Java 21 launcher and runtime members.`,
  );
}

export async function verifyJavaRelocation(directory: string) {
  await verifyJavaRuntime(directory, "original runtime");
  const temporary = await mkdtemp(path.join(tmpdir(), "Vibe Java 电路 check "));
  try {
    const relocated = path.join(temporary, "runtime");
    await cp(directory, relocated, { recursive: true, dereference: true });
    await verifyJavaRuntime(relocated, "runtime relocated to Unicode path");
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}
