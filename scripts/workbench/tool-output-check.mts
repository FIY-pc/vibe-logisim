import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ToolOutputStore,
  OUTPUT_MOUNT,
} from "../../packages/agent-runtime/src/tools/output-store.mts";
import {
  preserveResult,
  preserveToolOutput,
} from "../../packages/agent-runtime/src/tools/preserve-output.mts";

const root = await mkdtemp(path.join(tmpdir(), "vibe-output-check-"));
try {
  const store = new ToolOutputStore(path.join(root, "outputs"));
  const original = "BEGIN\n" + "完整输出🧪".repeat(100000) + "\nEND";
  const artifact = await store.write(original);
  assert.equal(artifact.bytes, Buffer.byteLength(original));
  assert.equal(
    await readFile((await store.resolve(artifact.path))!, "utf8"),
    original,
  );

  // Byte pagination must make progress through one huge UTF-8 line and survive
  // creating a fresh store, just as reopening a saved conversation does.
  const restored = new ToolOutputStore(store.root);
  let offset = 0;
  const pages: string[] = [];
  while (true) {
    const page = await restored.read(artifact.id, offset, 8193);
    pages.push(page.text);
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(pages.join(""), original);
  await assert.rejects(restored.read(artifact.id, 7), /字符边界/);
  await assert.rejects(restored.read(artifact.id, artifact.bytes + 1), /超出/);
  await assert.rejects(restored.describe("../outside.txt"), /编号/);
  assert.equal(await restored.resolve(path.join(root, "outside.txt")), null);

  const other = new ToolOutputStore(path.join(root, "other"));
  await other.ensure();
  // Absolute paths outside this store are not claimed. A sandbox alias is
  // resolved within this conversation, where the other output does not exist.
  assert.equal(await other.resolve(path.join(store.root, artifact.id)), null);
  await assert.rejects(other.resolve(`${OUTPUT_MOUNT}/${artifact.id}`), {
    code: "ENOENT",
  });
  await assert.rejects(other.read(artifact.id), { code: "ENOENT" });
  if (process.platform !== "win32") {
    const id = `${randomUUID()}.txt`;
    await symlink(path.join(root, "outside.txt"), path.join(store.root, id));
    await assert.rejects(store.describe(id), /文件无效/);
  }

  const source = path.join(root, "closed-pi-output.txt");
  await writeFile(source, original);
  const imported = await store.importFile(source);
  await rm(source);
  assert.equal(
    await readFile((await store.resolve(imported.path))!, "utf8"),
    original,
  );

  const large = {
    circuit: "main",
    rows: Array.from({ length: 4000 }, (_, id) => ({
      id,
      value: `完整记录 ${id}`,
    })),
  };
  const small = {
    content: [{ type: "text" as const, text: '{"ok":true}' }],
    details: null,
  };
  assert.equal(await preserveResult(small, store), small);
  const image = {
    type: "image" as const,
    data: "test-data",
    mimeType: "image/png",
  };
  const input = {
    content: [{ type: "text" as const, text: JSON.stringify(large) }, image],
    isError: true,
    details: { diagnostic: "original" },
  };
  const prior = structuredClone(input);
  let calls = 0;
  const tool = preserveToolOutput(
    {
      name: "observe",
      label: "Observe",
      description: "test",
      parameters: {} as any,
      async execute() {
        calls++;
        return input;
      },
    },
    store,
  );
  const output = await tool.execute("call", {});
  assert.equal(calls, 1, "offloading must not repeat the operation");
  assert.deepEqual(input, prior, "source and previous history stay unchanged");
  assert.equal(output.isError, true);
  assert.deepEqual(output.content[1], image);
  assert.equal(output.details.diagnostic, "original");
  const envelope = JSON.parse((output.content[0] as { text: string }).text);
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.continuation.path, envelope.fullOutput.path);
  const saved = await store.resolve(envelope.fullOutput.path);
  assert.deepEqual(JSON.parse(await readFile(saved!, "utf8")), large);
  assert.ok((await readFile(saved!, "utf8")).includes('\n  "rows": ['));
  const unavailable = new ToolOutputStore(path.join(root, "unavailable"));
  unavailable.write = async () => {
    throw new Error("ENOSPC");
  };
  const completed = { ...input, isError: false };
  const fallback = await preserveResult(completed, unavailable);
  assert.equal(
    fallback.isError,
    false,
    "storage failure must not change the operation outcome",
  );
  assert.deepEqual(fallback.content.slice(1), completed.content);
  assert.equal(fallback.details.diagnostic, "original");
  assert.equal(fallback.details.outputPersistenceError, "ENOSPC");
  assert.match((fallback.content[0] as { text: string }).text, /操作已经执行/);
  console.log(
    "Verified complete tool outputs, UTF-8 paging, restart, scope isolation, JSON recovery, image/error preservation and one execution.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
