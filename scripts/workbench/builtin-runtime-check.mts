/**
 * The built-in runtime's instructions per platform, read_file paging,
 * which is the only way to read a large file where no shell exists, and how
 * a long conversation stays inside the model's context.
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
import {
  CLEARED,
  clearOldToolOutput,
  contextSize,
} from "../../packages/agent-runtime/src/turn/context-budget.mts";

const linux = systemInstructions(null, "linux");
const windows = systemInstructions(null, "win32");
for (const text of [linux, windows]) {
  assert.ok(text.includes(referenceRoot), "the reference directory is named");
}
assert.match(linux, /Shell cwd is \/tmp\/workspace/);
assert.ok(linux.includes(SANDBOX_REFERENCE), "the sandbox path is named");
assert.match(windows, /No shell is available/);
assert.doesNotMatch(windows, /Shell cwd/);
// The references are readable at the sandbox path the prompt gives.
assert.ok(linux.includes("index.md"), "the prompt names the reference index");
assert.equal(
  await resolveFile(
    "/nonexistent-folder",
    SANDBOX_REFERENCE + "/index.md",
  ),
  path.join(referenceRoot, "index.md"),
);
for (const name of ["digital-design.md", "java-runtime.md", "arrangement.md"])
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
// Ten turns of 60 000-character observations in a 768 000-character budget:
// past 60 % the oldest observations give way down to 40 %; every word stays.
const turns = Array.from({ length: 10 }, (_, i) => [
  { role: "user", content: `问题 ${i}`, timestamp: i },
  {
    role: "assistant",
    content: [{ type: "toolCall", id: `t${i}`, name: "inspect_circuit", arguments: {} }],
    timestamp: i,
  },
  {
    role: "toolResult",
    toolCallId: `t${i}`,
    toolName: "inspect_circuit",
    content: [{ type: "text", text: "x".repeat(60000) }],
    isError: false,
    timestamp: i,
  },
]).flat() as any[];
const budget = 768000;
const kept = clearOldToolOutput(turns, budget);
const results = kept.filter((m: any) => m.role === "toolResult");
assert.ok(contextSize(kept) <= budget * 0.4);
assert.deepEqual(
  results.map((m: any) => m.content[0].text === CLEARED),
  [true, true, true, true, true, false, false, false, false, false],
);
assert.deepEqual(
  kept.filter((m: any) => m.role !== "toolResult"),
  turns.filter((m: any) => m.role !== "toolResult"),
);
// Under the threshold nothing changes; an image counts as a picture, not as its encoding.
const pictured = turns.slice(0, 6).concat({
  role: "toolResult",
  toolCallId: "r",
  toolName: "render_circuit",
  content: [{ type: "image", data: "A".repeat(2_000_000), mimeType: "image/png" }],
  isError: false,
  timestamp: 9,
});
assert.equal(clearOldToolOutput(pictured, budget), pictured);

console.log(
  "Verified built-in instructions per platform, read_file paging and clearing old tool output.",
);
