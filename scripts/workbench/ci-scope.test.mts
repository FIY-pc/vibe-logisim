import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopScope } from "./ci-scope.mts";

test("UI and documentation retain Linux and macOS ARM desktop checks", () => {
  const scope = desktopScope([
    "apps/workbench/src/shell/AppShell.tsx",
    "docs/development.md",
    "README.md",
  ]);
  assert.equal(scope.full, false);
  assert.deepEqual(
    scope.matrix.include.map(({ target }) => target),
    ["linux-x64", "darwin-arm64"],
  );
});

test("native, runtime, dependency, packaging and unknown changes require every desktop", () => {
  for (const file of [
    "crates/workbench-host/src/lib.rs",
    "apps/workbench/src-tauri/src/lib.rs",
    "packages/agent-runtime/src/turn/runner.mts",
    "Cargo.lock",
    "package-lock.json",
    "apps/workbench/vite.config.ts",
    "scripts/workbench/package.mts",
    ".github/workflows/native-workbench.yml",
    "config/runtime-lock.json",
    "new-platform/build.sh",
  ]) {
    const scope = desktopScope(["apps/workbench/src/shell/AppShell.tsx", file]);
    assert.equal(scope.full, true, file);
    assert.equal(scope.matrix.include.length, 4, file);
  }
});

test("a missing diff uses all platforms and a deletion or rename retains the old path", () => {
  assert.equal(desktopScope().matrix.include.length, 4);
  assert.equal(
    desktopScope([
      "apps/workbench/src-tauri/old.rs",
      "apps/workbench/src/new.ts",
    ]).full,
    true,
  );
});

test("workflow entrypoint defaults to full and only an explicit manual request selects standard", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vibe-ci-scope-"));
  try {
    for (const [name, ref, event, full] of [
      ["workflow_dispatch", "refs/heads/main", {}, true],
      [
        "workflow_dispatch",
        "refs/heads/main",
        { inputs: { full_desktop: "true" } },
        true,
      ],
      [
        "workflow_dispatch",
        "refs/heads/main",
        { inputs: { full_desktop: "false" } },
        false,
      ],
      [
        "push",
        "refs/tags/v26.11.3",
        { inputs: { full_desktop: "false" } },
        true,
      ],
      ["push", "refs/heads/main", { before: "0".repeat(40) }, true],
      ["pull_request", "refs/pull/1/merge", {}, true],
    ] as const) {
      const eventFile = path.join(directory, "event.json");
      const output = path.join(directory, "output");
      writeFileSync(eventFile, JSON.stringify(event));
      writeFileSync(output, "");
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL("./ci-scope.mts", import.meta.url))],
        {
          cwd: directory,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: name,
            GITHUB_REF: ref,
            GITHUB_EVENT_PATH: eventFile,
            GITHUB_OUTPUT: output,
          },
        },
      );
      const lines = readFileSync(output, "utf8").trim().split("\n");
      assert.equal(
        lines[0],
        `full=${full}`,
        JSON.stringify([name, ref, event]),
      );
      assert.equal(
        JSON.parse(lines[1].slice("matrix=".length)).include.length,
        full ? 4 : 2,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
