import type { ReferenceContext } from "./conversationReferences";
import type { ReferenceSummary } from "./references";
import type { TurnChange } from "./Turn";
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
import { desktop } from "../shared/transport";
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
  /** Turn records: when the turn started, how long it took, why it ended and
   * the files it changed. */
  startedAt?: number;
  elapsedMs?: number;
  error?: string | null;
  change?: TurnChange;
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
    // Opening a disclosure grows the content below what was clicked: keep it
    // where the reader is looking, and follow again only from the bottom.
    onClickCapture: (event: { target: EventTarget | null }) => {
      const node = scroller.current;
      if (
        !node ||
        !(event.target instanceof Element) ||
        !event.target.closest("summary, [aria-expanded]")
      )
        return;
      follow.current = false;
      requestAnimationFrame(() =>
        setFollow(node.scrollHeight - node.clientHeight - node.scrollTop < 32),
      );
    },
  };
}
export function FollowLatest({ onClick }: { onClick: () => void }) {
  return (
    <button className="follow-latest" onClick={onClick}>
      <ArrowDown size={13} />
      回到底部
    </button>
  );
}
