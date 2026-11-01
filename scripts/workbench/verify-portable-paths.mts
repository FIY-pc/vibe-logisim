/** Exercise Windows' built-in ZIP reader from a destination that broke the old archive. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import path from "node:path";
import { checkDesktop, cleanupDesktop } from "./desktop-check.mts";

if (process.platform !== "win32")
  throw new Error("Portable extraction check requires Windows");
const root = path.resolve(import.meta.dirname, "../.."),
  cache = path.join(root, ".workbench-cache");
const temporary = await mkdtemp(path.join(cache, "extract-check-"));
const destination = path.join(
  temporary,
  "long-destination-".padEnd(Math.max(16, 110 - temporary.length - 1), "x"),
);
let failure: unknown;
try {
  const archive = path.join(cache, "Vibe-Logisim-win32-x64.zip");
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[System.IO.Compression.ZipFile]::OpenRead($env:VIBE_PATH_CHECK_ARCHIVE)
try {
  $members=@($archive.Entries | Where-Object { $_.Name })
  $max=($members | ForEach-Object { $_.FullName.Length } | Measure-Object -Maximum).Maximum
  if($max -gt 140){throw "Archive paths exceed extraction budget: $max"}
  if($members | Where-Object { $_.FullName.EndsWith('.class') }){throw 'Exploded Java classes must be packaged as JARs'}
  Write-Output "Maximum archive member path: $max characters"
} finally { $archive.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory($env:VIBE_PATH_CHECK_ARCHIVE,$env:VIBE_PATH_CHECK_DESTINATION)
Write-Output 'Built-in Windows extraction passed.'
`,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        VIBE_PATH_CHECK_ARCHIVE: archive,
        VIBE_PATH_CHECK_DESTINATION: destination,
      },
    },
  );
  const portable = path.join(destination, "Vibe-Logisim-win32-x64"),
    reports = path.join(cache, "checks");
  await mkdir(reports, { recursive: true });
  const options = {
    binary: path.join(portable, "vibe-logisim.exe"),
    resources: path.join(portable, "resources/workbench"),
    state: path.join(temporary, "state"),
    report: path.join(reports, "portable-paths-first.json"),
    portable: true,
  };
  const previous = await checkDesktop(options);
  await checkDesktop({
    ...options,
    previous,
    report: path.join(reports, "portable-paths-restart.json"),
  });
  console.log(
    "Portable long-path extraction, bundled runtimes and restart recovery passed.",
  );
} catch (error) {
  failure = error;
  throw error;
} finally {
  const resolved = await realpath(temporary),
    base = await realpath(cache);
  if (
    !resolved.startsWith(base + path.sep) ||
    !path.basename(resolved).startsWith("extract-check-")
  )
    throw new Error("Refusing cleanup outside generated extraction check");
  await cleanupDesktop(resolved, failure);
}
