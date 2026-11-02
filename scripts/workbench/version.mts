/** Keep application manifests and lockfiles on the same release version. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFile(path.join(root, file), "utf8");
const manifest = JSON.parse(await read("package.json"));
const check = process.argv[2] === "--check";
const version = check ? manifest.version : process.argv[2];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
  throw new Error(
    "Usage: node scripts/workbench/version.mts <year.month.release> | --check",
  );

const changes = new Map<string, string>();
const manifests = [
  "package.json",
  ...manifest.workspaces.map((w: string) => `${w}/package.json`),
  "apps/workbench/src-tauri/tauri.conf.json",
];
for (const file of manifests) {
  const source = await read(file);
  const data = JSON.parse(source);
  if (check && data.version !== version)
    throw new Error(`Version mismatch: ${file}`);
  changes.set(
    file,
    source.replace(/("version"\s*:\s*")[^"]+"/, `$1${version}"`),
  );
}

const lockFile = "package-lock.json";
const lock = JSON.parse(await read(lockFile));
for (const entry of [
  lock,
  ...["", ...manifest.workspaces].map((w) => lock.packages[w]),
]) {
  if (!entry || (check && entry.version !== version))
    throw new Error("Version mismatch: package-lock.json");
  entry.version = version;
}
changes.set(lockFile, JSON.stringify(lock, null, 2) + "\n");

const cargo = await read("Cargo.toml");
const workspaceVersion = /(\[workspace\.package\]\s*\nversion\s*=\s*")[^"]+"/;
if (!workspaceVersion.test(cargo))
  throw new Error("Missing Cargo workspace version");
const nextCargo = cargo.replace(workspaceVersion, `$1${version}"`);
if (check && cargo !== nextCargo)
  throw new Error("Version mismatch: Cargo.toml");
changes.set("Cargo.toml", nextCargo);

let cargoLock = await read("Cargo.lock");
const members: string[] = JSON.parse(
  cargo.match(/^members\s*=\s*(\[[^\]]+\])/m)![1],
);
for (const member of members) {
  const name = (await read(`${member}/Cargo.toml`)).match(
    /^name\s*=\s*"([^"]+)"/m,
  )![1];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = ")[^"]+"`,
  );
  if (!pattern.test(cargoLock))
    throw new Error(`Missing locked workspace package: ${name}`);
  const next = cargoLock.replace(pattern, `$1${version}"`);
  if (check && next !== cargoLock)
    throw new Error(`Version mismatch in Cargo.lock: ${name}`);
  cargoLock = next;
}
changes.set("Cargo.lock", cargoLock);

if (check) {
  if (
    process.env.GITHUB_REF_TYPE === "tag" &&
    process.env.GITHUB_REF_NAME !== `v${version}`
  )
    throw new Error("Release tag must match the application version");
  if (!(await read(`docs/releases/v${version}.md`)).trim())
    throw new Error("Release notes are empty");
  console.log(`Verified release ${version}`);
} else {
  for (const [file, content] of changes)
    await writeFile(path.join(root, file), content);
  console.log(`Updated application version to ${version}`);
}
