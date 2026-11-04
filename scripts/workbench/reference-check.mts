import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ServiceStore } from "../../packages/agent-runtime/src/models/services.mts";
import { startScriptedModel } from "./scripted-model.mts";
import {
  storeReference,
  readReferences,
} from "../../packages/agent-runtime/src/conversations/references.mts";
const state = await mkdtemp(path.join(tmpdir(), "vibe-reference-"));
try {
  const observation = {
    id: "record",
    title: "before edge",
    revision: "revision-1",
    rootCircuit: "main",
    circuit: "child",
    instancePath: ["instance-1"],
    signals: [{ key: "q:0", label: "Q", bits: "0011" }],
    frame: {
      circuit: "child",
      instancePath: ["instance-1"],
      clock: { enabled: false, frequency: 4 },
      children: [],
    },
  };
  const render = "data:image/png;base64,iVBORw0KGgo=";
  // One kept frame: the detail carries the state, the image op its picture.
  const host = async (request: any) =>
    request.op === "observationGet"
      ? observation
      : request.op === "observationImage"
        ? render
        : [observation];
  const ref = await storeReference(
    state,
    "folder",
    "document",
    { kind: "observation", documentId: "document", recordId: "record" },
    host,
  );
  observation.title = "renamed";
  observation.signals[0].bits = "1100";
  const [frozen] = await readReferences(state, "folder", [ref.id]);
  assert.equal(frozen.label, "before edge");
  assert(frozen.text.includes("0011"));
  assert(frozen.text.includes("instance-1"));
  assert(frozen.text.includes('"frequency":4'));
  assert.equal(frozen.image, render);
  await assert.rejects(readReferences(state, "other-folder", [ref.id]));
  await assert.rejects(readReferences(state, "folder", ["../../escape"]));
  await assert.rejects(
    storeReference(
      state,
      "folder",
      "other-document",
      { kind: "observation", documentId: "document", recordId: "record" },
      host,
    ),
    /另一/,
  );
  await assert.rejects(
    storeReference(
      state,
      "folder",
      "document",
      {
        kind: "material",
        label: "image",
        path: "x",
        image: "https://example.invalid/image",
      },
      host,
    ),
    /图片/,
  );
  const excerpt = await storeReference(
    state,
    "folder",
    "document",
    {
      kind: "material",
      label: "notes",
      path: "notes.txt",
      text: "a".repeat(24001),
      folderId: "folder",
      pathVersion: 7,
    },
    host,
  );
  assert.equal(excerpt.truncated, true);
  assert.equal(excerpt.folderId, "folder");
  assert.equal(excerpt.pathVersion, 7);
  assert.equal(
    (await readReferences(state, "folder", [excerpt.id]))[0].text.length,
    24000,
  );
  const imageInput = {
    kind: "material" as const,
    label: "image.png",
    path: "image.png",
    image: "data:image/png;base64," + "A".repeat(12_000_000),
  };
  await assert.rejects(
    storeReference(state, "folder", "document", imageInput, host),
    /图片无法引用/,
  );
  imageInput.image = "data:image/png;base64," + "A".repeat(8_000_000);
  const images = [];
  for (let i = 0; i < 3; i++)
    images.push(
      await storeReference(state, "folder", "document", imageInput, host),
    );
  await assert.rejects(
    readReferences(
      state,
      "folder",
      images.map((item) => item.id),
    ),
    /引用图片合计过大/,
  );
  await verifyWorkerReferences(path.join(state, "worker"));
  console.log(
    "References retain immutable evidence, workspace scope, image size budgets and text truncation.",
  );
} finally {
  await rm(state, { recursive: true, force: true });
}

