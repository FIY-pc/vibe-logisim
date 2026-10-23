/**
 * The built-in runtime's instructions per platform and read_file paging,
 * which is the only way to read a large file where no shell exists.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { systemInstructions } from "../../packages/agent-runtime/src/turn/instructions.mts";
import {
  readText,
  referenceRoot,
} from "../../packages/agent-runtime/src/tools/files.mts";

const linux = systemInstructions(null, "linux");
const windows = systemInstructions(null, "win32");
for (const text of [linux, windows]) {
  assert.ok(text.includes(referenceRoot), "the reference directory is named");
  assert.ok(!text.includes("{{REFERENCE_PATH}}"));
  assert.ok(!text.includes("Tool result transport"), "no Code Mode wrapper");
}
assert.match(linux, /Shell cwd is \/tmp\/workspace/);
assert.match(windows, /No shell is available/);
assert.doesNotMatch(windows, /Shell cwd/);
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
    "b\nc\n[lines 2-3 of 5; 10 bytes total. Continue with offset=4.]",
  );
  assert.equal(
    await readText(small, { offset: 4 }),
    "d\ne\n[lines 4-5 of 5; 10 bytes total.]",
  );
  await assert.rejects(
    readText(small, { offset: 6 }),
    /offset 6 超出文件行数 5/,
  );
  assert.equal(await readText(await file("empty.txt", ""), { limit: 5 }), "");

  // 2000 lines of 400 bytes with newlines: one call holds 1280 of them.
  const line = "x".repeat(399);
  const large = await file(
    "large.txt",
    Array.from({ length: 2000 }, () => line).join("\n"),
  );
  const first = await readText(large, {});
  assert.match(
    first,
    /\[lines 1-1280 of 2000; 799999 bytes total\. Continue with offset=1281\.\]$/,
  );
  assert.ok(Buffer.byteLength(first) < 512000 + 200);
  assert.match(
    await readText(large, { offset: 1281 }),
    /\[lines 1281-2000 of 2000; 799999 bytes total\.\]$/,
  );
  const wide = await file("wide.txt", "short\n" + "y".repeat(600000) + "\n");
  await assert.rejects(
    readText(wide, { offset: 2 }),
    /第 2 行超过单次读取上限 512000 字节/,
  );
  assert.equal(
    await readText(wide, { limit: 1 }),
    "short\n[lines 1-1 of 2; 600007 bytes total. Continue with offset=2.]",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Verified built-in instructions per platform and read_file paging.",
);
