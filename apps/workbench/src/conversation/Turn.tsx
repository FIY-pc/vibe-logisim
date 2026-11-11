import { Button, Text } from "../design/ui";
import { memo, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronRight, Play, Settings2, Undo2 } from "lucide-react";
import { ChatMarkdown, CopyButton, type Message } from "./ConversationContent";
import {
  formatDuration,
  presentTurn,
  toolName,
  toolState,
  type Segment,
} from "./turns";
import { useTurnDisclosure } from "./TurnExpansion";
import { ToolOutputAccess } from "./ToolOutput";

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
  /** Another action or turn is in flight: undo and continue wait. */
  locked: boolean;
  onUndo: (change: TurnChange) => void;
  /** Continues from retained progress; only on the latest unfinished turn. */
  onContinue?: () => void;
  onConfigure?: () => void;
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
  onContinue,
  onConfigure,
  onError,
  onFollowReference,
}: Props) {
  const turn = segment.turn;
  const { status, process, answer, label } = presentTurn(segment, live);
  const processId = useId();
  const [open, setOpen] = useTurnDisclosure(
    JSON.stringify([segment.key, "turn"]),
    status,
    status !== "completed",
  );
  // Items render through stable callbacks so a status snapshot, which
  // replaces every message object, re-renders only what changed.
  const handlers = useRef({ onError, onFollowReference });
  handlers.current = { onError, onFollowReference };
  const [stable] = useState(() => ({
    error: (error: unknown) => handlers.current.onError(error),
    follow: (href: string, message: Message) =>
      handlers.current.onFollowReference?.(href, message),
  }));
  const change = turn?.change as TurnChange | undefined;
  return (
    <div className="turn" data-status={status}>
      {(live || process.length > 0) && (
        <div className="turn-process">
          <Button
            variant="ghost"
            color="gray"
            className="turn-summary"
            aria-expanded={open}
            aria-controls={processId}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight size={14} aria-hidden />
            <span
              className={
                live ? "turn-summary-label turn-working" : "turn-summary-label"
              }
            >
              {label}
            </span>
            <ElapsedTime
              live={live}
              since={
                typeof turn?.startedAt === "number" ? turn.startedAt : null
              }
              elapsedMs={turn?.elapsedMs}
            />
          </Button>
          <div
            id={processId}
            className="turn-process-body"
            hidden={!open || !process.length}
          >
            {open &&
              process.map((item) => (
                <TurnItem
                  key={item.id}
                  item={item}
                  disclosureKey={JSON.stringify([segment.key, item.id])}
                  live={live}
                  answer={false}
                  onError={stable.error}
                  onFollowReference={
                    onFollowReference ? stable.follow : undefined
                  }
                />
              ))}
          </div>
        </div>
      )}
      <div className="turn-answer">
        {answer.map((item) => (
          <TurnItem
            key={item.id}
            item={item}
            disclosureKey={JSON.stringify([segment.key, item.id])}
            live={live}
            answer={!live && status === "completed"}
            onError={stable.error}
            onFollowReference={onFollowReference ? stable.follow : undefined}
          />
        ))}
      </div>
      {live && notice && (
        <Text
          as="p"
          kind="meta"
          className="turn-live"
          data-notice=""
          role="status"
        >
          {notice}
        </Text>
      )}
      {["failed", "interrupted", "unfinished"].includes(status) && (
        <div
          className="turn-end"
          data-status={status === "failed" ? "failed" : "interrupted"}
        >
          <span>{turn?.error || "回答没有完成"}</span>
          {onConfigure && (
            <Button
              variant="ghost"
              color="gray"
              disabled={locked}
              onClick={onConfigure}
            >
              <Settings2 size={16} aria-hidden />
              检查 AI 设置
            </Button>
          )}
          {onContinue && (
            <Button
              variant="ghost"
              color="gray"
              disabled={locked}
              onClick={onContinue}
              data-tip={
                onConfigure
                  ? "修复服务设置后，保留已有进度继续"
                  : "保留已有内容和执行记录，继续完成任务"
              }
            >
              <Play size={16} aria-hidden />
              继续
            </Button>
          )}
        </div>
      )}
      {change && change.files.length > 0 && (
        <div className="chat-card turn-files">
          <span>
            <strong>AI 改动了 {change.files.length} 个文件</strong>
            <ul>
              {change.files.map((file) => (
                <li key={file.path}>
                  <Text kind="meta" asChild>
                    <small>{KINDS[file.kind] || file.kind}</small>
                  </Text>
                  {file.path}
                </li>
              ))}
            </ul>
          </span>
          {change.undone ? (
            <Text kind="meta" color="gray" asChild>
              <small>已撤销</small>
            </Text>
          ) : (
            <Button
              variant="ghost"
              color="gray"
              disabled={locked || !change.undoable}
              data-tip={change.undoable ? undefined : "包含未保留内容的大文件"}
              onClick={() => onUndo(change)}
            >
              <Undo2 size={16} aria-hidden />
              撤销
            </Button>
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
    a.workspaceKey === b.workspaceKey &&
    a.conversationId === b.conversationId &&
    a.itemId === b.itemId &&
    JSON.stringify(a.toolOutput) === JSON.stringify(b.toolOutput));

const TurnItem = memo(
  function TurnItem({
    item,
    disclosureKey,
    live,
    answer,
    onError,
    onFollowReference,
  }: {
    item: Message;
    disclosureKey: string;
    live: boolean;
    /** Part of the finished turn's answer: it can be copied. */
    answer: boolean;
    onError: (error: unknown) => void;
    onFollowReference?: (href: string, message: Message) => void;
  }) {
    if (item.type === "activity")
      return <ToolRow item={item} disclosureKey={disclosureKey} />;
    if (item.type === "reasoning")
      return (
        <Thought
          text={item.text || ""}
          live={live}
          onError={onError}
          disclosureKey={disclosureKey}
        />
      );
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
    a.disclosureKey === b.disclosureKey &&
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
  disclosureKey,
  text,
  live,
  onError,
}: {
  disclosureKey: string;
  text: string;
  live: boolean;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useTurnDisclosure(
    disclosureKey,
    live ? "live" : "finished",
    live,
  );
  return (
    <details className="turn-thought" open={open}>
      <Button asChild variant="ghost" color="gray">
        <summary onClick={toggle(open, setOpen)}>思考</summary>
      </Button>
      {open && (
        <div className="turn-thought-text">
          <ChatMarkdown text={text} onError={onError} />
        </div>
      )}
    </details>
  );
}

/** One tool call: what it did and on what; the input and output inside. */
function ToolRow({
  item,
  disclosureKey,
}: {
  item: Message;
  disclosureKey: string;
}) {
  const [open, setOpen] = useTurnDisclosure(disclosureKey, "tool", false);
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
      <Button asChild variant="ghost" color="gray">
        <summary onClick={toggle(open, setOpen)}>
          {state === "running" && <span className="spinner" aria-hidden />}
          {state === "done" && (
            <Check
              size={14}
              className="turn-tool-done"
              aria-label="已完成"
              role="img"
            />
          )}
          <span className="turn-tool-label">
            {item.label || toolName(item) || "工具调用"}
          </span>
          {target && <span className="turn-tool-target">{target}</span>}
          {STATES[state] && (
            <Text kind="meta" className="turn-tool-status" asChild>
              <small>{STATES[state]}</small>
            </Text>
          )}
        </summary>
      </Button>
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
            <Text kind="meta">退出码 {output.exitCode}</Text>
          )}
          {output?.truncated && <Text kind="meta">仅显示部分输出</Text>}
          <ToolOutputAccess item={item} />
          {state === "unknown" && (
            <Text kind="meta">调用没有确认结束，请先检查工作区</Text>
          )}
        </div>
      )}
    </details>
  );
}

/** Keep the ticking clock isolated from the message list. */
function ElapsedTime({
  live,
  since,
  elapsedMs,
}: {
  live: boolean;
  since: number | null;
  elapsedMs?: number;
}) {
  const [mounted] = useState(() => Date.now());
  const [now, setNow] = useState(mounted);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const elapsed = live ? now - (since ?? mounted) : elapsedMs;
  return elapsed != null && elapsed >= 1000 ? (
    <span className="turn-duration" aria-hidden={live || undefined}>
      {formatDuration(elapsed)}
    </span>
  ) : null;
}
