import { memo, useEffect, useRef, useState } from "react";
import { ChevronRight, RotateCcw, Undo2 } from "lucide-react";
import { ChatMarkdown, CopyButton, type Message } from "./ConversationContent";
import {
  formatDuration,
  splitAnswer,
  summarize,
  toolName,
  toolState,
  type Segment,
} from "./turns";
import "./Turn.css";

/** The files a turn changed, as the folder history recorded them. */
export interface TurnChange {
  id: string;
  title: string;
  at: number;
  undoable: boolean;
  undone?: boolean;
  files: { path: string; kind: string }[];
}
const KINDS: Record<string, string> = {
  added: "新增",
  deleted: "删除",
  modified: "修改",
};
const STATES: Record<string, string> = {
  running: "进行中",
  failed: "失败",
  unknown: "结果未知",
};

interface Props {
  segment: Segment;
  /** The turn is running now. */
  live: boolean;
  /** The runtime's retry notice while the model service is busy. */
  notice: string | null;
  /** Another action or turn is in flight: undo and retry wait. */
  locked: boolean;
  onUndo: (change: TurnChange) => void;
  /** Sends the question again; only for a failed turn that can be resent. */
  onRetry?: () => void;
  onError: (error: unknown) => void;
  onFollowReference?: (href: string, message: Message) => void;
}

/** The AI's reply to one user message. While it runs, every step shows as it
 * happens; once it has finished, the steps fold into one summary line above
 * the answer, and the files it changed stay below with an undo. */
