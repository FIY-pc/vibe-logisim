/** Destructive only to a temporary install on an ephemeral Windows CI runner. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkDesktop, cleanupDesktop, run } from "./desktop-check.mts";

if (process.platform !== "win32" || process.env.CI !== "true")
  throw new Error("Installer smoke must run on an ephemeral Windows CI runner");
const root = path.resolve(import.meta.dirname, "../..");
const cache = path.join(root, ".workbench-cache");
const baseline = path.join(cache, "upgrade-baseline.exe");
await access(baseline);
const version = JSON.parse(
  await readFile(
    path.join(root, "apps/workbench/src-tauri/tauri.conf.json"),
    "utf8",
  ),
).version;
const bundle = path.join(root, "target/release/bundle/nsis");
const names = (await readdir(bundle)).filter(
  (name) => name.endsWith(".exe") && name.includes(`_${version}_`),
);
assert.equal(
  names.length,
  1,
  "Expected exactly one current-version NSIS installer",
);
const current = path.join(bundle, names[0]);
const directory = await mkdtemp(path.join(tmpdir(), "Vibe installation 安装 "));
const installed = path.join(directory, "application");
const uninstall = path.join(installed, "uninstall.exe");
let installedOnce = false;
let failure: unknown;
try {
  const options = {
    binary: path.join(installed, "vibe-logisim-app.exe"),
    resources: path.join(installed, "workbench"),
    state: path.join(directory, "isolated-profile"),
    report: path.join(cache, "checks/windows-install-baseline.json"),
  };
  // /D= and _?= consume the rest of the NSIS command line; do not quote them.
  const install = async (file: string) => {
    await run(file, ["/S", `/D=${installed}`], {
      windowsVerbatimArguments: true,
      timeout: 300_000,
    });
    installedOnce = true;
    await access(uninstall);
    await access(options.binary);
  };
  await install(baseline);
  const before = await checkDesktop(options);
  assert.notEqual(
    before.version,
    version,
    "Upgrade baseline must have a different version",
  );
  await install(current);
  const after = await checkDesktop({
    ...options,
    previous: before,
    report: path.join(cache, "checks/windows-install-upgraded.json"),
  });
  assert.equal(after.version, version);
  await checkDesktop({
    ...options,
    previous: after,
    report: path.join(cache, "checks/windows-install-restarted.json"),
  });
  await run(uninstall, ["/S", `_?=${installed}`], {
    windowsVerbatimArguments: true,
  });
  installedOnce = false;
  await assert.rejects(
    access(options.binary),
    "Uninstall left the application executable behind",
  );
  await access(options.state); // Uninstall must not erase the separately stored user draft.
  console.log(
    "Windows installation, version upgrade, restart recovery, and uninstall passed. This checks native installer mechanics, not migration from the Electron application.",
  );
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (installedOnce) {
    try {
      await run(uninstall, ["/S", `_?=${installed}`], {
        windowsVerbatimArguments: true,
      });
    } catch {}
  }
  await cleanupDesktop(directory, failure);
}
