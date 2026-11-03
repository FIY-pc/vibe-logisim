import type { ReferenceContext } from "./conversationReferences";
import type { ReferenceSummary } from "./references";
import type { TurnChange } from "./Turn";
import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  Callout,
  Checkbox,
  Flex,
  Popover,
  Text,
} from "@radix-ui/themes";
import { Command } from "cmdk";
import { CommandSearch, preventComposingDismiss } from "../shared/command";
import "../shared/command.css";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, Check, ChevronDown, Copy } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { desktop } from "../shared/transport";
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
  onSelect: (id: string) => void | Promise<void>;
  onRestore: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [anchor, container] = usePortalContainer<HTMLButtonElement>();
  const searchInput = useRef<HTMLInputElement>(null);
  const shown = conversations.filter((item) => item.archived === archived);
  const title = conversations.find((item) => item.id === active)?.title;
  const choose = async (item: ConversationSummary) => {
    if (disabled || working) return;
    setWorking(true);
    setError("");
    try {
      await (item.archived ? onRestore(item.id) : onSelect(item.id));
      setOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (working) return;
        setOpen(next);
        if (next) {
          setSearch("");
          setArchived(false);
          setError("");
        }
      }}
    >
      <Popover.Trigger>
        <Button
          ref={anchor}
          variant="ghost"
          color="gray"
          size="2"
          className="conversation-picker"
          disabled={working}
          aria-label={title ? `会话：${title}` : "会话"}
          {...fullText(title)}
        >
          <span>{title || "新对话"}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Content
        container={container}
        className="conversation-popover"
        width="360px"
        aria-label="选择会话"
        aria-busy={working}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInput.current?.focus();
        }}
        onKeyDown={keepKeys}
        onEscapeKeyDown={(event) => {
          preventComposingDismiss(event);
          if (working) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (working) event.preventDefault();
        }}
      >
        <Command
          label="选择会话"
          loop
          defaultValue={active || undefined}
          filter={(_value, query, keywords = []) =>
            keywords
              .join(" ")
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase())
              ? 1
              : 0
          }
        >
          <CommandSearch
            value={search}
            onValueChange={setSearch}
            size="3"
            inputRef={searchInput}
            aria-label="查找会话"
            placeholder="查找会话"
            spellCheck={false}
            disabled={working}
          />
          <Text
            as="label"
            size="3"
            className="conversation-archive"
            onKeyDown={keepKeys}
          >
            <Flex align="center" gap="2" mt="3">
              <Checkbox
                checked={archived}
                disabled={working}
                onCheckedChange={(value) => {
                  setArchived(value === true);
                  searchInput.current?.focus();
                }}
              />
              已归档
            </Flex>
          </Text>
          <Command.List
            className="command-list conversation-list"
            label={archived ? "已归档的对话" : "对话"}
          >
            {shown.map((item) => (
              <Command.Item
                asChild
                key={item.id}
                value={item.id}
                keywords={[item.title, item.preview || ""]}
                disabled={disabled || working}
                onSelect={() => void choose(item)}
              >
                <Button
                  variant="ghost"
                  color="gray"
                  size="3"
                  disabled={disabled || working}
                  aria-current={item.id === active ? "true" : undefined}
                >
                  <Flex direction="column" gap="1" width="100%" minWidth="0">
                    <Flex as="span" align="center" justify="between" gap="3">
                      <Text className="conversation-title" weight="medium">
                        {item.title}
                      </Text>
                      {archived ? (
                        <Text color="blue">恢复</Text>
                      ) : (
                        item.id === active && (
                          <Check size={16} aria-label="当前对话" />
                        )
                      )}
                    </Flex>
                    {item.preview && (
                      <Text size="2" color="gray" truncate>
                        {item.preview}
                      </Text>
                    )}
                  </Flex>
                </Button>
              </Command.Item>
            ))}
            <Command.Empty>
              <Text size="3" color="gray">
                {search.trim()
                  ? "没有匹配的会话"
                  : archived
                    ? "没有已归档的对话"
                    : "还没有对话"}
              </Text>
            </Command.Empty>
          </Command.List>
        </Command>
        {error && (
          <Callout.Root role="alert" color="red" mt="3">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
      </Popover.Content>
    </Popover.Root>
  );
}
export function FollowLatest({ onClick }: { onClick: () => void }) {
  return (
    <button className="follow-latest" onClick={onClick}>
      <ArrowDown size={13} />
      回到底部
    </button>
  );
}
