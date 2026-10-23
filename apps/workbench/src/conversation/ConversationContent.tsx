import type { ReferenceContext } from "./conversationReferences";
import type { ReferenceSummary } from "./references";
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, Check, ChevronDown, Copy } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { desktop } from "../shared/transport";
import { Checkbox } from "../shared/Checkbox";
import { keepKeys, usePortalContainer } from "../shared/layer";
import "./ConversationContent.css";
import { fullText } from "../shared/Tooltips";

export interface Message {
  id: string;
  type: string;
  text?: string;
  phase?: string;
  label?: string;
  detail?: string | null;
  status?: string;
  kind?: string;
  resultStatus?: string | null;
  activityKey?: string;
  toolOutput?: {
    type?: string;
    target?: string;
    input?: Record<string, unknown>;
    text?: string;
    exitCode?: number | null;
    truncated?: boolean;
  } | null;
  context?: ReferenceContext & { references?: ReferenceSummary[] };
  canEdit?: boolean;
}
export function mergeActivity(previous: Message, next: Message): Message {
  // A transport completion must not erase a tool's failed/unknown result.
  if (previous.resultStatus && !next.resultStatus) return previous;
  if (
    previous.status &&
    previous.status !== "running" &&
    next.status === "running"
  )
    return previous;
  return {
    ...previous,
    ...next,
    detail: next.detail ?? previous.detail,
    toolOutput: next.toolOutput ?? previous.toolOutput,
  };
}
export function CopyButton({
  text,
  label = "复制消息",
  onError,
}: {
  text: string;
  label?: string;
  onError: (error: unknown) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      aria-label={copied ? "已复制" : label}
      data-tip={copied ? "已复制" : label}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1400);
          })
          .catch(onError);
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
export function ChatMarkdown({
  text,
  onError,
  onFollowReference,
}: {
  text: string;
  onError: (error: unknown) => void;
  onFollowReference?: (href: string) => void;
}) {
  const reference = (href: string) =>
    /^(?:circuit:\/\/object\?|workspace:\/\/|\.\/)/i.test(href) ||
    /^[^:/?#\\\s]+(?:\/[^:/?#\\\s]+)*$/.test(href);
  const link = (href: string | undefined, children: React.ReactNode) => {
    if (!href) return <>{children}</>;
    if (reference(href))
      return onFollowReference ? (
        <button
          className="message-reference"
          onClick={() => onFollowReference(href)}
        >
          {children}
        </button>
      ) : (
        <>{children}</>
      );
    if (!/^https?:\/\//i.test(href)) return <>{children}</>;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (desktop()) {
            event.preventDefault();
            void openUrl(href).catch(onError);
          }
        }}
      >
        {children}
      </a>
    );
  };
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(value) =>
        reference(value) ? value : defaultUrlTransform(value)
      }
      components={{
        a: ({ href, children }) => link(href, children),
        img: ({ alt, src }) => link(src, alt || "图片"),
        pre: ({ children }) => {
          const code = Children.toArray(children).find(isValidElement);
          const props = code?.props as
            { children?: string; className?: string } | undefined;
          const value = String(props?.children ?? "").replace(/\n$/, "");
          const language = /language-(\S+)/.exec(props?.className || "")?.[1];
          return (
            <section className="chat-code">
              <div className="chat-code-actions">
                <span>{language || "代码"}</span>
                <CopyButton text={value} label="复制代码" onError={onError} />
              </div>
              <pre>{children}</pre>
            </section>
          );
        },
        table: ({ children }) => (
          <div
            className="chat-table"
            tabIndex={0}
            aria-label="回答中的表格，可横向滚动"
          >
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}
export function ActivityOutput({ message: m }: { message: Message }) {
  const output = m.toolOutput;
  const input = output?.input ? { ...output.input } : null;
  if (output?.type === "file" && input) delete input.path;
  const label =
    m.kind === "reasoning"
      ? "分析电路与问题"
      : m.kind === "command" &&
          /\b(?:python(?:3)?|node|npm|npx|java|javac|cargo|go|rg|grep|find|ls|cat|sed|awk|pwd|git)\b|[\\/]/i.test(
            m.label || "",
          )
        ? "执行本地操作"
        : m.label || "工具调用";
  const status =
    m.resultStatus === "unknown"
      ? "结果未知"
      : m.resultStatus === "failed"
        ? "不匹配"
        : m.status === "running"
          ? "进行中"
          : m.status === "warning"
            ? "待确认"
            : m.status === "failed"
              ? "调用失败"
              : "完成";
  return (
    <details
      className="activity"
      data-status={m.status}
      data-result-status={m.resultStatus || undefined}
    >
      <summary>
        <span>{label}</span>
        <small>{status}</small>
      </summary>
      {output ? (
        <div className="tool-output">
          {output.target && <code>{output.target}</code>}
          {input &&
            output.type !== "command" &&
            Object.keys(input).length > 0 && (
              <pre>{JSON.stringify(input, null, 2)}</pre>
            )}
          {output.text && <pre>{output.text}</pre>}
          {output.exitCode != null && output.exitCode !== 0 && (
            <small>退出码 {output.exitCode}</small>
          )}
          {output.truncated && <small>输出已截断</small>}
        </div>
      ) : m.detail ? (
        <pre>{m.detail}</pre>
      ) : null}
    </details>
  );
}
export function ActivityBatch({ messages }: { messages: Message[] }) {
  const unknown = messages.filter(
    (message) =>
      message.resultStatus === "unknown" || message.status === "warning",
  );
  const failed = messages.filter(
    (message) =>
      message.resultStatus === "failed" || message.status === "failed",
  );
  const running = messages.filter((message) => message.status === "running");
  const focus = unknown.at(-1) || running.at(-1) || failed.at(-1);
  const labels = [
    ...new Set(messages.map((message) => message.label).filter(Boolean)),
  ];
  const label =
    focus?.label ||
    labels.slice(0, 2).join("、") + (labels.length > 2 ? "…" : "") ||
    "工具调用";
  const meta = [
    running.length ? "进行中" : "",
    unknown.length ? `${unknown.length} 项待确认` : "",
    failed.length ? `${failed.length} 项异常` : "",
    !running.length && !unknown.length && !failed.length && messages.length > 1
      ? `${messages.length} 项`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <details
      className="activity-batch"
      data-status={
        unknown.length
          ? "warning"
          : failed.length
            ? "failed"
            : running.length
              ? "running"
              : "completed"
      }
    >
      <summary>
        <span>{label}</span>
        <small>{meta}</small>
      </summary>
      <div>
        {messages.map((message) => (
          <ActivityOutput key={message.id} message={message} />
        ))}
      </div>
    </details>
  );
}
export interface ConversationSummary {
  id: string;
  title: string;
  archived: boolean;
  preview?: string;
  updatedAt?: string | number;
}
/** The conversation switcher: a searchable list under the active title. Arrow
 * keys move through the list while typing in the search field, Enter opens
 * the highlighted conversation, Escape closes. Archived conversations are
 * listed on their own and choosing one restores it. */
export function ConversationPicker({
  conversations,
  active,
  disabled,
  onSelect,
  onRestore,
}: {
  conversations: ConversationSummary[];
  active: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [anchor, container] = usePortalContainer<HTMLButtonElement>();
  const searchInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const query = search.trim().toLocaleLowerCase();
  const shown = conversations.filter(
    (item) =>
      item.archived === archived &&
      (!query ||
        `${item.title}\n${item.preview || ""}`
          .toLocaleLowerCase()
          .includes(query)),
  );
  const at = Math.min(highlight, shown.length - 1);
  const title = conversations.find((item) => item.id === active)?.title;
  useEffect(() => {
    if (open)
      list.current
        ?.querySelector("[data-highlighted]")
        ?.scrollIntoView({ block: "nearest" });
  }, [open, at]);
  const choose = (item: ConversationSummary) => {
    if (disabled) return;
    setOpen(false);
    if (item.archived) onRestore(item.id);
    else onSelect(item.id);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        setSearch("");
        setArchived(false);
        setHighlight(
          Math.max(
            0,
            conversations
              .filter((item) => !item.archived)
              .findIndex((item) => item.id === active),
          ),
        );
      }}
    >
      <Popover.Trigger
        ref={anchor}
        className="conversation-picker"
        aria-label={title ? `会话：${title}` : "会话"}
        {...fullText(title)}
      >
        <span>{title || "新对话"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Content
          className="conversation-popover"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchInput.current?.focus();
          }}
          onKeyDown={keepKeys}
        >
          <input
            ref={searchInput}
            className="conversation-search"
            role="combobox"
            aria-label="查找会话"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={at >= 0 ? `${id}-${at}` : undefined}
            placeholder="查找会话"
            spellCheck={false}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              const step =
                event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowUp"
                    ? -1
                    : 0;
              if (step && shown.length) {
                event.preventDefault();
                setHighlight((at + step + shown.length) % shown.length);
              } else if (event.key === "Enter" && shown[at]) {
                event.preventDefault();
                choose(shown[at]);
              }
            }}
          />
          <label className="conversation-archive">
            <Checkbox
              checked={archived}
              onCheckedChange={(value) => {
                setArchived(value);
                setHighlight(0);
                searchInput.current?.focus();
              }}
            />
            已归档
          </label>
          <div
            ref={list}
            id={`${id}-list`}
            className="conversation-list"
            role="listbox"
            aria-label={archived ? "已归档的对话" : "对话"}
          >
            {shown.map((item, index) => (
              <div
                key={item.id}
                id={`${id}-${index}`}
                role="option"
                aria-selected={index === at}
                aria-disabled={disabled || undefined}
                aria-current={item.id === active ? "true" : undefined}
                data-highlighted={index === at ? "" : undefined}
                // The search field keeps focus while the pointer chooses.
                onMouseDown={(event) => event.preventDefault()}
                onPointerMove={() => index !== at && setHighlight(index)}
                onClick={() => choose(item)}
              >
                <span>
                  <span className="conversation-title">{item.title}</span>
                  {archived ? (
                    <span className="conversation-restore">恢复</span>
                  ) : (
                    item.id === active && (
                      <Check size={13} aria-label="当前对话" />
                    )
                  )}
                </span>
                {item.preview && <small>{item.preview}</small>}
              </div>
            ))}
            {!shown.length && (
              <p className="conversation-empty">
                {query
                  ? "没有匹配的会话"
                  : archived
                    ? "没有已归档的对话"
                    : "还没有对话"}
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
export function useConversationScroll(
  scroller: RefObject<HTMLDivElement | null>,
  identity: string,
  visible: boolean,
  content: unknown,
) {
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const setFollow = (value: boolean) => {
    follow.current = value;
    setFollowing(value);
  };
  const latest = () => {
    setFollow(true);
    if (scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  };
  useLayoutEffect(() => {
    follow.current = true;
    setFollowing(true);
  }, [identity]);
  useLayoutEffect(() => {
    if (visible && follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [content, identity, visible]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const resize = new ResizeObserver(() => {
      if (visible && follow.current) element.scrollTop = element.scrollHeight;
    });
    // Observe content as well as the viewport: streamed text and disclosures can grow.
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    return () => resize.disconnect();
  }, [scroller, visible]);
  return {
    following,
    latest,
    onScroll: () => {
      const node = scroller.current;
      if (node)
        setFollow(node.scrollHeight - node.clientHeight - node.scrollTop < 32);
    },
    onWheel: (event: { deltaY: number }) => {
      if (event.deltaY < 0) setFollow(false);
    },
    onKeyDown: (event: { key: string }) => {
      if (["PageUp", "Home", "ArrowUp"].includes(event.key)) setFollow(false);
    },
  };
}
export function FollowLatest({ onClick }: { onClick: () => void }) {
  return (
    <button className="follow-latest" onClick={onClick}>
      <ArrowDown size={13} />
      回到最新
    </button>
  );
}
