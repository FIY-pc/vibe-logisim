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

/** After a turn ends, the text after its last step is the answer; everything
 * before it (reasoning, notes between steps, tool calls) is the process. */
export function splitAnswer(items: Message[]) {
  let last = -1;
  items.forEach((item, index) => {
    if (item.type !== "assistant") last = index;
  });
  return { process: items.slice(0, last + 1), answer: items.slice(last + 1) };
}

export const toolName = (activity: Message) =>
  activity.activityKey?.startsWith("tool:")
    ? activity.activityKey.slice(5)
    : "";

type Input = Record<string, any>;
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
/** What a finished tool call did. With a unit, the phrase counts the distinct
 * things the calls touched (`things`), or the calls themselves. */
const VERBS: Record<
  string,
  { verb: string; unit?: string; things?: (input: Input) => unknown[] }
> = {
  open_circuit: { verb: "打开了电路" },
  create_circuit: {
    verb: "新建了",
    unit: "个电路文件",
    things: (input) => [input.path],
  },
  define_circuit: { verb: "调整了电路定义" },
  inspect_circuit: { verb: "查看了电路" },
  render_circuit: { verb: "查看了图面" },
  describe_component: {
    verb: "查阅了",
    unit: "种元件",
    things: (input) => [input.tool],
  },
  place_component: {
    verb: "放置了",
    unit: "个元件",
    things: (input) =>
      list(input.components).map((c) => JSON.stringify(c?.location)),
  },
  set_attributes: {
    verb: "修改了",
    unit: "个属性",
    things: (input) =>
      list(input.edits).flatMap((edit) =>
        Object.keys(edit?.attributes || {}).map(
          (key) => edit.componentId + "\n" + key,
        ),
      ),
  },
  connect: {
    verb: "连了",
    unit: "条线",
    things: (input) => list(input.connections).map((c) => JSON.stringify(c)),
  },
  move_components: {
    verb: "移动了",
    unit: "个元件",
    things: (input) =>
      list(input.positions).length
        ? list(input.positions).map((p) => p?.componentId)
        : list(input.componentIds),
  },
  delete_objects: {
    verb: "删除了",
    unit: "个对象",
    things: (input) => [...list(input.componentIds), ...list(input.wireIds)],
  },
  arrange_circuit: { verb: "整理了布局" },
  simulate_circuit: { verb: "运行了仿真" },
  trace_circuit: { verb: "追踪了信号" },
  undo_edit: { verb: "撤销了", unit: "步编辑" },
  read_observation: { verb: "读取了观察" },
  read_file: { verb: "读了", unit: "个文件", things: (input) => [input.path] },
  write_file: { verb: "写了", unit: "个文件", things: (input) => [input.path] },
  list_files: { verb: "浏览了文件" },
  exec_command: { verb: "运行了", unit: "条命令" },
};

export function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** One line for a finished turn's process, e.g. "查看了电路、修改了 2 个属性 · 47 秒". */
export function summarize(process: Message[], elapsedMs?: number | null) {
  const phrases = new Map<
    string,
    { text: string; unit?: string; things: Set<unknown> }
  >();
  let failed = 0,
    unknown = 0;
  for (const item of process) {
    if (item.type !== "activity") continue;
    const state = toolState(item);
    if (state === "failed") failed++;
    if (state === "unknown") unknown++;
    if (state !== "done") continue;
    const name = toolName(item);
    const verb = VERBS[name] ?? { verb: item.label || name };
    if (!verb.verb) continue;
    const phrase = phrases.get(verb.verb) ?? {
      text: verb.verb,
      unit: verb.unit,
      things: new Set(),
    };
    const input = (item.toolOutput?.input || {}) as Input;
    const things = verb.things?.(input).filter((thing) => thing != null);
    for (const thing of things?.length ? things : [item.id])
      phrase.things.add(thing);
    phrases.set(verb.verb, phrase);
  }
  const verbs = [...phrases.values()].map((phrase) =>
    phrase.unit
      ? `${phrase.text} ${phrase.things.size} ${phrase.unit}`
      : phrase.text,
  );
  const parts = [
    verbs.slice(0, 3).join("、") + (verbs.length > 3 ? " 等" : ""),
    failed ? `${failed} 项失败` : "",
    unknown ? `${unknown} 项结果未知` : "",
  ].filter(Boolean);
  const duration = elapsedMs != null ? formatDuration(elapsedMs) : "";
  if (!parts.length) return duration ? `思考了 ${duration}` : "思考过程";
  return [...parts, duration].filter(Boolean).join(" · ");
}
