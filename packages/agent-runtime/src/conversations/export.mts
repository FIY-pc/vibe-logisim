import type { ConversationRecord } from "./types.mts";
import type { OutputArtifact } from "../tools/output-store.mts";

/** Only references in this conversation, including earlier raw tool results. */
export function outputArtifacts(
  record: Pick<ConversationRecord, "messages" | "transcript">,
): OutputArtifact[] {
  const artifacts = new Map<string, OutputArtifact>();
  const add = (items: OutputArtifact[] | undefined) => {
    for (const item of items || []) artifacts.set(item.id, item);
  };
  for (const message of record.messages)
    add(message.toolOutput?.outputArtifacts);
  for (const message of record.transcript || []) {
    if (message.role === "toolResult")
      add(
        (message.details as { outputArtifacts?: OutputArtifact[] } | undefined)
          ?.outputArtifacts,
      );
  }
  return [...artifacts.values()];
}

/** No service registry or account/profile data is part of a conversation export. */
export function exportRecord(record: ConversationRecord) {
  const selection = record.selection;
  // Rewrite file references only in the exported copy. The model transcript
  // (including its original plain-text output) remains untouched.
  const copy = structuredClone({
    messages: record.messages,
    transcript: record.transcript,
  });
  for (const message of copy.messages)
    for (const artifact of message.toolOutput?.outputArtifacts || [])
      artifact.path = `outputs/${artifact.id}`;
  for (const message of copy.transcript || []) {
    if (message.role !== "toolResult") continue;
    const details = message.details as
      { outputArtifacts?: OutputArtifact[] } | undefined;
    for (const artifact of details?.outputArtifacts || [])
      artifact.path = `outputs/${artifact.id}`;
  }
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archived: record.archived,
    customTitle: record.customTitle,
    titleGenerated: record.titleGenerated,
    messages: copy.messages,
    transcript: copy.transcript,
    outputArtifacts: outputArtifacts(copy),
    compactions: record.compactions,
    checkpoints: record.checkpoints,
    selection: selection
      ? {
          model: selection.model,
          api: selection.api,
          effort: selection.effort,
          contextWindow: selection.contextWindow,
          maxOutput: selection.maxOutput,
          vision: selection.vision,
        }
      : null,
  };
}

// A user/tool message can itself contain Markdown fences. Keep it intact.
function block(value: unknown, language = "") {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  let length = 3;
  for (const match of text.matchAll(/`+/g))
    length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}${language}\n${text}\n${fence}\n`;
}
export function conversationMarkdown(record: ReturnType<typeof exportRecord>) {
  const lines = [
    `# ${record.title.replace(/[\r\n]+/g, " ")}`,
    "此文件包含所选会话的消息、可用思考摘要和工具记录。完整结构化数据见同目录 conversation.json。",
    `会话 ID：${record.id}\n\n创建：${record.createdAt}\n\n更新：${record.updatedAt}`,
    record.selection
      ? `模型：${record.selection.model}\n\n思考深度：${record.selection.effort}`
      : "",
    "## 会话记录",
  ];
  const labels: Record<string, string> = {
    user: "用户",
    assistant: "助手",
    reasoning: "思考摘要",
    activity: "工具活动",
    turn: "回合",
  };
  for (const [index, message] of record.messages.entries()) {
    lines.push(`### ${index + 1}. ${labels[message.type] || message.type}`);
    if (message.text !== undefined) lines.push(message.text);
    if (message.label) lines.push(message.label);
    if (message.status) lines.push(`状态：${message.status}`);
    if (message.error) lines.push(block(message.error));
    if (message.type === "activity") {
      lines.push(`调用 ID：${message.itemId || message.id}`);
      if (message.detail) lines.push(block(message.detail));
    }
  }
  if (record.outputArtifacts.length) {
    lines.push("## 保存的工具输出");
    for (const artifact of record.outputArtifacts)
      lines.push(
        `- [${artifact.id}](outputs/${artifact.id})（${artifact.bytes} 字节）`,
      );
  }
  // The transcript preserves what the model saw, which can be a bounded
  // preview. Full saved output is linked above, not duplicated into Markdown.
  lines.push(
    "## 模型工具记录",
    "以下保留模型收到的工具参数、结果和错误及其顺序。长输出可能是预览；已保存的完整输出见上方文件链接。",
  );
  for (const [index, message] of (record.transcript || []).entries()) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") {
          lines.push(
            `### ${index + 1}. 调用 ${part.name}`,
            `调用 ID：${part.id}`,
            "参数：",
            block(part.arguments, "json"),
          );
        }
      }
      if (message.errorMessage)
        lines.push("助手错误：", block(message.errorMessage));
    }
    if (message.role !== "toolResult") continue;
    lines.push(
      `### ${index + 1}. ${message.isError ? "工具错误" : "工具结果"}：${message.toolName}`,
    );
    const raw = message as unknown as Record<string, unknown>;
    const { content, ...metadata } = raw;
    lines.push(block(metadata, "json"));
    if (typeof content === "string") lines.push(block(content));
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") lines.push(block(part.text));
        else if (part.type === "thinking")
          lines.push("思考摘要：", block(part.thinking));
        else lines.push(block(part, "json"));
      }
    } else if (content !== undefined) lines.push(block(content, "json"));
  }
  return lines.filter(Boolean).join("\n\n") + "\n";
}
