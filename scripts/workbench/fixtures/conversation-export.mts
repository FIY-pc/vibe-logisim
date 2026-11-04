/** Purely synthetic histories. CLI creates a NEW state directory, never edits live state.
 * node scripts/workbench/fixtures/conversation-export.mts <new-state-directory> <workspace-directory>
 * Open the workspace with a host using VIBE_WORKBENCH_STATE=<new-state-directory>.
 */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ConversationIndex,
  ConversationRecord,
} from "../../../packages/agent-runtime/src/conversations/types.mts";

const usage = {
  input: 100,
  output: 30,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 130,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export const fixtureId = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
export const fullOutput =
  "完整工具结果\n" + "0123456789abcdef\n".repeat(1600) + "FULL_TOOL_RESULT_END";
export function conversationExportFixture(
  workspaceKey: string,
): ConversationIndex {
  const records: Record<string, ConversationRecord> = {};
  for (let i = 0; i < 24; i++) {
    const record: ConversationRecord = {
      id: fixtureId(i),
      title:
        i === 0
          ? "长记录：600 回合"
          : i <= 2
            ? "重复标题 / 会话"
            : `示例会话 ${i}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      archived: i === 2,
      customTitle: true,
      selection: {
        serviceId: "fixture",
        baseUrl: "https://fixture.invalid/not-exported",
        api: "openai-completions",
        model: "fixture/model",
        effort: "medium",
        contextWindow: 64000,
        vision: true,
      },
      messages: [],
      transcript: [],
      checkpoints: {},
      compactions: [],
    };
    for (let turn = 0; turn < (i === 0 ? 600 : 1); turn++) {
      const id = `${i}-${turn}`,
        callId = `tool-${id}`;
      const text = `Question ${id}\r\n保留空格  和换行。\n\n\`\`\`text\n原文代码块\n\`\`\``;
      const thought = `Available reasoning summary ${id}`;
      const failed = i === 1;
      const output = turn === 0 ? fullOutput : `Tool result ${id}`;
      const args = {
        path: "example.txt",
        input: "argument ".repeat(turn === 0 ? 1600 : 1),
        marker: `ARGUMENT_END_${id}`,
      };
      record.messages.push(
        { id: `q-${id}`, type: "user", text },
        {
          id: `turn-${id}`,
          type: "turn",
          status: failed ? "failed" : "completed",
          error: failed ? "Synthetic tool failure" : null,
        },
        { id: `thought-${id}`, type: "reasoning", text: thought },
        {
          id: callId,
          itemId: callId,
          type: "activity",
          status: failed ? "failed" : "completed",
          activityKey: "tool:read_file",
          label: "读取文件",
          detail: "界面预览，不是完整结果",
        },
        { id: `answer-${id}`, type: "assistant", text: `Answer ${id}` },
      );
      record.transcript!.push(
        { role: "user", content: text, timestamp: turn },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: thought },
            {
              type: "toolCall",
              id: callId,
              name: "read_file",
              arguments: args,
            },
          ],
          api: "openai-completions",
          provider: "fixture",
          model: "fixture/model",
          stopReason: "toolUse",
          usage,
          timestamp: turn,
        } as any,
        {
          role: "toolResult",
          toolCallId: callId,
          toolName: "read_file",
          content: [{ type: "text", text: output }],
          details: failed
            ? { code: "SYNTHETIC_FAILURE", message: "Synthetic tool failure" }
            : { complete: true },
          isError: failed,
          timestamp: turn,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: `Answer ${id}` }],
          api: "openai-completions",
          provider: "fixture",
          model: "fixture/model",
          stopReason: "stop",
          usage,
          timestamp: turn,
        } as any,
      );
    }
    records[record.id] = record;
  }
  const excluded = {
    ...records[fixtureId(3)],
    id: "other-workspace",
    title: "OTHER_WORKSPACE_NOT_SELECTED",
    messages: [
      { id: "private", type: "user", text: "OTHER_WORKSPACE_NOT_SELECTED" },
    ],
  };
  return {
    schema: "vibe-logisim.conversations/v2",
    workspaces: {
      [workspaceKey]: { activeId: fixtureId(0), conversations: records },
      "other-workspace": {
        activeId: excluded.id,
        conversations: { [excluded.id]: excluded },
      },
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const [directory, folder] = process.argv.slice(2);
  if (!directory || !folder)
    throw new Error(
      "Usage: conversation-export.mts <new-state-directory> <workspace-directory>",
    );
  const canonical = await realpath(folder);
  const workspaceKey =
    "folder:" + createHash("sha256").update(canonical).digest("hex");
  await mkdir(directory); // EEXIST protects all existing application state.
  await writeFile(
    path.join(directory, "conversations.json"),
    JSON.stringify(conversationExportFixture(workspaceKey)),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Created 24 synthetic conversations (600-turn history, duplicate titles, archived and failed-tool records). Open ${canonical} with VIBE_WORKBENCH_STATE=${path.resolve(directory)}.`,
  );
}
