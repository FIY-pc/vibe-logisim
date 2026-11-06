import type { ConversationRecord } from "./types.mts";
import type { ToolOutputStore } from "../tools/output-store.mts";
import { outputArtifacts } from "./export.mts";

/** Scoped access to either a spill file or the original model-visible text. */
export async function readToolOutput(
  record: ConversationRecord,
  store: ToolOutputStore,
  request: {
    id?: string;
    toolCallId?: string;
    offset?: number;
    limit?: number;
  },
) {
  const { id, toolCallId, offset = 0, limit = 64 * 1024 } = request;
  if (id) {
    if (!outputArtifacts(record).some((artifact) => artifact.id === id))
      throw new Error("此会话没有引用该工具输出");
    try {
      return await store.read(id, offset, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("完整工具输出文件已丢失或被移除");
      throw error;
    }
  }
  const message = record.transcript?.findLast(
    (item) => item.role === "toolResult" && item.toolCallId === toolCallId,
  );
  if (!toolCallId || message?.role !== "toolResult")
    throw new Error("此会话的工具输出尚不可用");
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 4 ||
    limit > 256 * 1024
  )
    throw new Error("工具输出读取范围无效");
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const buffer = Buffer.from(text);
  if (offset > buffer.length || (buffer[offset] & 0xc0) === 0x80)
    throw new Error("工具输出读取位置无效");
  let end = Math.min(offset + limit, buffer.length);
  while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return {
    text: buffer.subarray(offset, end).toString("utf8"),
    ...(end < buffer.length ? { nextOffset: end } : {}),
    bytes: buffer.length,
  };
}
