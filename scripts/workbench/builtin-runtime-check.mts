/**
 * The built-in runtime's instructions per platform, read_file paging,
 * and the command environment available on each supported platform.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { systemInstructions } from "../../packages/agent-runtime/src/turn/instructions.mts";
import {
  readText,
  referenceRoot,
  resolveFile,
  SANDBOX_REFERENCE,
} from "../../packages/agent-runtime/src/tools/files.mts";

const linux = systemInstructions(null, "linux");
const windows = systemInstructions(null, "win32");
for (const text of [linux, windows]) {
  assert.ok(text.includes(referenceRoot), "the reference directory is named");
}
assert.match(linux, /Shell cwd is \/tmp\/workspace/);
assert.ok(linux.includes(SANDBOX_REFERENCE), "the sandbox path is named");
assert.match(windows, /Windows PowerShell 5\.1/);
assert.match(windows, /bundled Node\.js/);
assert.doesNotMatch(windows, /No shell is available|\/tmp\/workspace/);
// The references are readable at the sandbox path the prompt gives.
assert.ok(linux.includes("index.md"), "the prompt names the reference index");
assert.equal(
  await resolveFile("/nonexistent-folder", SANDBOX_REFERENCE + "/index.md"),
  path.join(referenceRoot, "index.md"),
);
for (const name of ["digital-design.md", "java-runtime.md"])
  assert.equal(
    await resolveFile("/nonexistent-folder", SANDBOX_REFERENCE + "/" + name),
    path.join(referenceRoot, name),
  );
await assert.rejects(
  resolveFile("/nonexistent-folder", SANDBOX_REFERENCE + "/../escape"),
);
assert.equal(
  systemInstructions("Custom instructions.", "win32"),
  "Custom instructions.",
);

const directory = await mkdtemp(path.join(tmpdir(), "vibe-builtin-read-"));
try {
  const file = (name: string, text: string) =>
    writeFile(path.join(directory, name), text).then(() =>
      path.join(directory, name),
    );
  const small = await file("small.txt", "a\nb\nc\nd\ne\n");
  assert.equal(await readText(small, {}), "a\nb\nc\nd\ne\n");
  assert.equal(
    await readText(small, { offset: 2, limit: 2 }),
    "b\nc\n\n[3 more lines in file. Use offset=4 to continue.]",
  );
  assert.equal(await readText(small, { offset: 4 }), "d\ne\n");
  await assert.rejects(
    readText(small, { offset: 7 }),
    /Offset 7 is beyond end of file/,
  );
  assert.equal(await readText(await file("empty.txt", ""), { limit: 5 }), "");

  // Pi bounds the model page to 50 KiB: 128 lines of 400 bytes.
  const line = "x".repeat(399);
  const large = await file(
    "large.txt",
    Array.from({ length: 2000 }, () => line).join("\n"),
  );
  const first = await readText(large, {});
  assert.match(
    first,
    /\[Showing lines 1-128 of 2000 \(50.0KB limit\)\. Use offset=129 to continue\.\]$/,
  );
  assert.ok(Buffer.byteLength(first) < 51200 + 200);
  assert.match(
    await readText(large, { offset: 129 }),
    /Use offset=257 to continue/,
  );
  const wide = await file("wide.txt", "short\n" + "y".repeat(600000) + "\n");
  assert.match(await readText(wide, { offset: 2 }), /Use exec_command/);
  assert.equal(
    await readText(wide, { limit: 1 }),
    "short\n\n[2 more lines in file. Use offset=2 to continue.]",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Verified built-in instructions per platform and read_file paging.",
);