export function Turn({
  segment,
  live,
  notice,
  locked,
  onUndo,
  onRetry,
  onError,
  onFollowReference,
}: Props) {
  const turn = segment.turn;
  const status = live
    ? "running"
    : turn?.status === "running"
      ? "unfinished"
      : turn?.status || "completed";
  const [open, setOpen] = useState(status !== "completed");
  // A finished turn folds in the same render that ends it, without a frame
  // of the open steps in between.
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    if (!live) setOpen(status !== "completed");
  }
  // Items render through stable callbacks so a status snapshot, which
  // replaces every message object, re-renders only what changed.
  const handlers = useRef({ onError, onFollowReference });
  handlers.current = { onError, onFollowReference };
  const [stable] = useState(() => ({
    error: (error: unknown) => handlers.current.onError(error),
    follow: (href: string, message: Message) =>
      handlers.current.onFollowReference?.(href, message),
  }));
  const { process } = live
    ? { process: segment.items }
    : splitAnswer(segment.items);
  const change = turn?.change as TurnChange | undefined;
  return (
    <div className="turn" data-status={status}>
      {!live && process.length > 0 && (
        <button
          className="turn-summary"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={13} aria-hidden />
          <span>{summarize(process, turn?.elapsedMs)}</span>
        </button>
      )}
      {segment.items.map((item, index) =>
        !live && !open && index < process.length ? null : (
          <TurnItem
            key={item.id}
            item={item}
            live={live}
            answer={!live && index >= process.length}
            onError={stable.error}
            onFollowReference={onFollowReference ? stable.follow : undefined}
          />
        ),
      )}
      {live && (
        <LiveLine
          since={typeof turn?.startedAt === "number" ? turn.startedAt : null}
          notice={notice}
        />
      )}
      {status === "failed" && (
        <div className="turn-end" data-status="failed">
          <span>{turn?.error || "回答没有完成"}</span>
          {onRetry && (
            <button disabled={locked} onClick={onRetry}>
              <RotateCcw size={12} aria-hidden />
              重试
            </button>
          )}
        </div>
      )}
      {(status === "interrupted" || status === "unfinished") && (
        <div className="turn-end" data-status="interrupted">
          {turn?.error || "回答没有完成"}
        </div>
      )}
      {change && change.files.length > 0 && (
        <div className="chat-card turn-files">
          <span>
            <strong>AI 改动了 {change.files.length} 个文件</strong>
            <ul>
              {change.files.map((file) => (
                <li key={file.path}>
                  <small>{KINDS[file.kind] || file.kind}</small>
                  {file.path}
                </li>
              ))}
            </ul>
          </span>
          {change.undone ? (
            <small>已撤销</small>
          ) : (
            <button
              disabled={locked || !change.undoable}
              title={change.undoable ? undefined : "包含未保留内容的大文件"}
              onClick={() => onUndo(change)}
            >
              <Undo2 size={13} aria-hidden />
              撤销
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const sameItem = (a: Message, b: Message) =>
  a === b ||
  (a.id === b.id &&
    a.type === b.type &&
    a.text === b.text &&
    a.status === b.status &&
    a.resultStatus === b.resultStatus &&
    a.label === b.label &&
    a.detail === b.detail &&
    JSON.stringify(a.toolOutput) === JSON.stringify(b.toolOutput));

const TurnItem = memo(
  function TurnItem({
    item,
    live,
    answer,
    onError,
    onFollowReference,
  }: {
    item: Message;
    live: boolean;
    /** Part of the finished turn's answer: it can be copied. */
    answer: boolean;
    onError: (error: unknown) => void;
    onFollowReference?: (href: string, message: Message) => void;
  }) {
    if (item.type === "activity") return <ToolRow item={item} />;
    if (item.type === "reasoning")
      return <Thought text={item.text || ""} live={live} onError={onError} />;
    if (item.type !== "assistant") return null;
    return (
      <div className="message assistant">
        <ChatMarkdown
          text={item.text || ""}
          onError={onError}
          onFollowReference={
            onFollowReference
              ? (href) => onFollowReference(href, item)
              : undefined
          }
        />
        {answer && (
          <div className="message-actions">
            <CopyButton text={item.text || ""} onError={onError} />
          </div>
        )}
      </div>
    );
  },
  (a, b) =>
    a.live === b.live &&
    a.answer === b.answer &&
    a.onFollowReference === b.onFollowReference &&
    sameItem(a.item, b.item),
);

/** Opens or closes a disclosure in the click's own render, not after the
 * browser's toggle event, so its content is laid out before the conversation
 * decides whether to keep following the bottom. */
const toggle =
  (open: boolean, setOpen: (open: boolean) => void) =>
  (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setOpen(!open);
  };

/** Reasoning: open while the turn runs, a one-line disclosure afterwards. */
function Thought({
  text,
  live,
  onError,
}: {
  text: string;
  live: boolean;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(live);
  // It closes when the turn ends, as a reloaded window shows it.
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    if (!live) setOpen(false);
  }
  return (
    <details className="turn-thought" open={open}>
      <summary onClick={toggle(open, setOpen)}>思考</summary>
      {open && (
        <div className="turn-thought-text">
          <ChatMarkdown text={text} onError={onError} />
        </div>
      )}
    </details>
  );
}

/** One tool call: what it did and on what; the input and output inside. */
function ToolRow({ item }: { item: Message }) {
  const [open, setOpen] = useState(false);
  const output = item.toolOutput;
  const state = toolState(item);
  const input = output?.input ? { ...output.input } : null;
  // The target is shown in the row already.
  if (output?.type === "file" && input) delete input.path;
  const target =
    output?.target ||
    (typeof output?.input?.circuit === "string" ? output.input.circuit : "");
  return (
    <details className="turn-tool" data-state={state} open={open}>
      <summary onClick={toggle(open, setOpen)}>
        {state === "running" && <span className="spinner" aria-hidden />}
        <span className="turn-tool-label">
          {item.label || toolName(item) || "工具调用"}
        </span>
        {target && <span className="turn-tool-target">{target}</span>}
        {STATES[state] && <small>{STATES[state]}</small>}
      </summary>
      {open && (
        <div className="turn-tool-detail">
          {input &&
            output?.type !== "command" &&
            Object.keys(input).length > 0 && (
              <pre>{JSON.stringify(input, null, 2)}</pre>
            )}
          {output?.text ? (
            <pre>{output.text}</pre>
          ) : !output && item.detail ? (
            <pre>{item.detail}</pre>
          ) : null}
          {output?.exitCode != null && output.exitCode !== 0 && (
            <small>退出码 {output.exitCode}</small>
          )}
          {output?.truncated && <small>输出已截断</small>}
          {state === "unknown" && (
            <small>调用没有确认结束，请先检查工作区</small>
          )}
        </div>
      )}
    </details>
  );
}

/** The last line of a running turn: elapsed time, or the retry notice. */
function LiveLine({
  since,
  notice,
}: {
  since: number | null;
  notice: string | null;
}) {
  const [mounted] = useState(() => Date.now());
  const [now, setNow] = useState(mounted);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (notice)
    return (
      <div className="turn-live" data-notice="" role="status">
        {notice}
      </div>
    );
  const elapsed = now - (since ?? mounted);
  return (
    <div className="turn-live">
      <span className="turn-working">正在处理</span>
      {elapsed >= 1000 && <span aria-hidden> · {formatDuration(elapsed)}</span>}
    </div>
  );
}
