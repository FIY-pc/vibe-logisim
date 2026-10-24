/**
 * Keeps a conversation inside the model's context window the way agent
 * products do: old tool output goes first. An observation of a circuit is
 * stale after the next edit anyway and the model can look again, while the
 * user's and the model's own words stay. Clearing starts when the
 * conversation passes HIGH of the budget and goes down to LOW in one go, so
 * the prefix a provider caches changes rarely.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Characters per token the budget assumes (JSON and Chinese text run 2–4). */
export const CHARS_PER_TOKEN = 3;
/** An image in the estimate, in characters (about 1000 tokens), whatever its encoded size. */
const IMAGE_COST = 3000;
const HIGH = 0.6;
const LOW = 0.4;
/** The newest tool results are never cleared: the model is working with them. */
const KEEP = 4;
export const CLEARED =
  "（较早的工具输出已从对话中省略以节省上下文；电路可能已经改变，需要时请重新调用工具查看。）";

function partSize(part: any): number {
  switch (part?.type) {
    case "image":
      return IMAGE_COST;
    case "text":
      return part.text?.length ?? 0;
    case "thinking":
      return part.thinking?.length ?? 0;
    case "toolCall":
      return JSON.stringify(part.arguments ?? {}).length + 50;
    default:
      return JSON.stringify(part ?? "").length;
  }
}

/** A message's size in the estimate, in characters. */
export function messageSize(message: AgentMessage): number {
  const content = (message as any).content;
  if (typeof content === "string") return content.length + 20;
  if (Array.isArray(content))
    return content.reduce((n: number, part: any) => n + partSize(part), 20);
  return JSON.stringify(message).length;
}

export function contextSize(messages: AgentMessage[]): number {
  return messages.reduce((n, m) => n + messageSize(m), 0);
}

const cleared = (message: any) =>
  message.content?.length === 1 && message.content[0].text === CLEARED;

/**
 * `messages` with the oldest tool output replaced by a note once they pass
 * HIGH of `budget` characters; the same array when nothing needed clearing.
 */
export function clearOldToolOutput(
  messages: AgentMessage[],
  budget: number,
): AgentMessage[] {
  let size = contextSize(messages);
  if (size <= budget * HIGH) return messages;
  const results = messages.flatMap((m: any, i) =>
    m.role === "toolResult" && !cleared(m) ? [i] : [],
  );
  const next = messages.slice();
  for (const i of results.slice(0, Math.max(0, results.length - KEEP))) {
    if (size <= budget * LOW) break;
    const old = next[i] as any;
    const replaced = { ...old, content: [{ type: "text", text: CLEARED }] };
    size += messageSize(replaced) - messageSize(old);
    next[i] = replaced;
  }
  return next;
}
