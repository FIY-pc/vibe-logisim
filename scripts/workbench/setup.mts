/** Install only the public, checksum-pinned compatibility jar for development. */
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const lock = JSON.parse(
  await readFile(
    path.join(root, "config/runtime-lock.json"),
    "utf8",
  ),
);
const spec = lock.artifacts["logisim.jar"];
const directory = path.join(root, ".workbench-cache");
await mkdir(directory, { recursive: true });
const target = path.join(directory, "Logisim-ITA.jar");
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
let present: Buffer | null = null;
try {
  present = await readFile(target);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
if (present) {
  if (hash(present) !== spec.sha256)
    throw new Error(
      "Cached Logisim jar does not match runtime-lock.json; retained for inspection",
    );
} else {
  console.log("Downloading the public Logisim compatibility runtime…");
  const response = await fetch(spec.url, {
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok)
    throw new Error(`Logisim download: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (hash(bytes) !== spec.sha256)
    throw new Error("Logisim download checksum mismatch");
  const temp = target + "." + process.pid + ".tmp";
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}
console.log(
  "Logisim compatibility runtime ready. Development requires Node 24, the pinned Rust toolchain, and JDK 17+.",
);
