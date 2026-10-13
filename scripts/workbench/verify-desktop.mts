/** Launch the actual portable desktop from its archive, outside the checkout. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkDesktop, run } from "./desktop-check.mts";

const root = path.resolve(import.meta.dirname, "../..");
const windows = process.platform === "win32";
const target = `${process.platform}-${process.arch}`;
const base = `Vibe-Logisim-${target}`;
const directory = await mkdtemp(
  path.join(tmpdir(), "Vibe desktop 安装 check "),
);
try {
  const tar = windows
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32/tar.exe")
    : "tar";
  await run(tar, [
    "-xf",
    path.join(
      root,
      ".workbench-cache",
      `${base}.${windows ? "zip" : "tar.gz"}`,
    ),
    "-C",
    directory,
  ]);
  const app = path.join(directory, base);
  const reports = path.join(root, ".workbench-cache/checks");
  await mkdir(reports, { recursive: true });
  const options = {
    binary: path.join(app, `vibe-logisim${windows ? ".exe" : ""}`),
    resources: path.join(app, "resources/workbench"),
    portable: true,
    state: path.join(directory, "isolated-state"),
    report: path.join(reports, `desktop-${target}-first.json`),
  };
  const previous = await checkDesktop(options);
  await checkDesktop({
    ...options,
    previous,
    report: path.join(reports, `desktop-${target}-restart.json`),
  });
  console.log(
    "Portable desktop passed: mounted frontend and IPC, bundled Java simulation, bundled Node startup, and draft recovery after restart. No system runtime PATH.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
