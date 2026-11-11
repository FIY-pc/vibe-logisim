import type { Message } from "./ConversationContent";

/** A user message and the AI's reply to it, as the conversation shows them. */
export interface Segment {
  key: string;
  user: Message | null;
  /** The runtime's turn record: status, startedAt, elapsedMs, error, change. */
  turn: Message | null;
  /** Reasoning, assistant text and tool activity, in order. */
  items: Message[];
}

/** Splits the conversation at each user message. Assistant messages without
 * text (a reply that only called tools) are dropped: they show nothing. */
export function segments(messages: Message[]): Segment[] {
  const out: Segment[] = [];
  let current: Segment | null = null;
  for (const message of messages) {
    if (message.type === "user" || !current) {
      const user = message.type === "user" ? message : null;
      current = { key: user?.id ?? "start", user, turn: null, items: [] };
      out.push(current);
      if (user) continue;
    }
    if (message.type === "turn") current.turn = message;
    else if (message.type === "activity" || message.text)
      current.items.push(message);
  }
  return out;
}

/** How a tool call ended, as its row shows it. */
export function toolState(activity: Message) {
  if (activity.status === "running") return "running";
  if (activity.status === "failed" || activity.resultStatus === "failed")
    return "failed";
  if (activity.status === "warning" || activity.resultStatus === "unknown")
    return "unknown";
  return "done";
}

/** The runtime owns completion. A trailing paragraph alone does not prove that
 * an interrupted turn produced an answer. Old completed histories without a
 * phase can still use their trailing text. */
export function presentTurn(segment: Segment, live: boolean) {
  const status = live
    ? "running"
    : segment.turn?.status === "running"
      ? "unfinished"
      : segment.turn?.status || "completed";
  let last = -1;
  segment.items.forEach((item, index) => {
    if (
      item.type !== "assistant" ||
      item.phase === "commentary" ||
      item.phase === "incomplete" ||
      (!live && (status !== "completed" || item.phase === "pending"))
    )
      last = index;
  });
  const process = segment.items.slice(0, last + 1);
  const answer = segment.items.slice(last + 1);
  const tools = process.filter((item) => item.type === "activity");
  const active = [...tools]
    .reverse()
    .find((item) => toolState(item) === "running");
  const failed = tools.filter((item) => toolState(item) === "failed").length;
  const unknown = tools.filter((item) => toolState(item) === "unknown").length;
  const label = live
    ? active?.label || (answer.length ? "正在回答" : "正在处理")
    : failed || unknown
      ? [
          failed ? `${failed} 项失败` : "",
          unknown ? `${unknown} 项结果未知` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : status !== "completed"
        ? "执行过程"
        : tools.length
          ? `完成了 ${tools.length} 个步骤`
          : "查看过程";
  return { status, process, answer, label };
}

export const toolName = (activity: Message) =>
  activity.activityKey?.startsWith("tool:")
    ? activity.activityKey.slice(5)
    : "";

export function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
