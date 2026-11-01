import { spawn } from "node:child_process";
import {
  mkdir,
  writeFile,
  cp,
  chmod,
  rm,
  readFile,
  readdir,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { verifyJavaRelocation } from "./verify-java.mts";
const root = path.resolve(import.meta.dirname, "../..");
if (!["linux", "win32"].includes(process.platform) || process.arch !== "x64")
  throw new Error("Packaging supports Linux and Windows x64");
const windows = process.platform === "win32";
const tar = windows
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32/tar.exe")
  : "tar";
const target = `${process.platform}-${process.arch}`;
const version: string = JSON.parse(
  await readFile(
    path.join(root, "apps/workbench/src-tauri/tauri.conf.json"),
    "utf8",
  ),
).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("Invalid desktop package version");
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== `v${version}`
)
  throw new Error("Release tag must match the desktop package version");
// CI builds a lower-version installer from the same source to test NSIS upgrades.
const baseline = process.argv.includes("--upgrade-baseline");
if (baseline && !windows)
  throw new Error("NSIS upgrade baseline requires Windows");
async function run(command: string, args: string[], cwd = root) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(command, args, { cwd, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
await run(process.execPath, ["scripts/workbench/prepare-product.mts"]);
const cache = path.join(root, ".workbench-cache"),
  product = path.join(cache, "product");
await verifyJavaRelocation(path.join(product, "runtimes/java"));
const config = path.join(cache, "tauri-package.json");
await writeFile(
  config,
  JSON.stringify(
    {
      ...(baseline ? { version: "0.0.0" } : {}),
      bundle: {
        active: true,
        targets: [windows ? "nsis" : "deb"],
        icon: ["icons/32x32.png", "icons/128x128.png", "icons/icon.ico"],
        windows: {
          nsis: {
            installMode: "currentUser",
            languages: ["SimpChinese", "English"],
            displayLanguageSelector: false,
          },
          webviewInstallMode: { type: "downloadBootstrapper", silent: true },
        },
        resources: { [product + "/"]: "workbench/" },
        category: "Education",
        shortDescription: "Digital circuit editor and simulation workspace",
        linux: {
          deb: {
            depends: [
              "libwebkit2gtk-4.1-0",
              "libgtk-3-0",
              "libayatana-appindicator3-1",
            ],
          },
        },
      },
    },
    null,
    2,
  ),
);
const stagedResources = path.join(root, "target/release/workbench");
try {
  const previous = JSON.parse(
    await readFile(path.join(stagedResources, "product.json"), "utf8"),
  );
  if (previous.schema !== 1) throw new Error("Unrecognized staged product");
  await rm(stagedResources, { recursive: true });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await run(
  process.execPath,
  [
    path.join(root, "apps/workbench/node_modules/@tauri-apps/cli/tauri.js"),
    "build",
    "--config",
    config,
  ],
  path.join(root, "apps/workbench"),
);
if (baseline) {
  const directory = path.join(root, "target/release/bundle/nsis");
  const files = (await readdir(directory)).filter(
    (file) => file.includes("_0.0.0_") && file.endsWith(".exe"),
  );
  if (files.length !== 1)
    throw new Error("Expected exactly one baseline installer");
  await cp(
    path.join(directory, files[0]),
    path.join(cache, "upgrade-baseline.exe"),
  );
  await rm(path.join(directory, files[0]));
  console.log("Windows upgrade baseline ready.");
  process.exit(0);
}
const portable = path.join(cache, `Vibe-Logisim-${target}`);
await rm(portable, { recursive: true, force: true });
await mkdir(path.join(portable, "resources"), { recursive: true });
await cp(product, path.join(portable, "resources/workbench"), {
  recursive: true,
  dereference: true,
});
await cp(
  path.join(root, "target/release/vibe-logisim-app" + (windows ? ".exe" : "")),
  path.join(portable, "vibe-logisim" + (windows ? ".exe" : "")),
);
if (windows) {
  // Leave room for the destination directory added by Explorer's Extract All.
  const inspect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (path.relative(cache, file).length > 140)
        throw new Error(
          `Portable path exceeds Windows extraction budget: ${path.relative(cache, file)}`,
        );
    }
  };
  await inspect(portable);
  await writeFile(
    path.join(portable, "start.cmd"),
    '@echo off\r\nset "VIBE_WORKBENCH_RESOURCES=%~dp0resources\\workbench"\r\nstart "" "%~dp0vibe-logisim.exe" %*\r\n',
  );
  await writeFile(
    path.join(portable, "README.txt"),
    "Run start.cmd. Microsoft Edge WebView2 is required. Node.js and Java are included.\r\n",
  );
  await run(tar, [
    "-a",
    "-cf",
    path.join(cache, `Vibe-Logisim-${target}.zip`),
    "-C",
    cache,
    path.basename(portable),
  ]);
} else {
  await writeFile(
    path.join(portable, "start.sh"),
    '#!/bin/sh\nset -eu\napp_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport VIBE_WORKBENCH_RESOURCES="$app_dir/resources/workbench"\nexec "$app_dir/vibe-logisim" "$@"\n',
  );
  await chmod(path.join(portable, "start.sh"), 0o755);
  await writeFile(
    path.join(portable, "README.txt"),
    "Run ./start.sh. Linux requires WebKitGTK 4.1 and GTK 3. Node.js and Java are included.\n",
  );
  await run(tar, [
    "-czf",
    path.join(cache, `Vibe-Logisim-${target}.tar.gz`),
    "-C",
    cache,
    path.basename(portable),
  ]);
}
// Keep stable local paths for desktop checks and versioned copies for distribution.
const release = path.join(cache, "release");
await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });
const extension = windows ? "zip" : "tar.gz";
const archive = `vibe-logisim-${version}-${target}.${extension}`;
await cp(
  path.join(cache, `Vibe-Logisim-${target}.${extension}`),
  path.join(release, archive),
);
const installers = path.join(
  root,
  "target/release/bundle",
  windows ? "nsis" : "deb",
);
const installerFiles = (await readdir(installers)).filter(
  (name) =>
    name.includes(`_${version}_`) && name.endsWith(windows ? ".exe" : ".deb"),
);
if (installerFiles.length !== 1)
  throw new Error("Expected one installer for the current version");
const installer = `vibe-logisim-${version}-${target}${windows ? "-setup.exe" : ".deb"}`;
await cp(
  path.join(installers, installerFiles[0]),
  path.join(release, installer),
);
const sums: string[] = [];
for (const name of [archive, installer].sort()) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path.join(release, name)))
    hash.update(chunk);
  sums.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(
  path.join(release, `SHA256SUMS-${target}.txt`),
  sums.join("\n") + "\n",
);
console.log(
  "Desktop packages ready in target/release/bundle and .workbench-cache/release.",
);
