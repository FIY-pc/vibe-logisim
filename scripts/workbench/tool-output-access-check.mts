import assert from "node:assert/strict";
import { TurnRunner } from "../../packages/agent-runtime/src/turn/runner.mts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolOutputStore } from "../../packages/agent-runtime/src/tools/output-store.mts";
import { toolActivity } from "../../packages/agent-runtime/src/turn/activity.mts";
import {
  exportRecord,
  conversationMarkdown,
} from "../../packages/agent-runtime/src/conversations/export.mts";
import { readToolOutput } from "../../packages/agent-runtime/src/conversations/tool-output.mts";
import type { ConversationRecord } from "../../packages/agent-runtime/src/conversations/types.mts";

const directory = await mkdtemp(path.join(tmpdir(), "vibe-output-access-"));
try {
  const store = new ToolOutputStore(directory);
  const text = "长输出🙂".repeat(8000);
  const artifact = await store.write(text);
  const start = toolActivity({
    type: "tool_execution_start",
    toolName: "exec_command",
    args: { command: "example" },
  });
  const result = {
    content: [{ type: "text", text: "bounded preview" }],
    details: { exitCode: 7, outputArtifacts: [artifact] },
  };
  const activity = toolActivity(
    { type: "tool_execution_end", toolName: "exec_command", result },
    start,
  );
  assert.equal(
    activity.status,
    "failed",
    "Pi plain-text result uses details.exitCode",
  );
  assert.equal(activity.toolOutput.exitCode, 7);
  assert.deepEqual(activity.toolOutput.outputArtifacts, [artifact]);
  const raw = {
    role: "toolResult",
    toolCallId: "call",
    toolName: "exec_command",
    content: [{ type: "text", text }],
    details: { outputArtifacts: [artifact] },
    isError: false,
    timestamp: 1,
  } as const;
  const record: ConversationRecord = {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Example",
    createdAt: "",
    updatedAt: "",
    archived: false,
    messages: [{ id: "activity", type: "activity", ...activity }],
    transcript: [structuredClone(raw) as any],
  };
  const original = JSON.stringify(record);
  const [visible] = TurnRunner.prototype.messages.call({
    history: record.messages,
    workspaceKey: "folder",
    conversationId: record.id,
    checkpoints: {},
  } as any);
  assert.equal(visible.workspaceKey, "folder");
  assert.equal(visible.conversationId, record.id);
  assert.equal(JSON.stringify(record), original);
  const exported = exportRecord(record);
  assert.equal(
    exported.outputArtifacts.length,
    1,
    "UI + raw references are deduplicated",
  );
  assert.equal(exported.outputArtifacts[0].path, `outputs/${artifact.id}`);
  assert(conversationMarkdown(exported).includes(`](outputs/${artifact.id})`));
  assert.equal(
    JSON.stringify(record),
    original,
    "Export never mutates raw model messages or activity",
  );
  const replayed = JSON.parse(original) as ConversationRecord;
  const reopened = new ToolOutputStore(directory);
  assert.equal(
    (
      await readToolOutput(replayed, reopened, {
        id: artifact.id,
        limit: 256 * 1024,
      })
    ).text,
    text,
  );
  let offset: number | undefined = 0;
  let reconstructed = "";
  while (offset !== undefined) {
    const page = await readToolOutput(replayed, reopened, {
      toolCallId: "call",
      offset,
      limit: 4097,
    });
    assert(Buffer.byteLength(page.text) <= 4097);
    reconstructed += page.text;
    offset = page.nextOffset;
  }
  assert.equal(
    reconstructed,
    text,
    "Transcript-only pages preserve UTF-8 boundaries",
  );
  await assert.rejects(
    readToolOutput(replayed, reopened, { toolCallId: "missing" }),
    /尚不可用/,
  );
  await assert.rejects(
    readToolOutput(replayed, reopened, { toolCallId: "call", offset: 1 }),
    /位置无效/,
  );
  await assert.rejects(
    readToolOutput(replayed, reopened, {
      toolCallId: "call",
      limit: 256 * 1024 + 1,
    }),
    /范围无效/,
  );
  const unreferenced = await store.write("not referenced");
  await assert.rejects(
    readToolOutput(replayed, reopened, { id: unreferenced.id }),
    /没有引用/,
  );
  await rm(path.join(directory, artifact.id));
  await assert.rejects(
    readToolOutput(replayed, reopened, { id: artifact.id }),
    /丢失/,
  );
  console.log(
    "PASS: activity metadata and Pi exit codes, scoped saved/inline UTF-8 pages after reload, missing files, deduplicated portable export references, immutable transcripts",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
