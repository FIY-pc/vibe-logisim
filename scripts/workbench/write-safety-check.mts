import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileTools } from "../../packages/agent-runtime/src/tools/files.mts";

const root = await mkdtemp(path.join(tmpdir(), "vibe-write-safety-"));
try {
  const file = path.join(root, "work.circ");
  await writeFile(file, "original");
  const tools = fileTools({ root, assertCurrent() {} });
  const read = tools.find((t) => t.name === "read_file")!.execute;
  const write = tools.find((t) => t.name === "write_file")!.execute;
  const call = (fn: any, args: any, signal?: AbortSignal) =>
    fn("test", args, signal);
  await assert.rejects(
    call(write, { path: "work.circ", content: "unread" }),
    /重新读取/,
  );
  await call(read, { path: "work.circ" });
  await writeFile(file, "user's concurrent edit");
  await assert.rejects(
    call(write, { path: "work.circ", content: "stale" }),
    /重新读取/,
  );
  assert.equal(await readFile(file, "utf8"), "user's concurrent edit");
  await call(read, { path: "work.circ" });
  await call(write, { path: "work.circ", content: "accepted" });
  await call(write, { path: "work.circ", content: "second accepted" });
  assert.equal(await readFile(file, "utf8"), "second accepted");
  const controller = new AbortController();
  const cancelled = fileTools({
    root,
    assertCurrent() {
      queueMicrotask(() => controller.abort());
    },
  });
  const cancelWrite = cancelled.find((t) => t.name === "write_file")!.execute;
  await assert.rejects(
    call(
      cancelWrite,
      { path: "new.circ", content: "cancelled" },
      controller.signal,
    ),
  );
  assert.deepEqual(await readdir(root), ["work.circ"]);
  await call(write, { path: "new.circ", content: "new file" });
  assert.equal(await readFile(path.join(root, "new.circ"), "utf8"), "new file");
  console.log(
    "Verified unread/stale writes, atomic replacement, repeated writes and cancellation before commit.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
