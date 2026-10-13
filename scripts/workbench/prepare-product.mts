/** Assemble explicitly selected runtime resources. No user profiles or development modules. */
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
  readdir,
  stat,
  mkdtemp,
  chmod,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream, createReadStream } from "node:fs";
import path from "node:path";
import { patchWindowsJava } from "./windows-java-utf8.mts";
const root = path.resolve(import.meta.dirname, "../..");
if (!["linux", "win32"].includes(process.platform) || process.arch !== "x64")
  throw new Error("Resource assembly supports Linux and Windows x64");
const target = `${process.platform}-${process.arch}`;
const windows = process.platform === "win32";
const tar = windows
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32/tar.exe")
  : "tar";
const executable = (name: string) => name + (windows ? ".exe" : "");
const cache = path.join(root, ".workbench-cache");
await mkdir(cache, { recursive: true });
const output = path.join(cache, "product");
const stage = await mkdtemp(path.join(cache, "product-stage-"));
const downloads = path.join(cache, "downloads");
await mkdir(downloads, { recursive: true });
const lock = JSON.parse(
  await readFile(
    path.join(root, "scripts/distribution/runtime-lock.json"),
    "utf8",
  ),
);
const own = JSON.parse(
  await readFile(
    path.join(root, "scripts/workbench/runtime-lock.json"),
    "utf8",
  ),
);
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(command, args, { cwd: root, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
async function digest(file: string) {
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest("hex");
}
async function acquire(name: string, spec: { url: string; sha256: string }) {
  const file = path.join(downloads, name);
  try {
    if ((await digest(file)) === spec.sha256) return file;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  console.log("Downloading " + name);
  const temp = file + "." + process.pid + ".tmp";
  try {
    const response = await fetch(spec.url, {
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok || !response.body)
      throw new Error(`${name}: HTTP ${response.status}`);
    await pipeline(
      Readable.fromWeb(response.body as any),
      createWriteStream(temp, { flags: "wx" }),
    );
    if ((await digest(temp)) !== spec.sha256)
      throw new Error("Checksum mismatch: " + name);
    await rename(temp, file);
    return file;
  } finally {
    await rm(temp, { force: true });
  }
}
async function files(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(p)));
    else if (entry.isFile()) result.push(p);
  }
  return result;
}
try {
  const [node, java, jar, source] = await Promise.all([
    acquire(
      `node-${own.node.version}-${target}.${windows ? "zip" : "tar.xz"}`,
      own.node[target],
    ),
    acquire(
      `temurin-21-${target}.${windows ? "zip" : "tar.gz"}`,
      lock.targets[target].artifacts.java,
    ),
    acquire("Logisim-ITA.jar", lock.artifacts["logisim.jar"]),
    acquire("Logisim-source.tar.gz", lock.artifacts["logisim-source.tar.gz"]),
  ]);
  const unpack = path.join(stage, ".build");
  await mkdir(unpack);
  for (const [name, archive] of [
    ["node", node],
    ["jdk", java],
  ]) {
    const dir = path.join(unpack, name);
    await mkdir(dir);
    await run(tar, ["-xf", archive, "--strip-components=1", "-C", dir]);
  }
  await run(process.execPath, ["scripts/workbench/bundle-agent.mts", stage]);
  const runtime = path.join(stage, "runtimes");
  await mkdir(path.join(runtime, "node"), { recursive: true });
  await cp(
    path.join(unpack, windows ? "node/node.exe" : "node/bin/node"),
    path.join(runtime, "node", executable("node")),
  );
  await cp(
    path.join(unpack, "node/LICENSE"),
    path.join(runtime, "node/LICENSE"),
  );
  const jdk = path.join(unpack, "jdk");
  await run(path.join(jdk, "bin", executable("jlink")), [
    "--module-path",
    path.join(jdk, "jmods"),
    "--add-modules",
    "java.base,java.desktop,java.logging,java.prefs,java.sql,java.xml,jdk.compiler,jdk.zipfs,jdk.charsets,jdk.unsupported,jdk.localedata",
    "--strip-debug",
    "--no-header-files",
    "--no-man-pages",
    "--compress",
    "zip-6",
    "--output",
    path.join(runtime, "java"),
  ]);
  const native = path.join(stage, "native");
  if (windows) await patchWindowsJava(path.join(runtime, "java"));
  await mkdir(path.join(native, "classes"), { recursive: true });
  await cp(jar, path.join(native, "Logisim-ITA.jar"));
  for (const directory of ["native", "observer/src"]) {
    const base = path.join(root, "crates/logisim-adapter/java", directory);
    for (const file of await files(base))
      if (file.endsWith(".java")) {
        const dest = path.join(native, "src", path.relative(base, file));
        await mkdir(path.dirname(dest), { recursive: true });
        await cp(file, dest);
      }
  }
  await run(path.join(jdk, "bin", executable("javac")), [
    "--release",
    "17",
    "-encoding",
    "UTF-8",
    "-cp",
    jar,
    "-d",
    path.join(native, "classes"),
    ...(await files(path.join(native, "src"))),
  ]);
  await writeFile(
    path.join(native, "runtime.sha256"),
    lock.artifacts["logisim.jar"].sha256 + "\n",
  );
  await mkdir(path.join(stage, "third-party/logisim"), { recursive: true });
  await cp(source, path.join(stage, "third-party/logisim/source.tar.gz"));
  await cp(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
  await writeFile(
    path.join(stage, "product.json"),
    JSON.stringify(
      {
        schema: 1,
        platform: target,
        node: own.node.version,
        java: lock.targets[target].artifacts.java.version,
        logisim: lock.artifacts["logisim.jar"],
        source: lock.artifacts["logisim-source.tar.gz"],
      },
      null,
      2,
    ) + "\n",
  );
  await rm(unpack, { recursive: true });
  // Tauri overwrites its staged resources on rebuild. Vendor notices may be read-only.
  for (const file of await files(stage))
    await chmod(file, (await stat(file)).mode | 0o200);
  // Only generated output under .workbench-cache is replaced.
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
  const size = (
    await Promise.all(
      (await files(output)).map(async (f) => (await stat(f)).size),
    )
  ).reduce((a, b) => a + b, 0);
  console.log(
    `Product resources: ${(size / 1024 / 1024).toFixed(1)} MiB at ${output}`,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
