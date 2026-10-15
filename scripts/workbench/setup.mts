/** Install only the public, checksum-pinned compatibility runtimes for development. */
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const lock = JSON.parse(
  await readFile(path.join(root, "config/runtime-lock.json"), "utf8"),
);
const directory = path.join(root, ".workbench-cache");
await mkdir(directory, { recursive: true });
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
for (const [artifact, file] of [
  ["logisim.jar", "Logisim-ITA.jar"],
  ["logisim-2.15", "logisim-ita-cn-20200118.exe"],
]) {
  const spec = lock.artifacts[artifact];
  const target = path.join(directory, file);
  let present: Buffer | null = null;
  try {
    present = await readFile(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (present) {
    if (hash(present) !== spec.sha256)
      throw new Error(
        `Cached ${file} does not match runtime-lock.json; retained for inspection`,
      );
    continue;
  }
  console.log(`Downloading ${spec.version}…`);
  const response = await fetch(spec.url, {
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok)
    throw new Error(`${file} download: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (hash(bytes) !== spec.sha256)
    throw new Error(`${file} download checksum mismatch`);
  const temp = target + "." + process.pid + ".tmp";
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}
console.log(
  "Logisim compatibility runtimes ready. Development requires Node 24, the pinned Rust toolchain, and JDK 17+.",
);
