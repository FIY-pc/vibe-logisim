/** A real host + sidecar + native circuit; only the model is scripted. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startScriptedModel, scriptedProfile } from "./scripted-model.mts";
import { ToolContext } from "../../packages/agent-runtime/src/tools/context.mts";
import { fileTools } from "../../packages/agent-runtime/src/tools/files.mts";
import { ConversationStore } from "../../packages/agent-runtime/src/conversations/store.mts";

const root = path.resolve(import.meta.dirname, "../..");
const directory = await mkdtemp(path.join(tmpdir(), "vibe-standalone-"));
const state = path.join(directory, "state");
let modelFailure: unknown;
const model = await startScriptedModel(({ question, calls, request }) => {
  try {
    const tools = request.tools.map((t: any) => t.function.name);
    assert(tools.includes("place_component"));
    for (const name of [
      "write_file",
      "exec_command",
      "create_circuit",
      "open_circuit",
      "list_files",
    ])
      assert(!tools.includes(name), name + " should require a project");
    assert(request.messages[0].content.includes("standalone circuit"));
    if (!calls.length)
      return {
        tool: {
          name: "place_component",
          args: {
            components: [
              {
                factory: "Pin",
                location: { x: question === "second" ? 200 : 100, y: 100 },
                attributes: { label: question },
              },
            ],
          },
        },
      };
    assert.equal(calls[0].error, null, JSON.stringify(calls[0].error));
    return { text: "已在当前电路添加输入引脚。" };
  } catch (error) {
    modelFailure = error;
    return { text: "Fixture assertion failed" };
  }
});
await mkdir(path.join(state, "profile"), { recursive: true });
await writeFile(
  path.join(state, "profile/builtin-provider.json"),
  JSON.stringify(scriptedProfile(model.url)),
);
let child: ChildProcess,
  url = "",
  logs = "";
async function start() {
  url = "";
  logs = "";
  child = spawn(
    path.join(
      root,
      "target/debug",
      "vibe-workbench-host" + (process.platform === "win32" ? ".exe" : ""),
    ),
    [],
    {
      cwd: root,
      env: {
        ...process.env,
        VIBE_LOGISIM_NO_UPDATE_CHECK: "1",
        VIBE_WORKBENCH_STATE: state,
        VIBE_WORKBENCH_RESOURCES: process.env.VIBE_WORKBENCH_RESOURCES || root,
        VIBE_LOGISIM_AGENT_ROOT: root,
        VIBE_LOGISIM_NODE: process.execPath,
        VIBE_WORKBENCH_PORT: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr!.on("data", (chunk) => {
    logs += chunk;
    url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || "";
  });
  for (let i = 0; i < 200 && !url; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(url, logs);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}
async function command(request: any): Promise<any> {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (body.error)
    throw Object.assign(new Error(body.error.message), body.error);
  return body.result;
}
const agent = (method: string, args: any = {}) =>
  command({ op: "agent", method, args });
async function ask(
  documentId: string,
  question: string,
  references: string[] = [],
) {
  const started = await agent("ask", {
    documentId,
    circuit: "main",
    question,
    references,
  });
  for (let i = 0; i < 300; i++) {
    const history = await agent("history");
    const turn = history.messages.find(
      (m: any) => m.id === started.turnId && m.type === "turn",
    );
    if (turn && turn.status !== "running") {
      assert.equal(turn.status, "completed", turn.error);
      if (modelFailure) throw modelFailure;
      return history;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Standalone AI turn timed out: " + logs);
}
try {
  const aliases = new ConversationStore(path.join(directory, "aliases.json"));
  const draftScope = aliases.documentKey({ id: "draft", path: null });
  const aliasPath = path.join(directory, "saved.circ");
  assert.equal(
    aliases.documentKey({ id: "draft", path: aliasPath }),
    draftScope,
  );
  assert.equal(
    new ConversationStore(aliases.file).documentKey({
      id: "reopened",
      path: aliasPath,
    }),
    draftScope,
  );
  await start();
  let doc = await command({ op: "new", name: "单独电路.circ" });
  await agent("bind", { documentId: doc.id });
  const original = await agent("history");
  assert(original.workspaceKey.startsWith("document:"));
  const refs = await agent("stageReferences", {
    documentId: doc.id,
    references: [
      {
        kind: "material",
        path: "notes.txt",
        label: "设计要求",
        text: "添加一个输入引脚。",
      },
    ],
  });
  await ask(doc.id, "first", [refs[0].id]);
  doc = await command({ op: "read", id: doc.id });
  assert.equal(doc.path, null);
  assert.equal(doc.dirty, true);
  assert.equal(doc.circuits[0].components.length, 1);
  assert.equal((await command({ op: "status" })).folder, null);
  const file = path.join(directory, "单独电路.circ");
  doc = await command({
    op: "save",
    id: doc.id,
    revision: doc.revision,
    path: file,
  });
  await agent("bind", { documentId: doc.id });
  assert.equal((await agent("history")).workspaceKey, original.workspaceKey);
  const saved = await readFile(file, "utf8");
  await ask(doc.id, "second");
  doc = await command({ op: "read", id: doc.id });
  assert.equal(doc.circuits[0].components.length, 2);
  assert.equal(doc.dirty, true);
  assert.equal(
    await readFile(file, "utf8"),
    saved,
    "standalone edits wait for user save",
  );
  await command({ op: "undo", id: doc.id, revision: doc.revision });
  doc = await command({ op: "read", id: doc.id });
  assert.equal(doc.circuits[0].components.length, 1);
  const second = await command({ op: "new", name: "另一电路.circ" });
  await agent("bind", { documentId: second.id });
  const separate = await agent("history");
  assert.notEqual(separate.workspaceKey, original.workspaceKey);
  assert.equal(separate.messages.length, 0);
  await assert.rejects(agent("readReferences", { ids: [refs[0].id] }));
  await assert.rejects(
    agent("ask", { documentId: doc.id, question: "stale", references: [] }),
    /电路已切换/,
  );
  await agent("bind", { documentId: doc.id });
  assert.equal(
    (await agent("readReferences", { ids: [refs[0].id] }))[0].text,
    "添加一个输入引脚。",
  );
  await command({
    op: "close",
    id: doc.id,
    revision: doc.revision,
    discard: true,
  });
  // Never fall through to another open document when the bound one is closed.
  const context = new ToolContext({
    host: { call: command },
    folder: null,
    userDocumentId: doc.id,
    userCircuit: "main",
    emit: () => {},
    assertCurrent: () => {},
  });
  await assert.rejects(context.resolveDocument());
  const reopened = await command({ op: "open", path: file });
  await agent("bind", { documentId: reopened.id });
  assert.equal(
    (await agent("history")).conversationId,
    original.conversationId,
  );
  await stop();
  await start();
  const restored =
    (await command({ op: "status" })).documents.find(
      (d: any) => d.path === file,
    ) || (await command({ op: "open", path: file }));
  await agent("bind", { documentId: restored.id });
  const history = await agent("history");
  assert.equal(history.conversationId, original.conversationId);
  assert.equal(
    history.messages.filter((m: any) => m.type === "user").length,
    2,
  );
  const read = fileTools({
    root: null,
    vision: false,
    assertCurrent: () => {},
  });
  assert.deepEqual(
    read.map((tool) => tool.name),
    ["read_file"],
  );
  const result = await read[0].execute("read", { path: "index.md" });
  assert(!JSON.stringify(result).includes('"error"'));
  await assert.rejects(read[0].execute("read", { path: file }), /路径不在/);
  console.log(
    "PASS: unsaved and standalone AI editing, references, deferred save, undo, isolated scopes, Save As/reopen/restart history and closed-document guard.",
  );
} finally {
  await stop();
  await model.close();
  await rm(directory, { recursive: true, force: true });
}
