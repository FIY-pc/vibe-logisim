/** Build the Node sidecar from explicit modules, without Electron or node_modules. */
import { build } from "esbuild";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const output = path.resolve(
  process.argv[2] || path.join(root, ".workbench-cache", "agent-product"),
);
if (!process.argv[2]) await rm(output, { recursive: true, force: true });
const copied = new Set<string>();
async function copy(relative: string) {
  if (copied.has(relative)) return;
  copied.add(relative);
  const source = path.join(root, relative),
    destination = path.join(output, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (!relative.endsWith(".cjs")) return;
  const text = await readFile(source, "utf8");
  for (const match of text.matchAll(
    /(?:require|import)\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  )) {
    // These are repository-relative module identifiers, even on Windows.
    const dependency = path.posix.normalize(
      path.posix.join(path.posix.dirname(relative), match[1]),
    );
    if (!dependency.startsWith("packages/agent-runtime/core/"))
      throw new Error("Unexpected runtime dependency: " + dependency);
    if (dependency.endsWith("builtin-sdk.mjs")) continue;
    await copy(dependency);
  }
}
for (const entry of ["agent-runtime.cjs", "runtime-installer.cjs"])
  await copy("packages/agent-runtime/core/" + entry);
for (const file of [
  "index.md",
  "digital-design.md",
  "java-runtime.md",
  "skills/circuit-organization/SKILL.md",
  "skills/circuit-organization/references/arrangement.md",
])
  await copy("packages/agent-runtime/circuit-knowledge/" + file);
await copy("scripts/distribution/runtime-lock.json");
await copy("packages/agent-runtime/src/generated/edit-schema.json");
const entries = [
  [
    "packages/agent-runtime/src/worker.mts",
    "packages/agent-runtime/src/worker.mjs",
  ],
  [
    "packages/agent-runtime/core/builtin-sdk.mjs",
    "packages/agent-runtime/core/builtin-sdk.mjs",
  ],
];
const inputs = new Set<string>();
for (const [entry, out] of entries) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: path.join(output, out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    minify: true,
    keepNames: true,
    metafile: true,
    legalComments: "inline",
    banner: {
      js: 'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);',
    },
  });
  Object.keys(result.metafile!.inputs).forEach((file) => inputs.add(file));
}
const packages = new Set<string>(),
  index: unknown[] = [];
for (const input of inputs) {
  if (!input.includes("node_modules/")) continue;
  let directory = path.dirname(path.resolve(root, input));
  for (;;) {
    try {
      await stat(path.join(directory, "package.json"));
      break;
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Package metadata unavailable");
    directory = parent;
  }
  packages.add(directory);
}
for (const directory of packages) {
  const pkg = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  index.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
  });
  const destination = path.join(
    output,
    "third-party/node",
    pkg.name + "@" + pkg.version,
  );
  await mkdir(destination, { recursive: true });
  for (const file of await readdir(directory))
    if (
      /^(licen[sc]e|copying|notice)/i.test(file) &&
      (await stat(path.join(directory, file))).isFile()
    )
      await copyFile(path.join(directory, file), path.join(destination, file));
}
await writeFile(
  path.join(output, "third-party/node/packages.json"),
  JSON.stringify(index, null, 2) + "\n",
);
console.log(
  `Agent product: ${copied.size} application files, ${packages.size} dependency notices. No Electron or Python application service.`,
);