/** Exercise the real JSONL worker and SDK against a local scripted endpoint. */
async function verifyWorkerReferences(directory: string) {
  const model = await startScriptedModel(() => ({
    text: "References received.",
  }));
  new ServiceStore(path.join(directory, "profile")).save({
    name: "Local fixture",
    baseUrl: model.url,
    apiKey: "fixture-only",
    model: "fixture/tool-model",
    api: "openai-completions",
    contextWindow: 64000,
    effort: "none",
    vision: true,
  });
  const worker = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../packages/agent-runtime/src/worker.mts", import.meta.url),
      ),
      directory,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const ready = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<any>();
  const pending = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<any>>
  >();
  let sequence = 0,
    stderr = "";
  worker.stderr.on("data", (data) => {
    stderr += data;
  });
  const send = (message: unknown) =>
    worker.stdin.write(JSON.stringify(message) + "\n");
  const call = (method: string, args: unknown = {}) => {
    const id = String(++sequence),
      response = Promise.withResolvers<any>();
    pending.set(id, response);
    send({ id, method, args });
    return response.promise;
  };
  const lines = createInterface({ input: worker.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.kind === "ready") ready.resolve();
    if (message.kind === "result") {
      const response = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) response.reject(new Error(message.error));
      else response.resolve(message.result);
    }
    if (message.kind === "event" && message.event.type === "turn-completed")
      ended.resolve(message.event);
    if (message.kind === "host") {
      const op = message.request.op;
      send({
        kind: "hostResult",
        id: message.id,
        ...(op === "status"
          ? {
              result: {
                folder: { id: "fixture", path: directory, name: "Fixture" },
                documents: [],
              },
            }
          : op === "folderCheckpoint"
            ? { result: { change: null } }
            : {
                error: { message: `Unexpected fixture host operation: ${op}` },
              }),
      });
    }
  });
  // Fail promptly if the sidecar exits instead of leaving a request pending.
  worker.on("exit", (code) => {
    const error = new Error(`Reference worker exited (${code}): ${stderr}`);
    ready.reject(error);
    for (const response of pending.values()) response.reject(error);
    ended.reject(error);
  });
  void ended.promise.catch(() => {});
  try {
    await ready.promise;
    await call("bind", { documentId: "document" });
    const inputs = Array.from({ length: 12 }, (_, i) => ({
      kind: "material",
      path: "notes.pdf",
      label: "notes.pdf",
      page: i + 1,
      text: `Reference evidence ${i + 1}`,
      image:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=",
    }));
    const staged = await call("stageReferences", {
      documentId: "document",
      references: inputs,
    });
    assert.equal(staged.length, 12);
    const ids = staged.map((item: any) => item.id);
    const resolved = await call("readReferences", { ids });
    assert.deepEqual(
      resolved.map((item: any) => item.text),
      inputs.map((item) => item.text),
    );
    await call("ask", {
      question: "Review these references.",
      documentId: "document",
      references: ids,
    });
    const result = await ended.promise;
    assert.equal(result.status, "completed", result.error);
    assert.equal(model.requests.length, 1);
    const content = model.requests[0].messages.findLast(
      (message: any) => message.role === "user",
    ).content;
    assert.equal(
      content.filter((part: any) => part.type === "image_url").length,
      12,
    );
    const text = content.find((part: any) => part.type === "text").text;
    const context = JSON.parse(
      text.split("<workspace_context>\n")[1].split("\n</workspace_context>")[0],
    );
    assert.deepEqual(
      context.references.map((item: any) => item.id),
      ids,
    );
    assert.deepEqual(
      context.references.map((item: any) => item.text),
      inputs.map((item) => item.text),
    );
    const history = await call("history");
    assert.equal(
      history.messages.find((message: any) => message.type === "user").context
        .references.length,
      12,
    );
    console.log(
      "PASS: 12 references stage, resolve and reach the SDK request and saved turn through the real sidecar (local fixture only)",
    );
  } finally {
    const exited = once(worker, "exit");
    worker.stdin.end();
    if (worker.exitCode === null) await exited;
    lines.close();
    await model.close();
  }
}
