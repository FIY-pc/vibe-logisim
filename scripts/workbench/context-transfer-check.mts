/** Replay the app-server request boundary; no process, account, or model calls. */
import assert from "node:assert/strict";
import {
  ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexBackend } from "../../packages/agent-runtime/core/codex-backend.mts";
import { ConversationStore } from "../../packages/agent-runtime/core/conversation-store.mts";
import {
  CONTEXT_KEY,
  CONTEXT_LIMIT,
  historyContext,
  mergeTransferredHistory,
  createContextTransfer,
} from "../../packages/agent-runtime/core/context-transfer.mts";
const directory = await mkdtemp(path.join(tmpdir(), "vibe-context-transfer-"));
const workspaceKey = "synthetic-document";
const file = path.join(directory, "conversations.json");
interface ReplayItem {
  type: "userMessage" | "agentMessage";
  id: string;
  clientId?: string;
  content?: { type: "text"; text: string }[];
  phase?: string;
  text?: string;
}
interface ReplayTurn {
  id: string;
  status: string;
  items: ReplayItem[];
}
interface ReplayThread {
  id: string;
  turns: ReplayTurn[];
}
interface ReplayRequest {
  id: number;
  method: string;
  params: {
    threadId?: string;
    beforeTurnId?: string;
    lastTurnId?: string;
    clientUserMessageId?: string;
    input?: { type: string; text: string }[];
    additionalContext?: Record<string, { kind: string; value: string }>;
  };
}
const threads = new Map<string, ReplayThread>();
const calls: ReplayRequest[] = [];
const replayChildren: ChildProcessWithoutNullStreams[] = [];
let nextThread = 0,
  nextTurn = 0;
let startResponse:
  ((request: ReplayRequest) => Promise<Record<string, unknown>>) | null = null;
