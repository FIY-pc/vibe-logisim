/** Long turns through the actual runner and Pi transport, using only a local model fixture. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TurnRunner } from "../../packages/agent-runtime/src/turn/runner.mts";
import { ServiceStore } from "../../packages/agent-runtime/src/models/services.mts";
import { ConversationContext } from "../../packages/agent-runtime/src/turn/context-budget.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { closeNetwork } from "../../packages/agent-runtime/src/network/fetch.mts";

const directory = await mkdtemp(path.join(tmpdir(), "vibe-compaction-"));
const evidence =
  "Circuit evidence: preserve A/B/Sum/Cout and verify all vectors.\n".repeat(
    650,
  );
await writeFile(path.join(directory, "evidence.txt"), evidence);
let steps = 0,
  summaries = 0;
let failSummary = false,
  holdSummary = false,
  rejectContext = false;
const seen: any[] = [];
const model = await startScriptedModel(({ request }) => {
  seen.push(request);
  assert.notEqual(request.max_tokens ?? request.max_completion_tokens, 8192);
  if (
    JSON.stringify(request.messages[0]).includes(
      "context summarization assistant",
    )
  ) {
    summaries++;
    assert.equal(request.tools, undefined, "summary cannot execute tools");
    assert.match(JSON.stringify(request.messages), /preserve|checkpoint/i);
    return {
      text: failSummary
        ? ""
        : "Goal: Preserve the circuit interface A/B/Sum/Cout. Work in evidence.txt. Evidence read and all vectors must be verified. Continue the pending inspection, then report results.",
      delayMs: holdSummary ? 2000 : 0,
    };
  }
  if (rejectContext) {
    rejectContext = false;
    return { error: "maximum context length exceeded" };
  }
  steps++;
  if (steps <= 12)
    return { tool: { name: "read_file", args: { path: "evidence.txt" } } };
  return { text: "Inspection completed; interface preserved." };
});
const options = {
  profileDir: path.join(directory, "profile"),
  conversationsFile: path.join(directory, "conversations.json"),
  instructions:
    "Preserve the circuit interface and inspect the evidence before reporting.",
  host: {
    call: async (request: any): Promise<any> => {
      if (request.op === "status")
        return {
          folder: { id: "fixture", path: directory, name: "Fixture" },
          documents: [],
        };
      if (request.op === "folderCheckpoint") return { change: null };
      throw new Error(`Unexpected host operation ${request.op}`);
    },
  },
};
new ServiceStore(options.profileDir).save({
  name: "Local fixture",
  baseUrl: model.url,
  apiKey: "fixture-only",
  model: "fixture/tool-model",
  api: "openai-completions",
  contextWindow: 64000,
  effort: "none",
  vision: false,
});
let runner = new TurnRunner(options);
const ask = async (extra: any = {}) => {
  const ended = new Promise<any>((resolve) => {
    const handler = (e: any) => {
      if (e.type === "turn-completed") {
        runner.off("event", handler);
        resolve(e);
      }
    };
    runner.on("event", handler);
  });
  await runner.ask({
    question: "Inspect the large circuit and preserve its interface.",
    references: [],
    selection: [],
    ...extra,
  });
  return ended;
};
try {
  await runner.resume("fixture");
  const statuses: any[] = [];
  runner.on("event", (e) => {
    if (e.type === "status") statuses.push(e.contextUsage);
  });
  const result = await ask();
  assert.equal(result.status, "completed", result.error);
  assert.equal(
    steps,
    13,
    "tools continue through compaction within the same user turn",
  );
  assert.ok(summaries >= 2, "a long turn updates an earlier summary");
  assert.ok(statuses.some((s) => s?.status === "compacting"));
  assert.ok(statuses.at(-1).compactions >= 2);
  assert.equal(
    runner.transcript.filter((m) => m.role === "toolResult").length,
    12,
    "complete tool output is retained",
  );
  assert.ok(
    runner.transcript
      .filter((m) => m.role === "toolResult")
      .every((m: any) => m.content[0].text.includes(evidence)),
  );
  const projected = seen.filter(
    (r) =>
      r.tools && JSON.stringify(r.messages).includes("<context-checkpoint>"),
  );
  assert.ok(projected.length > 0);
  const last = projected.at(-1).messages;
  for (const m of last.filter((m: any) => m.role === "tool"))
    assert.ok(
      last.some((a: any) =>
        a.tool_calls?.some((t: any) => t.id === m.tool_call_id),
      ),
      "tool results keep their matching calls",
    );
  // Tokenizer disagreement is recovered through a forced summary in the same turn.
  rejectContext = true;
  const overflow = await ask({ question: "Continue checking." });
  assert.equal(overflow.status, "completed", overflow.error);
  assert.equal(rejectContext, false);
  const originalUser = runner.history.find((m) => m.type === "user")!;
  const count = runner.snapshot().contextUsage!.compactions;
  await runner.stop();
  runner = new TurnRunner(options);
  await runner.resume("fixture");
  assert.equal(runner.snapshot().contextUsage!.compactions, count);
  const beforeContinue = summaries;
  assert.equal(
    (await ask({ question: "Report the preserved interface." })).status,
    "completed",
  );
  assert.equal(
    summaries,
    beforeContinue,
    "ordinary follow-up reuses a stable summary prefix",
  );
  const priorCheckpoint = seen
    .at(-2)
    .messages.find(
      (m: any) =>
        typeof m.content === "string" &&
        m.content.includes("<context-checkpoint>"),
    );
  const nextCheckpoint = seen
    .at(-1)
    .messages.find(
      (m: any) =>
        typeof m.content === "string" &&
        m.content.includes("<context-checkpoint>"),
    );
  assert.deepEqual(
    nextCheckpoint,
    priorCheckpoint,
    "cached prefix is unchanged until next compaction",
  );
  holdSummary = true;
  rejectContext = true;
  const compacting = new Promise<void>((resolve) => {
    const onStatus = (e: any) => {
      if (e.contextUsage?.status === "compacting") {
        runner.off("event", onStatus);
        resolve();
      }
    };
    runner.on("event", onStatus);
  });
  const interrupted = ask({ question: "Continue once more." });
  await compacting;
  await runner.interrupt();
  assert.equal((await interrupted).status, "interrupted");
  assert.equal(runner.snapshot().contextUsage!.compactions, count);
  holdSummary = false;
  assert.equal(
    (
      await ask({
        editMessageId: originalUser.id,
        question: "Use a different circuit instead.",
      })
    ).status,
    "completed",
  );
  assert.equal(
    runner.snapshot().contextUsage!.compactions,
    0,
    "editing before a checkpoint drops summaries of superseded work",
  );
  assert.equal(
    runner.transcript.filter((m) => m.role === "toolResult").length,
    0,
  );

  // Failure and cancellation do not persist partial summaries or lose the raw log.
  const saved = JSON.parse(await readFile(options.conversationsFile, "utf8"));
  assert.ok(saved.workspaces.fixture);
  const full = [
    { role: "user", content: evidence.repeat(4), timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Evidence recorded" }],
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
      stopReason: "stop",
    },
  ] as any;
  const context = new ConversationContext();
  const config = runner.services.resolve(runner.selection)!;
  const { modelFor, transport } =
    await import("../../packages/agent-runtime/src/models/services.mts");
  const api = await transport(config.api);
  const stream = (m: any, c: any, o: any) =>
    api.streamSimple(m, c, { ...o, apiKey: "fixture-only", maxRetries: 0 });
  failSummary = true;
  await assert.rejects(
    context.prepare(full, modelFor(config), stream, undefined, () => {}, true),
    /没有返回摘要/,
  );
  assert.equal(context.checkpoints.length, 0);
  assert.equal(context.compacting, false);
  failSummary = false;
  holdSummary = true;
  const controller = new AbortController();
  const pending = context.prepare(
    full,
    modelFor(config),
    stream,
    controller.signal,
    () => {},
    true,
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending);
  assert.equal(context.checkpoints.length, 0);
  assert.equal(context.compacting, false);
  console.log(
    `Verified long-turn continuation through ${count} compactions, stable prefixes, intact tool history, restart, rewind, failed summary and cancellation; no real model calls.`,
  );
} finally {
  await runner.stop();
  await model.close();
  await closeNetwork();
  await rm(directory, { recursive: true, force: true });
}
