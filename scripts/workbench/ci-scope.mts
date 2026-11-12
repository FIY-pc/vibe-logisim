/** Unknown paths deliberately select the full desktop matrix. */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export function desktopScope(files?: string[]) {
  const full =
    files === undefined ||
    files.some(
      (file) =>
        !file.startsWith("apps/workbench/src/") &&
        !file.startsWith("docs/") &&
        file !== "README.md",
    );
  return {
    full,
    matrix: {
      include: [
        { os: "ubuntu-24.04", target: "linux-x64" },
        { os: "macos-15", target: "darwin-arm64" },
        ...(full
          ? [
              { os: "windows-2025", target: "win32-x64" },
              { os: "macos-15-intel", target: "darwin-x64" },
            ]
          : []),
      ],
    },
  };
}

if (import.meta.main) {
  const event = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"),
  );
  const name = process.env.GITHUB_EVENT_NAME;
  let files: string[] | undefined;
  if (name === "workflow_dispatch") {
    // Full by default; the explicit standard mode also lets us benchmark it.
    if (String(event.inputs?.full_desktop) === "false") files = [];
  } else if (!process.env.GITHUB_REF?.startsWith("refs/tags/")) {
    const base =
      name === "pull_request"
        ? event.pull_request?.base?.sha
        : name === "push"
          ? event.before
          : undefined;
    if (
      typeof base === "string" &&
      /^[a-f0-9]{40}$/.test(base) &&
      !/^0+$/.test(base)
    ) {
      execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base], {
        stdio: "inherit",
      });
      // Include both sides of renames so a native file moved into a UI path
      // cannot accidentally downgrade validation. HEAD is GitHub's merge commit.
      files = execFileSync(
        "git",
        ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"],
        { encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean);
    }
  }
  const { full, matrix } = desktopScope(files);
  appendFileSync(
    process.env.GITHUB_OUTPUT!,
    `full=${full}\nmatrix=${JSON.stringify(matrix)}\n`,
  );
  console.log(
    JSON.stringify(
      { full, changedFiles: files ?? "full validation requested", matrix },
      null,
      2,
    ),
  );
}