function threadFor(id: string | undefined) {
  assert.ok(id, "Replay request must identify its native thread");
  const thread = threads.get(id);
  assert.ok(thread, "Replay thread must exist");
  return thread;
}
function lastStart() {
  const request = calls.findLast((call) => call.method === "turn/start");
  assert.ok(request, "Replay must have reached turn/start");
  return request;
}
function replayBackend() {
  const backend = new CodexBackend({
    workDir: directory,
    profileDir: path.join(directory, "profile"),
    sessionStorePath: file,
    developerInstructions: "Synthetic current contract",
  });
  backend.status = "ready";
  backend.start = async () => backend.snapshot();
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio: [
      stdin,
      stdout,
      stderr,
      null,
      null,
    ] satisfies ChildProcessWithoutNullStreams["stdio"],
  });
  replayChildren.push(child);
  backend.child = child;
  stdin.on("data", (chunk: Buffer) => {
    const request: ReplayRequest = JSON.parse(chunk.toString());
    calls.push(request);
    void Promise.resolve()
      .then(async () => {
        const p = request.params;
        switch (request.method) {
          case "thread/start": {
            const thread: ReplayThread = {
              id: `thread-${++nextThread}`,
              turns: [],
            };
            threads.set(thread.id, thread);
            return { thread };
          }
          case "thread/resume":
          case "thread/read":
            return { thread: structuredClone(threadFor(p.threadId)) };
          case "mcpServerStatus/list":
            return { data: [] };
          case "thread/unsubscribe":
          case "turn/interrupt":
            return {};
          case "thread/revert": {
            const thread = threadFor(p.threadId);
            thread.turns = thread.turns.slice(
              0,
              thread.turns.findIndex((t) => t.id === p.beforeTurnId),
            );
            return { thread: structuredClone(thread) };
          }
          case "thread/fork": {
            const original = threadFor(p.threadId);
            const index = original.turns.findIndex(
              (t) => t.id === p.lastTurnId,
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
    function finish(error: unknown, result: Record<string, unknown> = {}) {
      const pending = backend.pending.get(String(request.id));
      if (!pending) return;
      backend.pending.delete(String(request.id));
      clearTimeout(pending.timeout);
      if (error)
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      else pending.resolve(result);
    }
  });
  return backend;
}
function acknowledge(p: ReplayRequest["params"]) {
  const id = `turn-${++nextTurn}`;
  threadFor(p.threadId).turns.push({
    id,
    status: "completed",
    items: [
      {
        type: "userMessage",
        id: `user-${id}`,
        clientId: p.clientUserMessageId,
        content: [{ type: "text", text: p.input?.[0]?.text || "" }],
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
async function ask(
  backend: CodexBackend,
  question = "Continue the synthetic discussion",
  editMessageId?: string,
) {
  const result: unknown = await backend.ask({
    workspaceKey,
    question,
    context: { revisionId: "synthetic-revision" },
    ...(editMessageId ? { editMessageId } : {}),
  });
  assert.ok(
    result &&
      typeof result === "object" &&
      "turnId" in result &&
      typeof result.turnId === "string",
    "Successful ask must return an acknowledged turn",
  );
  return { turnId: result.turnId };
}
const resume = (backend: CodexBackend) =>
  backend.resumeWorkspace({ workspaceKey, revisionId: "synthetic-revision" });
const store = new ConversationStore(file, "codex");
function savedRecord() {
  const record = store.active(workspaceKey);
  assert.ok(record, "Workspace must retain its active conversation");
  return record;
}
function savedTransfer() {
  const transfer = savedRecord().contextTransfer;
  assert.ok(transfer, "Conversation must retain its context handoff");
  return transfer;
}
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
  let captured: ReplayRequest | undefined;
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
  assert.equal(savedTransfer().pending, true, "A write is not an ACK");
  assert.equal(savedTransfer().prefix.length, history.length);
  assert.deepEqual(savedRecord().supersededThreadIds, ["previous-contract"]);
  const context = captured.params.additionalContext?.[CONTEXT_KEY];
  assert.ok(context, "Contract change must include untrusted history");
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
  assert.equal(savedTransfer().pending, true);

  startResponse = null;
  const retry = replayBackend();
  await resume(retry);
  assert.equal(retry.snapshot().contextTransfer?.pending, true);
  const acknowledged = await ask(retry);
  assert.equal(savedTransfer().pending, false);
  assert.equal(savedTransfer().acknowledgedTurnId, acknowledged.turnId);
  assert.equal(savedTransfer().prefix.length, 82);
  const restored = replayBackend();
  await resume(restored);
  assert.equal(restored.history.length, 84);
  assert.equal(restored.history.filter((m) => m.contextTransferred).length, 82);
  assert.equal(
    new Set(restored.history.map((m) => m.id)).size,
    restored.history.length,
  );
  assert.deepEqual(restored.snapshot().contextTransfer, {
    reason: "contract-change",
    pending: false,
    truncated: true,
  });
  await ask(restored, "The next native turn");
  assert.equal(lastStart().params.additionalContext?.[CONTEXT_KEY], undefined);

  const branch = replayBackend();
  await resume(branch);
  branch.status = "auth-required";
  const turnsBeforeFork = calls.filter((c) => c.method === "turn/start").length;
  await assert.rejects(
    branch.changeConversation(workspaceKey, "fork", { messageId: "old-81" }),
    /文本转交/,
  );
  await branch.changeConversation(workspaceKey, "fork", {
    messageId: `answer-${acknowledged.turnId}`,
  });
  const branchState = store.state(workspaceKey);
  assert.ok(branchState.conversation.contextTransfer);
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
    lastStart().params.additionalContext?.[CONTEXT_KEY],
    "Editing away the acknowledged turn must deliver the prefix again",
  );
  assert.equal(savedTransfer().acknowledgedTurnId, edited.turnId);

  const oversized = historyContext([
    { type: "user", id: "oversized", text: '"\n😀'.repeat(30_000) },
  ]);
  assert.ok(oversized.context.value.length <= CONTEXT_LIMIT);
  assert.equal(JSON.parse(oversized.context.value).truncated, true);
  assert.match(
    JSON.parse(oversized.context.value).messages[0].text,
    /Earlier text omitted/,
  );
  assert.equal(
    mergeTransferredHistory(
      createContextTransfer(
        [{ type: "user", id: "client-a", text: "same" }],
        "contract-change",
      ),
      [{ type: "user", id: "native-a", clientId: "client-a", text: "same" }],
    ).length,
    1,
  );
  console.log(
    "Context handoff replay: bounded untrusted text, ACK-only consumption, failed-start retry, restart prefix retention, native fork/edit and ID deduplication passed; model calls: 0",
  );
} finally {
  for (const child of replayChildren) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  await rm(directory, { recursive: true, force: true });
}
