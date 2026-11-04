/** Close a workspace during a real sidecar turn, using only a local scripted model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startScriptedModel, scriptedProfile } from "./scripted-model.mts";

const root = path.resolve(import.meta.dirname, "../..");
const directory = await mkdtemp(path.join(tmpdir(), "vibe-close-"));
const project = path.join(directory, "project");
const state = path.join(directory, "state");
const edited = Promise.withResolvers<void>();
const model = await startScriptedModel(({ calls }) => {
  if (!calls.length)
    return {
      tool: {
        name: "write_file",
        args: { path: "note.txt", content: "saved by turn" },
      },
    };
  assert.equal(calls[0].error, null);
  edited.resolve();
  return { text: "Done", delayMs: 5000 };
});
await mkdir(project);
await mkdir(path.join(state, "profile"), { recursive: true });
await writeFile(
  path.join(state, "profile/builtin-provider.json"),
  JSON.stringify(scriptedProfile(model.url)),
);
const child = spawn(path.join(root, "target/debug/vibe-workbench-host"), [], {
  cwd: root,
  env: {
    ...process.env,
    VIBE_LOGISIM_NO_UPDATE_CHECK: "1",
    VIBE_WORKBENCH_STATE: state,
    VIBE_WORKBENCH_RESOURCES: root,
    VIBE_LOGISIM_AGENT_ROOT: root,
    VIBE_WORKBENCH_PORT: "0",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let logs = "",
  url = "";
child.stderr.on("data", (chunk) => {
  logs += chunk;
  url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || "";
});
async function command(request: Record<string, unknown>): Promise<any> {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const agent = (method: string, args: unknown = {}) =>
  command({ op: "agent", method, args });
try {
  for (let i = 0; i < 200 && !url; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(url, logs);
  const folder = await command({ op: "folderOpen", path: project });
  await agent("bind");
  const original = (await agent("history")).conversationId;
  const started = await agent("ask", {
    question: "Write a note.",
    references: [],
  });
  await edited.promise;
  assert.equal((await agent("status")).busy, true);
  await command({
    op: "folderClose",
    folder_id: folder.id,
    documents: {},
    discard: false,
  });
  const closed = await command({ op: "status" });
  assert.equal(closed.folder, null);
  assert.deepEqual(closed.documents, []);
  const detached = await agent("history");
  assert.equal(detached.busy, false);
  assert.equal(detached.workspaceKey, null);
  assert.equal(detached.conversationId, null);
  assert.deepEqual(detached.messages, []);
  await assert.rejects(
    agent("ask", { question: "Must not start.", references: [] }),
    /打开工作文件夹/,
  );
  assert.equal(
    await readFile(path.join(project, "note.txt"), "utf8"),
    "saved by turn",
  );
  // Reopening retains the interrupted turn and its undoable file checkpoint.
  await command({ op: "folderOpen", path: project });
  await agent("bind");
  const restored = await agent("history");
  assert.equal(restored.conversationId, original);
  const turn = restored.messages.find(
    (message: any) => message.type === "turn" && message.id === started.turnId,
  );
  assert(turn);
  assert.equal(turn.status, "interrupted", turn.error);
  assert(
    turn.change?.id,
    "closing must finish the file checkpoint before detaching",
  );
  await command({
    op: "folderHistoryUndo",
    folder_id: folder.id,
    id: turn.change.id,
  });
  await assert.rejects(readFile(path.join(project, "note.txt")), {
    code: "ENOENT",
  });
  console.log(
    "Workspace close stops the turn, retains its undo checkpoint, clears binding and restores history on reopen.",
  );
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) await once(child, "exit");
  await model.close();
  await rm(directory, { recursive: true, force: true });
}
