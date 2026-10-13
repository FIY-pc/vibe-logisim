/** Launch the actual portable desktop from its archive, outside the checkout. */
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkDesktop, cleanupDesktop, run } from "./desktop-check.mts";

const root = path.resolve(import.meta.dirname, "../..");
const windows = process.platform === "win32";
const target = `${process.platform}-${process.arch}`;
const base = `Vibe-Logisim-${target}`;
const directory = await mkdtemp(
  path.join(tmpdir(), "Vibe desktop 安装 check "),
);
let failure: unknown;
try {
  const archive = path.join(
    root,
    ".workbench-cache",
    `${base}.${windows ? "zip" : "tar.gz"}`,
  );
  if (windows) {
    // Windows tar's narrow-character path handling loses the Unicode test
    // directory. .NET receives the original paths through Unicode environment
    // variables; neither path is interpolated into PowerShell source.
    await run(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:VIBE_DESKTOP_CHECK_ARCHIVE, $env:VIBE_DESKTOP_CHECK_DESTINATION)",
      ],
      {
        env: {
          ...process.env,
          VIBE_DESKTOP_CHECK_ARCHIVE: archive,
          VIBE_DESKTOP_CHECK_DESTINATION: directory,
        },
      },
    );
  } else {
    await run("tar", ["-xf", archive, "-C", directory]);
  }
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
} catch (error) {
  failure = error;
  throw error;
} finally {
  await cleanupDesktop(directory, failure);
}
