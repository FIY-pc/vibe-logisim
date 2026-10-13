import { spawn } from "node:child_process";
import { mkdir, writeFile, cp, chmod, rm, readFile } from "node:fs/promises";
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
  const { readdir } = await import("node:fs/promises");
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
console.log(
  "Desktop packages ready in target/release/bundle and .workbench-cache.",
);
