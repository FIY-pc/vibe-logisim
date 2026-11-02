import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import { mock } from "node:test";
import type { Worker } from "node:worker_threads";
import { fileTools } from "../../packages/agent-runtime/src/tools/files.mts";
import { circuitTools } from "../../packages/agent-runtime/src/tools/index.mts";
import { arrangeInWorker } from "../../packages/agent-runtime/src/tools/layout.mts";

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

// Exercise the real arranger worker through the tool entry point, with no
// model or native host. A stopped arrangement must never reach an edit.
const fixtures = new URL(
  "../../packages/arranger/test/fixtures/",
  import.meta.url,
);
const request = {
  xml: await readFile(new URL("adder.circ", fixtures), "utf8"),
  circuit: "main",
  focus: JSON.parse(
    await readFile(new URL("adder-main.focus.json", fixtures), "utf8"),
  ),
};
const workers: Worker[] = [];
const track = (worker: Worker) => workers.push(worker);
process.on("worker", track);
try {
  const preCancelled = AbortSignal.abort(new Error("cancelled before start"));
  await assert.rejects(
    arrangeInWorker(request, preCancelled),
    /cancelled before start/,
  );
  assert.equal(workers.length, 0);

  // Advancing the parent clock past the former deadline must not stop work.
  // Workers have their own clocks, so the actual layout still runs normally.
  const completed = new AbortController();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const running = arrangeInWorker(request, completed.signal);
    mock.timers.tick(60_001);
    const outcome = await running;
    assert.equal(outcome.placement.length, 10);
    assert.notEqual(outcome.xml, request.xml);
  } finally {
    mock.timers.reset();
  }
  assert.equal(workers.at(-1)!.threadId, -1);
  assert.equal(getEventListeners(completed.signal, "abort").length, 0);
  completed.abort();

  const document = { id: "demo", revision: "r0", path: "demo.circ" };
  let writes = 0,
    previews = 0;
  const context: any = {
    assertCurrent() {},
    target: async () => ({ document, circuit: "main" }),
    observe: async () => ({ raw: { focus: request.focus } }),
    host: {
      call: async ({ op }: any) => {
        if (op === "source") return { xml: request.xml };
        previews++;
        return { focus: request.focus };
      },
    },
    edit: async () => {
      writes++;
      throw new Error("unexpected edit");
    },
    identity: () => ({}),
  };
  const arrange = circuitTools({ context, vision: false }).find(
    (tool) => tool.name === "arrange_circuit",
  )!;
  const cancellation = new Error("arrangement cancelled");
  const active = new AbortController();
  let stoppedAt = 0;
  const stopWorker = (worker: Worker) =>
    worker.once("online", () => {
      stoppedAt = performance.now();
      active.abort(cancellation);
    });
  process.once("worker", stopWorker);
  let stopped;
  try {
    stopped = await arrange.execute("cancel-worker", {}, active.signal);
  } finally {
    process.off("worker", stopWorker);
  }
  assert.equal((stopped as any).isError, true);
  assert.match(JSON.stringify(stopped.content), /arrangement cancelled/);
  assert.ok(stoppedAt > 0 && performance.now() - stoppedAt < 2000);
  assert.equal(workers.at(-1)!.threadId, -1, "the worker has actually exited");
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
  assert.equal(previews, 0);
  assert.equal(writes, 0);

  const checking = new AbortController();
  context.host.call = async ({ op }: any) => {
    if (op === "source") return { xml: request.xml };
    checking.abort(cancellation);
    return { focus: request.focus };
  };
  const afterPreview = await arrange.execute(
    "cancel-preview",
    {},
    checking.signal,
  );
  assert.match(JSON.stringify(afterPreview.content), /arrangement cancelled/);
  assert.equal(writes, 0);

  // Failure and synchronous postMessage errors must clean up just like stop.
  for (const invalid of [{}, { uncloneable: () => {} }]) {
    const controller = new AbortController();
    await assert.rejects(arrangeInWorker(invalid, controller.signal));
    assert.equal(workers.at(-1)!.threadId, -1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  console.log(
    "Verified arrangement completion past the former deadline, prompt worker cancellation, no edits after stop, and worker/listener cleanup.",
  );
} finally {
  process.off("worker", track);
  await Promise.all(
    workers
      .filter((worker) => worker.threadId !== -1)
      .map((worker) => worker.terminate()),
  );
}
