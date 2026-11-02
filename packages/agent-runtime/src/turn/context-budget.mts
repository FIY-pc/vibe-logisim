/** A durable context projection over the intact transcript, using Pi's compactor. */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  findCutPoint,
  generateSummaryWithUsage,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

export interface CompactionCheckpoint {
  /** Exclusive index in the original transcript. Its messages remain on disk. */
  through: number;
  summary: string;
  timestamp: number;
}
export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  source: "usage" | "estimate";
  compactAt: number;
  status: "ready" | "compacting";
  compactions: number;
}
export const compactAt = (window: number) =>
  Math.floor(window - Math.min(window * 0.25, Math.max(16_384, window * 0.15)));

const visible = (m: AgentMessage) =>
  !(
    m.role === "assistant" &&
    (m.stopReason === "error" || m.stopReason === "aborted")
  );

export class ConversationContext {
  checkpoints: CompactionCheckpoint[];
  compacting = false;
  constructor(checkpoints: CompactionCheckpoint[] = []) {
    this.checkpoints = checkpoints;
  }
  rewind(length: number) {
    this.checkpoints = this.checkpoints.filter((c) => c.through <= length);
  }
  project(messages: AgentMessage[]): AgentMessage[] {
    const checkpoint = this.checkpoints.findLast(
      (c) => c.through <= messages.length,
    );
    if (!checkpoint) return messages.filter(visible);
    return [
      ...messages.filter((m) => m.role === "system"),
      {
        role: "user" as const,
        content: `<context-checkpoint>\nThe earlier conversation was summarized below. Continue the current task using this checkpoint and the recent messages.\n${checkpoint.summary}\n</context-checkpoint>`,
        timestamp: checkpoint.timestamp,
      },
      ...messages
        .slice(checkpoint.through)
        .filter((m) => m.role !== "system" && visible(m)),
    ];
  }
  usage(messages: AgentMessage[], window: number): ContextUsage {
    const estimate = estimateContextTokens(this.project(messages) as Message[]);
    return {
      tokens: estimate.tokens,
      contextWindow: window,
      source: estimate.lastUsageIndex === null ? "estimate" : "usage",
      compactAt: compactAt(window),
      status: this.compacting ? "compacting" : "ready",
      compactions: this.checkpoints.length,
    };
  }
  async prepare(
    messages: AgentMessage[],
    model: Model<any>,
    stream: StreamFn,
    signal: AbortSignal | undefined,
    changed: () => void,
    force = false,
  ): Promise<boolean> {
    const before = this.usage(messages, model.contextWindow);
    if (!force && before.tokens < before.compactAt) return false;
    const previous = this.checkpoints.at(-1);
    const start = previous?.through ?? (messages[0]?.role === "system" ? 1 : 0);
    // A new user message must reach the working model verbatim. Completed tool
    // batches can be summarized even within one long user turn.
    const end =
      messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length;
    if (end <= start) return false;
    const entries = messages.map((message, i) => ({
      type: "message" as const,
      id: String(i),
      parentId: i ? String(i - 1) : null,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    }));
    const cut = findCutPoint(
      entries,
      start,
      end,
      Math.min(20_000, model.contextWindow * 0.2),
    );
    // If a single tool batch fills the window, summarize that completed batch.
    const through =
      cut.firstKeptEntryIndex > start ? cut.firstKeptEntryIndex : end;
    const history = messages
      .slice(start, through)
      .filter((m) => m.role !== "system" && visible(m));
    if (!history.length) return false;
    this.compacting = true;
    changed();
    try {
      signal?.throwIfAborted();
      // Normally one request. Oversized tool output is summarized in text chunks
      // so even a single large result cannot overflow the summarizer's window.
      const text = serializeConversation(history as Message[]);
      const chunkSize = Math.max(
        1,
        Math.floor(model.contextWindow * 0.65 * 3.5),
      );
      let summary = previous?.summary;
      for (let offset = 0; offset < text.length; offset += chunkSize) {
        const result = await generateSummaryWithUsage(
          [
            {
              role: "user",
              content: text.slice(offset, offset + chunkSize),
              timestamp: Date.now(),
            },
          ],
          model,
          undefined,
          undefined,
          undefined,
          signal,
          "Preserve the user's goal and constraints, circuit names and file paths, interface and connectivity decisions, changes actually applied, verification results, unresolved errors and the exact next action. Distinguish observations from instructions. Keep this checkpoint concise; do not continue the task or call tools.",
          summary,
          "off",
          stream,
        );
        signal?.throwIfAborted();
        if (!result.text.trim())
          throw new Error("上下文压缩没有返回摘要，原始记录已保留，请重试");
        summary = result.text;
      }
      const checkpoint = { through, summary: summary!, timestamp: Date.now() };
      const candidate = new ConversationContext([
        ...this.checkpoints,
        checkpoint,
      ]);
      if (
        candidate.usage(messages, model.contextWindow).tokens >= before.tokens
      )
        throw new Error("上下文摘要没有缩短对话，原始记录已保留，请重试");
      this.checkpoints.push(checkpoint);
      return true;
    } finally {
      this.compacting = false;
      changed();
    }
  }
}
