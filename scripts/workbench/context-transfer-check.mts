/** Replay the app-server request boundary; no process, account, or model calls. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  importHistory,
  previewHistory,
} from "../../packages/agent-runtime/src/history-import.mts";
const require = createRequire(import.meta.url);
const {
  CodexBackend,
} = require("../../packages/agent-runtime/core/codex-backend.cjs");
const {
  ConversationStore,
} = require("../../packages/agent-runtime/core/conversation-store.cjs");
const {
  CONTEXT_KEY,
  CONTEXT_LIMIT,
  historyContext,
  mergeTransferredHistory,
} = require("../../packages/agent-runtime/core/context-transfer.cjs");
const directory = await mkdtemp(path.join(tmpdir(), "vibe-context-transfer-"));
const workspaceKey = "synthetic-document";
const file = path.join(directory, "conversations.json");
const threads = new Map<string, any>();
const calls: any[] = [];
let nextThread = 0,
  nextTurn = 0;
let startResponse: ((request: any) => Promise<any>) | null = null;
function replayBackend() {
  const backend = new CodexBackend({
    workDir: directory,
    profileDir: path.join(directory, "profile"),
    sessionStorePath: file,
    developerInstructions: "Synthetic current contract",
  });
  backend.status = "ready";
  backend.start = async () => backend.snapshot();
  backend.child = {
    stdin: {
      destroyed: false,
      write(line: string) {
        const request = JSON.parse(line);
        calls.push(request);
        void Promise.resolve()
          .then(async () => {
            const p = request.params;
            switch (request.method) {
              case "thread/start": {
                const thread = { id: `thread-${++nextThread}`, turns: [] };
                threads.set(thread.id, thread);
                return { thread };
              }
              case "thread/resume":
              case "thread/read":
                return { thread: structuredClone(threads.get(p.threadId)) };
              case "mcpServerStatus/list":
                return { data: [] };
              case "thread/unsubscribe":
              case "turn/interrupt":
                return {};
              case "thread/revert": {
                const thread = threads.get(p.threadId);
                thread.turns = thread.turns.slice(
                  0,
                  thread.turns.findIndex((t: any) => t.id === p.beforeTurnId),
                );
                return { thread: structuredClone(thread) };
              }
              case "thread/fork": {
                const original = threads.get(p.threadId);
                const index = original.turns.findIndex(
                  (t: any) => t.id === p.lastTurnId,
                );
                const thread = {
                  id: `thread-${++nextThread}`,
                  turns: structuredClone(original.turns.slice(0, index + 1)),
                };
                threads.set(thread.id, thread);
                return { thread };
              }
              case "turn/start":
                return startResponse
                  ? await startResponse(request)
                  : acknowledge(p);
              default:
                throw new Error(`Unexpected replay request ${request.method}`);
            }
          })
          .then(
            (result) => finish(null, result),
            (error) => finish(error),
          );
        function finish(error: any, result?: any) {
          const pending = backend.pending.get(String(request.id));
          if (!pending) return;
          backend.pending.delete(String(request.id));
          clearTimeout(pending.timeout);
          if (error) pending.reject(error);
          else pending.resolve(result);
        }
      },
    },
  };
  return backend;
}
function acknowledge(p: any) {
  const id = `turn-${++nextTurn}`;
  threads.get(p.threadId).turns.push({
    id,
    status: "completed",
    items: [
      {
        type: "userMessage",
        id: `user-${id}`,
        clientId: p.clientUserMessageId,
        content: [{ type: "text", text: p.input[0].text }],
      },
      {
        type: "agentMessage",
        id: `answer-${id}`,
        phase: "final_answer",
        text: `Synthetic answer ${id}`,
      },
    ],
  });
  return { turn: { id } };
}
const ask = (
  backend: any,
  question = "Continue the synthetic discussion",
  editMessageId?: string,
) =>
  backend.ask({
    workspaceKey,
    question,
    context: { revisionId: "synthetic-revision" },
    ...(editMessageId ? { editMessageId } : {}),
  });
const resume = (backend: any) =>
  backend.resumeWorkspace({ workspaceKey, revisionId: "synthetic-revision" });
const store = new ConversationStore(file);
try {
  const history = Array.from({ length: 82 }, (_, i) => ({
    type: i % 2 ? "assistant" : "user",
    id: `old-${i}`,
    text: `Earlier synthetic message ${i}: ` + '\\"\n电路'.repeat(150),
  }));
  store.ensure(workspaceKey);
  store.remember(workspaceKey, {
    threadId: "previous-contract",
    messages: history,
    toolContract: { signature: "old" },
  });
  const first = replayBackend();
  let rejectStart!: (error: Error) => void;
  let captured!: any;
  startResponse = (request) => {
    captured = request;
    return new Promise((_, reject) => {
      rejectStart = reject;
    });
  };
  const failed = ask(first);
  const failureCheck = assert.rejects(failed, /synthetic start failure/);
  for (let i = 0; !captured && i < 100; i++)
    await new Promise((r) => setTimeout(r, 1));
  assert.ok(captured, "The replay reached turn/start");
  assert.equal(
    store.active(workspaceKey).contextTransfer.pending,
    true,
    "A write is not an ACK",
  );
  assert.equal(
    store.active(workspaceKey).contextTransfer.prefix.length,
    history.length,
  );
  assert.deepEqual(store.active(workspaceKey).supersededThreadIds, [
    "previous-contract",
  ]);
  const context = captured.params.additionalContext[CONTEXT_KEY];
  assert.equal(context.kind, "untrusted");
  assert.ok(context.value.length <= CONTEXT_LIMIT);
  assert.equal(JSON.parse(context.value).truncated, true);
  assert.match(
    JSON.parse(context.value).description,
    /not a native thread resume/,
  );
  assert.ok(
    !calls.some(
      (c) =>
        c.method === "thread/resume" &&
        c.params.threadId === "previous-contract",
    ),
  );
  rejectStart(new Error("synthetic start failure"));
  await failureCheck;
  assert.equal(store.active(workspaceKey).contextTransfer.pending, true);

  startResponse = null;
  const retry = replayBackend();
  await resume(retry);
  assert.equal(retry.snapshot().contextTransfer.pending, true);
  const acknowledged = await ask(retry);
  assert.equal(store.active(workspaceKey).contextTransfer.pending, false);
  assert.equal(
    store.active(workspaceKey).contextTransfer.acknowledgedTurnId,
    acknowledged.turnId,
  );
  assert.equal(store.active(workspaceKey).contextTransfer.prefix.length, 82);
  const restored = replayBackend();
  await resume(restored);
  assert.equal(restored.history.length, 84);
  assert.equal(
    restored.history.filter((m: any) => m.contextTransferred).length,
    82,
  );
  assert.equal(
    new Set(restored.history.map((m: any) => m.id)).size,
    restored.history.length,
  );
  assert.deepEqual(restored.snapshot().contextTransfer, {
    reason: "contract-change",
    pending: false,
    truncated: true,
  });
  await ask(restored, "The next native turn");
  assert.equal(
    calls.filter((c) => c.method === "turn/start").at(-1).params
      .additionalContext?.[CONTEXT_KEY],
    undefined,
  );

  const branch = replayBackend();
  await resume(branch);
  branch.status = "auth-required";
  const turnsBeforeFork = calls.filter((c) => c.method === "turn/start").length;
  await assert.rejects(
    branch.changeConversation(workspaceKey, "fork", { messageId: "old-81" }),
    /文本转交/,
  );
  const branchState = await branch.changeConversation(workspaceKey, "fork", {
    messageId: `answer-${acknowledged.turnId}`,
  });
  assert.equal(branchState.conversation.messages.length, 84);
  assert.equal(branchState.conversation.contextTransfer.prefix.length, 82);
  assert.equal(branchState.conversation.contextTransfer.pending, false);
  assert.equal(
    calls.filter((c) => c.method === "turn/start").length,
    turnsBeforeFork,
    "Forking local history requests no model turn",
  );
  const reopenedBranch = replayBackend();
  await resume(reopenedBranch);
  assert.equal(reopenedBranch.history.length, 84);
  await assert.rejects(ask(reopenedBranch, "Edit prefix", "old-0"), /文本转交/);
  const edited = await ask(
    reopenedBranch,
    "Replace first native question",
    `user-${acknowledged.turnId}`,
  );
  assert.ok(
    calls.filter((c) => c.method === "turn/start").at(-1).params
      .additionalContext[CONTEXT_KEY],
    "Editing away the acknowledged turn must deliver the prefix again",
  );
  assert.equal(
    store.active(workspaceKey).contextTransfer.acknowledgedTurnId,
    edited.turnId,
  );

  const sourceFile = path.join(directory, "legacy-sessions.json");
  await writeFile(
    sourceFile,
    JSON.stringify({
      schema: "vibe-logisim.codex-sessions/v1",
      workspaces: {
        old: {
          activeId: "a",
          conversations: {
            a: {
              id: "a",
              title: "Synthetic import",
              threadId: "original-import-thread",
              messages: history,
            },
          },
        },
      },
    }),
  );
  const originalBytes = await readFile(sourceFile, "utf8");
  const preview = await previewHistory(sourceFile);
  await importHistory(
    store,
    { file: sourceFile, revision: preview.revision, sourceKey: "old" },
    workspaceKey,
  );
  const imported = store
    .state(workspaceKey)
    .conversations.find((c: any) => c.id.startsWith("import-"));
  store.change(workspaceKey, "select", { id: imported.id });
  assert.equal(store.active(workspaceKey).threadId, null);
  assert.deepEqual(store.active(workspaceKey).contextTransfer.sourceThreadIds, [
    "original-import-thread",
  ]);
  const importedBackend = replayBackend();
  await resume(importedBackend);
  assert.equal(
    importedBackend.snapshot().contextTransfer.reason,
    "history-import",
  );
  await ask(importedBackend, "Continue imported discussion");
  const transferred = calls.filter((c) => c.method === "turn/start").at(-1)
    .params.additionalContext;
  assert.deepEqual(Object.keys(transferred), [CONTEXT_KEY]);
  assert.equal(
    JSON.parse(transferred[CONTEXT_KEY].value).reason,
    "history-import",
  );
  assert.equal(store.active(workspaceKey).migration.requiresContext, false);
  const resumedImport = replayBackend();
  await resume(resumedImport);
  assert.equal(resumedImport.history.length, 84);
  assert.equal(store.active(workspaceKey).contextTransfer.prefix.length, 82);
  assert.equal(await readFile(sourceFile, "utf8"), originalBytes);

  const oversized = historyContext([
    { type: "user", text: '"\n😀'.repeat(30_000) },
  ]);
  assert.ok(oversized.context.value.length <= CONTEXT_LIMIT);
  assert.equal(JSON.parse(oversized.context.value).truncated, true);
  assert.match(
    JSON.parse(oversized.context.value).messages[0].text,
    /Earlier text omitted/,
  );
  assert.equal(
    mergeTransferredHistory(
      { prefix: [{ type: "user", id: "client-a", text: "same" }] },
      [{ type: "user", id: "native-a", clientId: "client-a", text: "same" }],
    ).length,
    1,
  );
  console.log(
    "Context handoff replay: bounded untrusted text, ACK-only consumption, failed-start retry, restart prefix retention, import, native fork/edit and ID deduplication passed; model calls: 0",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
