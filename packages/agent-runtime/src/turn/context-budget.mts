/** A durable context projection over the intact transcript, using Pi's compactor. */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Message, ThinkingLevel } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  findCutPoint,
  generateSummaryWithUsage,
} from "@earendil-works/pi-coding-agent";

interface CheckpointBoundary {
  /** Exclusive index in the original transcript. Its messages remain on disk. */
  through: number;
  timestamp: number;
}
export type CompactionCheckpoint = CheckpointBoundary &
  (
    | { kind?: "summary"; summary: string }
    | { kind: "openai"; scope: string; output: Record<string, unknown>[] }
  );
export interface CompactionOptions {
  thinkingLevel?: ThinkingLevel | "off";
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
  checkpoint(messages: AgentMessage[], scope?: string) {
    return this.checkpoints.findLast(
      (c) =>
        c.through <= messages.length &&
        (scope
          ? c.kind === "openai" && c.scope === scope
          : c.kind !== "openai"),
    );
  }
  acceptRemote(
    through: number,
    scope: string,
    output: Record<string, unknown>[],
  ) {
    this.checkpoints.push({
      kind: "openai",
      through,
      scope,
      output,
      timestamp: Date.now(),
    });
  }
  project(messages: AgentMessage[], scope?: string): AgentMessage[] {
    const checkpoint = this.checkpoint(messages, scope);
    if (!checkpoint) return messages.filter(visible);
    return [
      ...messages.filter((m) => m.role === "system"),
      ...(checkpoint.kind === "openai"
        ? []
        : [
            {
              role: "user" as const,
              content: `<context-checkpoint>\nThe earlier conversation was summarized below. Continue the current task using this checkpoint and the recent messages.\n${checkpoint.summary}\n</context-checkpoint>`,
              timestamp: checkpoint.timestamp,
            },
          ]),
      ...messages
        .slice(checkpoint.through)
        .filter((m) => m.role !== "system" && visible(m)),
    ];
  }
  usage(
    messages: AgentMessage[],
    window: number,
    scope?: string,
  ): ContextUsage {
    const checkpoint = this.checkpoint(messages, scope);
    const projected = this.project(messages, scope);
    // A fresh checkpoint invalidates usage measured against the old prefix.
    // Opaque ciphertext is only an estimate until the next inference reports usage.
    if (checkpoint?.kind === "openai")
      projected.unshift({
        role: "user",
        content: "",
        timestamp: checkpoint.timestamp,
      });
    const estimate = estimateContextTokens(projected as Message[]);
    const opaqueTokens =
      checkpoint?.kind === "openai" && estimate.lastUsageIndex === null
        ? Math.ceil(JSON.stringify(checkpoint.output).length / 3.5)
        : 0;
    return {
      tokens: estimate.tokens + opaqueTokens,
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
    options: CompactionOptions = {},
  ): Promise<boolean> {
    const before = this.usage(messages, model.contextWindow);
    if (!force && before.tokens < before.compactAt) return false;
    const previous = this.checkpoint(messages);
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
      // Pi owns serialization and its structured summary/update prompt. Passing
      // real messages avoids flattening the conversation twice or cutting text
      // in the middle of a tool call, an instruction or a verification result.
      const result = await generateSummaryWithUsage(
        history,
        model,
        undefined,
        undefined,
        undefined,
        signal,
        "Preserve the user's goal and constraints, circuit names and file paths, interface and connectivity decisions, changes actually applied, verification results, unresolved errors and the exact next action. Distinguish observations from instructions. Keep this checkpoint concise; do not continue the task or call tools.",
        previous?.kind !== "openai" ? previous?.summary : undefined,
        options.thinkingLevel,
        stream,
      );
      signal?.throwIfAborted();
      if (!result.text.trim())
        throw new Error("上下文压缩没有返回摘要，原始记录已保留，请重试");
      const checkpoint = {
        through,
        summary: result.text,
        timestamp: Date.now(),
      };
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
