import type { ReferenceContext } from "../lib/conversationReferences";
import type { ReferenceSummary } from "../lib/references";
import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, Check, Copy } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { desktop } from "../lib/transport";
import "./ConversationContent.css";

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
  canFork?: boolean;
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
      title={copied ? "已复制" : label}
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
    /^(?:circuit:\/\/object\?|(?:material|workspace):\/\/file\?|(?:file:\/\/)?\/tmp\/workspace\/|\.\/)/i.test(
      href,
    ) || /^[^:/?#\\\s]+(?:\/[^:/?#\\\s]+)*$/.test(href);
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
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const query = search.trim().toLocaleLowerCase();
  const shown = conversations.filter(
    (item) =>
      item.archived === archived &&
      (!query ||
        `${item.title}\n${item.preview || ""}`
          .toLocaleLowerCase()
          .includes(query)),
  );
  return (
    <details
      className="conversation-picker menu"
      ref={menu}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          menu.current!.open = false;
          menu.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary
        aria-label="会话"
        title={conversations.find((item) => item.id === active)?.title}
      >
        {conversations.find((item) => item.id === active)?.title || "会话"}
      </summary>
      <div className="menu-content">
        <input
          type="search"
          aria-label="查找会话"
          placeholder="查找会话"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="conversation-archive">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          已归档
        </label>
        <div className="conversation-list">
          {shown.map((item) => (
            <button
              key={item.id}
              disabled={disabled}
              aria-current={item.id === active ? "true" : undefined}
              onClick={() => {
                if (archived) onRestore(item.id);
                else onSelect(item.id);
                if (menu.current) menu.current.open = false;
              }}
            >
              <span>
                {archived ? "恢复 · " : ""}
                {item.title}
              </span>
              {item.preview && <small>{item.preview}</small>}
            </button>
          ))}
          {!shown.length && <span className="quiet-empty">没有匹配的会话</span>}
        </div>
      </div>
    </details>
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
