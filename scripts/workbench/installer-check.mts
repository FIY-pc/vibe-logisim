import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { c } from "tar";
import { extractRuntime } from "../../packages/agent-runtime/src/installer.mts";
const { RuntimeInstaller } = createRequire(import.meta.url)(
  "../../packages/agent-runtime/core/runtime-installer.cjs",
);
const root = await mkdtemp(path.join(tmpdir(), "vibe-install-check-"));
try {
  const input = path.join(root, "input"),
    directory = path.join(root, "managed/codex");
  await mkdir(path.join(input, "bin"), { recursive: true });
  for (const name of ["codex", "codex-code-mode-host"]) {
    await writeFile(path.join(input, "bin", name), "fixture executable");
    await chmod(path.join(input, "bin", name), 0o755);
  }
  const archive = path.join(root, "runtime.tgz");
  await c({ cwd: input, gzip: true, file: archive }, ["bin"]);
  const data = await readFile(archive);
  const spec = {
    url: "https://fixture.invalid/runtime",
    sha256: createHash("sha256").update(data).digest("hex"),
    version: "fixture",
    programs: ["bin/codex", "bin/codex-code-mode-host"],
  };
  let attempts = 0;
  const installer = new RuntimeInstaller({
    spec,
    directory,
    extract: extractRuntime,
    fetch: async () => {
      attempts++;
      return new Response(attempts === 1 ? "corrupt download" : data);
    },
  });
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "existing"),
    "preserve until replacement",
  );
  await assert.rejects(installer.ensure(), /校验失败/);
  assert.equal(
    await readFile(path.join(directory, "existing"), "utf8"),
    "preserve until replacement",
  );
  assert.equal(installer.snapshot().phase, "error");
  const [first, second] = await Promise.all([
    installer.ensure(),
    installer.ensure(),
  ]);
  assert.equal(first, second);
  assert.equal(attempts, 2);
  assert(installer.ready());
  await installer.ensure();
  assert.equal(attempts, 2, "Ready installation must not download again");
  const missing = new RuntimeInstaller({
    spec: { ...spec, programs: ["bin/missing"] },
    directory: path.join(root, "managed/incomplete"),
    extract: extractRuntime,
    fetch: async () => new Response(data),
  });
  await assert.rejects(missing.ensure());
  assert.equal(missing.ready(), false);
  const cancel = new RuntimeInstaller({
    spec,
    directory: path.join(root, "managed/cancelled"),
    extract: extractRuntime,
    fetch: async (_url: string, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      }),
  });
  const attempt = cancel.ensure();
  const rejected = assert.rejects(attempt, /已取消下载/);
  await cancel.cancel();
  await rejected;
  assert.equal(cancel.snapshot().phase, "cancelled");
  assert.equal(
    (await readdir(path.join(root, "managed"))).filter((n) =>
      n.includes(".install-"),
    ).length,
    0,
  );
  const target = path.join(root, "extract");
  await mkdir(target);
  if (process.platform !== "win32") {
    await symlink("/etc/passwd", path.join(input, "link"));
    await c({ cwd: input, gzip: true, file: archive }, ["link"]);
    await assert.rejects(
      extractRuntime(archive, target, new AbortController().signal),
      /无效路径或链接/,
    );
  }
  console.log(
    "Verified installer checksum failure, retry, concurrent requests, cancellation, missing programs, staging cleanup and link rejection without downloading Codex.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
