import type { LocateChange } from "../lib/reviewTypes";
import { useProposals } from "../lib/useProposals";
import { useChatReferences } from "./ChatReferences";
import type { Quotation } from "../lib/references";
import { eventBinding } from "../lib/shortcuts";
import { ProviderSettings } from "./ProviderSettings";
import { ProposalReview, type SourceProposal } from "./ProposalReview";
import { TextPrompt } from "./TextPrompt";
import { ImportHistory } from "./ImportHistory";
import { subscribeEvents } from "../lib/events";
import {
  ActivityBatch,
  ChatMarkdown,
  ConversationPicker,
  CopyButton,
  FollowLatest,
  mergeActivity,
  useConversationScroll,
  type ConversationSummary,
  type Message,
} from "./ConversationContent";
export type { Message } from "./ConversationContent";
import { openUrl } from "@tauri-apps/plugin-opener";
import { desktop } from "../lib/transport";
import type { ProjectFolder } from "./Files";
import type { JsonValue } from "../generated/serde_json/JsonValue";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Plus,
  Send,
  Square,
  Settings2,
  X,
  Pencil,
  GitBranch,
} from "lucide-react";
import { command } from "../lib/transport";
import type { Document } from "../lib/types";
interface RuntimeState {
  eventCursor: number;
  canSteer?: boolean;
  turnId?: string;
  migration?: { requiresContext: boolean; sourceRuntime: string };
  contextTransfer?: {
    reason: "contract-change" | "history-import";
    pending: boolean;
    truncated: boolean;
  } | null;
  runtime: "builtin" | "codex";
  status: string;
  available: boolean;
  detail?: string | null;
  account?: unknown;
  runtimeInstall?: {
    phase: string;
    received: number;
    total: number | null;
    busy: boolean;
    error: string | null;
  };
  modelConfigurationError?: { message: string } | null;
  busy: boolean;
  messages: Message[];
  model: string | null;
  effort: string | null;
  services: {
    id: string;
    name: string;
    model: string;
    apiKeyHint: string;
    baseUrl: string;
    api: string;
    effort: string;
    contextWindow: number;
    vision: boolean;
  }[];
  customProvider: Record<string, unknown> | null;
  conversationId: string | null;
  transmission?: { message: string } | null;
}
interface Props {
  visible: boolean;
  onLocate?: (target: LocateChange) => void;
  doc: Document | null;
  folder: ProjectFolder | null;
  circuit: string | null;
  onError: (e: unknown) => void;
  onDocument: (d: Document, expectedBaseRevision?: string) => void;
  selection: string[];
  quotation: Quotation | null;
  onQuoted: (id: string) => void;
  composerAttachmentSlot?: ReactNode;
  renderMessageContext?: (message: Message) => ReactNode;
  onFollowReference?: (href: string, message: Message) => void;
}
const runtime = <T,>(method: string, args: unknown = {}) =>
  command<T>({ op: "agent", method, args: args as JsonValue });
export function Chat({
  visible,
  doc,
  circuit,
  onError,
  onDocument,
  folder,
  quotation,
  onQuoted,
  selection,
  composerAttachmentSlot,
  renderMessageContext,
  onFollowReference,
  onLocate,
}: Props) {
  const [state, setState] = useState<RuntimeState | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [draftRecord, setDraftRecord] = useState({ key: "", text: "" }),
    [configure, setConfigure] = useState(false),
    [pending, setPending] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]),
    [models, setModels] = useState<
      { model: string; name?: string; label?: string }[]
    >([]);
  const [connection, setConnection] = useState(0);
  const proposals = useProposals(doc?.id, connection, onError);
  const [reviewing, setReviewing] = useState<SourceProposal | null>(null);
  useEffect(() => setReviewing(null), [doc?.id]);
  const discardProposal = (proposal: SourceProposal) => {
    void proposals.discard(proposal).then((discarded) => {
      if (discarded)
        setReviewing((current) =>
          current?.id === proposal.id ? null : current,
        );
    });
  };
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const [questions, setQuestions] = useState<any>(null);
  const [boundWorkspace, setBoundWorkspace] = useState<string | null>(null);
  const [boundDocument, setBoundDocument] = useState<string | null>(null);
  const boundDocumentRef = useRef<string | null>(null);
  const setBoundIdentity = (identity: string | null) => {
    boundDocumentRef.current = identity;
    setBoundDocument(identity);
  };
  const actionQueue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(action: () => Promise<T>): Promise<T> => {
    const next = actionQueue.current.catch(() => {}).then(action);
    actionQueue.current = next;
    return next;
  };
  const actionPending = useRef(false);
  const currentBusy = useRef(false);
  currentBusy.current = Boolean(state?.busy);
  const normalizePath = (path: string) =>
    path.replaceAll("\\", "/").replace(/\/$/, "");
  const workspaceKey =
    folder &&
    doc?.path &&
    normalizePath(doc.path).startsWith(normalizePath(folder.path) + "/")
      ? folder.id
      : doc?.id || "";
  const workspaceReady = Boolean(doc && boundWorkspace === workspaceKey);
  const documentIdentity = doc
    ? JSON.stringify([workspaceKey, doc.id, circuit])
    : null;
  const documentReady = workspaceReady && boundDocument === documentIdentity;
  const draftKey = workspaceReady
    ? "vibe.draft:" + workspaceKey + ":" + (state?.conversationId || "")
    : "";
  const draft = draftRecord.key === draftKey ? draftRecord.text : "";
  useEffect(() => {
    setDraftRecord({
      key: draftKey,
      text: draftKey ? localStorage.getItem(draftKey) || "" : "",
    });
  }, [draftKey]);
  const changeDraft = (text: string) => {
    if (!draftKey) return;
    setDraftRecord({ key: draftKey, text });
    localStorage.setItem(draftKey, text);
  };
  const acknowledgeDraft = (receipt: { key: string; text: string }) => {
    // A successful send only consumes the text that was submitted. Typing or
    // switching conversations while awaiting acknowledgement keeps the new draft.
    if (localStorage.getItem(receipt.key) === receipt.text)
      localStorage.removeItem(receipt.key);
    setDraftRecord((current) =>
      current.key === receipt.key && current.text === receipt.text
        ? { key: current.key, text: "" }
        : current,
    );
  };
  const references = useChatReferences({
    draftKey,
    workspaceKey,
    documentId: doc?.id,
    quotation,
    onQuoted,
    onError,
    ready: documentReady && Boolean(state?.conversationId),
  });
  const [renameConversation, setRenameConversation] = useState(false);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [editedText, setEditedText] = useState("");
  useEffect(() => {
    setEditingMessage(null);
    setEditedText("");
    setRuntimeError("");
  }, [workspaceKey, state?.conversationId]);
  useEffect(() => {
    setQuestions(null);
  }, [state?.conversationId]);
  const cursor = useRef(0),
    scroller = useRef<HTMLDivElement>(null),
    binding = useRef<string | null>(null);
  const buffered = useRef<{ sequence: number; event: any }[]>([]);
  const applyEvent = useRef<(event: any) => void>(() => {});
  const snapshotCursor = useRef(0);
  const refresh = async (): Promise<RuntimeState> => {
    const next = await runtime<RuntimeState>("status");
    // The cursor is captured when the sidecar writes its snapshot. Replay only newer events.
    if (next.eventCursor < snapshotCursor.current) return next;
    if (
      buffered.current.length === 2048 &&
      buffered.current[0].sequence > next.eventCursor + 1
    )
      return refresh();
    snapshotCursor.current = next.eventCursor;
    cursor.current = next.eventCursor;
    setState(next);
    setMessages(next.messages || []);
    for (const item of buffered.current)
      if (item.sequence > cursor.current) {
        cursor.current = item.sequence;
        applyEvent.current(item.event);
      }
    return next;
  };
  useEffect(() => {
    applyEvent.current = (e) => {
      if (e.type === "status") {
        setState(e);
        setMessages(e.messages || []);
      } else if (e.type === "history") setMessages(e.messages);
      else if (e.type === "user-message")
        setMessages((previous) => [
          ...previous,
          { id: e.id, type: "user", text: e.text, context: e.context },
        ]);
      else if (e.type === "assistant-delta" || e.type === "reasoning-delta") {
        const id =
          e.type === "reasoning-delta" && !e.itemId.endsWith(":reasoning")
            ? e.itemId + ":reasoning"
            : e.itemId;
        setMessages((previous) => {
          const old = previous.find((m) => m.id === id);
          return old
            ? previous.map((m) =>
                m.id === id ? { ...m, text: (m.text || "") + e.delta } : m,
              )
            : [
                ...previous,
                {
                  id,
                  type:
                    e.type === "reasoning-delta" ? "reasoning" : "assistant",
                  text: e.delta,
                },
              ];
        });
      } else if (e.type === "assistant-completed")
        setMessages((previous) =>
          previous.some((m) => m.id === e.itemId)
            ? previous.map((m) =>
                m.id === e.itemId ? { ...m, text: e.text, phase: e.phase } : m,
              )
            : [
                ...previous,
                {
                  id: e.itemId,
                  type: "assistant",
                  text: e.text,
                  phase: e.phase,
                },
              ],
        );
      else if (e.type === "activity")
        setMessages((previous) =>
          previous.some((m) => m.id === e.id)
            ? previous.map((m) => (m.id === e.id ? mergeActivity(m, e) : m))
            : [...previous, e],
        );
      else if (e.type === "conversations-changed")
        setConversations(e.conversations || []);
      else if (e.type === "runtime-error") {
        setRuntimeError(e.message);
        setState((old) => (old ? { ...old, busy: false } : old));
      } else if (e.type === "question")
        setQuestions({ ...e, workspaceKey: binding.current });
      else if (e.type === "turn-completed")
        setQuestions((current: any) =>
          current?.turnId === e.turnId ? null : current,
        );
      else if (e.type === "document-changed")
        onDocument(e.document, e.expectedBaseRevision);
      else if (e.type === "proposed-source") proposals.receive(e);
    };
    const stop = subscribeEvents((event) => {
      if (event.topic === "resync")
        void enqueue(() => refresh())
          .then(() => {
            binding.current = null;
            setBoundWorkspace(null);
            setBoundIdentity(null);
            setConnection((value) => value + 1);
          })
          .catch(onError);
      if (event.topic !== "agent") return;
      const item = event.data;
      buffered.current.push(item);
      if (buffered.current.length > 2048) buffered.current.shift();
      if (item.sequence > cursor.current) {
        cursor.current = item.sequence;
        applyEvent.current(item.event);
      }
    });
    return stop;
  }, []);
  useEffect(() => {
    if (!doc || state?.busy) return;
    const key = workspaceKey;
    const identity = documentIdentity;
    if (binding.current === key && boundDocumentRef.current === identity)
      return;
    let live = true;
    void enqueue(async () => {
      if (!live || currentBusy.current) return;
      if (binding.current !== key) {
        binding.current = null;
        setBoundWorkspace(null);
      }
      setBoundIdentity(null);
      await runtime("bind", {
        id: doc.id,
        revision: doc.revision,
        circuit,
        workspaceKey: key,
      });
      if (!live) return;
      binding.current = key;
      setBoundWorkspace(key);
      setBoundIdentity(identity);
      await refresh();
      const result = await runtime<{ conversations: typeof conversations }>(
        "conversations",
      );
      if (live && result) setConversations(result.conversations);
    }).catch((error) => {
      if (live) onError(error);
    });
    return () => {
      live = false;
    };
  }, [
    doc?.id,
    doc?.path,
    documentIdentity,
    workspaceKey,
    Boolean(state?.busy),
    connection,
  ]);
  const scroll = useConversationScroll(
    scroller,
    draftKey,
    visible && !configure,
    messages,
  );
  const send = async () => {
    if (
      !doc ||
      !documentReady ||
      !draft.trim() ||
      actionPending.current ||
      references.pending
    )
      return;
    const receipt = { key: draftKey, text: draft };
    const attachmentReceipt = references.receipt();
    actionPending.current = true;
    setPending(true);
    try {
      await enqueue(async () => {
        if (state?.busy) {
          if (!state.canSteer || binding.current !== workspaceKey)
            throw new Error("请等待当前回答结束，或停止后发送");
        } else
          await runtime("bind", {
            id: doc.id,
            revision: doc.revision,
            circuit,
            workspaceKey,
          });
        await runtime("ask", {
          question: draft,
          references: attachmentReceipt.ids,
          documentId: doc.id,
          circuit,
          selection,
          expectedTurnId: state?.busy ? state.turnId : undefined,
        });
        acknowledgeDraft(receipt);
        references.acknowledge(attachmentReceipt);
        await refresh();
      });
    } catch (e) {
      onError(e);
    } finally {
      actionPending.current = false;
      setPending(false);
    }
  };
  const switchConversation = async (action: string, id?: string) => {
    if (!workspaceReady || actionPending.current || state?.busy) return;
    actionPending.current = true;
    setPending(true);
    try {
      await enqueue(async () => {
        await runtime("conversations", { action, id });
        await refresh();
      });
    } catch (e) {
      onError(e);
    } finally {
      actionPending.current = false;
      setPending(false);
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        eventBinding(event) !== "Mod+Shift+O" ||
        document.querySelector('dialog[open],[aria-modal="true"]')
      )
        return;
      event.preventDefault();
      void switchConversation("new");
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  const fork = async (messageId: string) => {
    if (!workspaceReady || actionPending.current || state?.busy) return;
    actionPending.current = true;
    setPending(true);
    try {
      await enqueue(async () => {
        const result = await runtime<{ conversations: typeof conversations }>(
          "conversations",
          { action: "fork", messageId },
        );
        setConversations(result.conversations);
        await refresh();
      });
    } catch (e) {
      onError(e);
    } finally {
      actionPending.current = false;
      setPending(false);
    }
  };
  const resubmit = async () => {
    if (
      !documentReady ||
      !editingMessage ||
      !doc ||
      !editedText.trim() ||
      actionPending.current ||
      state?.busy
    )
      return;
    actionPending.current = true;
    setPending(true);
    try {
      await enqueue(async () => {
        await runtime("bind", {
          id: doc.id,
          revision: doc.revision,
          circuit,
          workspaceKey,
        });
        await runtime("ask", {
          question: editedText,
          references:
            editingMessage.context?.references?.map(
              (reference) => reference.id,
            ) || [],
          documentId: doc.id,
          circuit,
          editMessageId: editingMessage.id,
          selection,
        });
        setEditingMessage(null);
        await refresh();
      });
    } catch (e) {
      onError(e);
    } finally {
      actionPending.current = false;
      setPending(false);
    }
  };
  const chooseRuntime = async (kind: string) => {
    setPending(true);
    try {
      await runtime("runtime", { runtime: kind });
      binding.current = null;
      setBoundWorkspace(null);
      setBoundIdentity(null);
      setConnection((value) => value + 1);
      setModels([]);
      await refresh();
      const c = await runtime<{ conversations: typeof conversations }>(
        "conversations",
      );
      if (c) setConversations(c.conversations);
    } catch (e) {
      onError(e);
    } finally {
      setPending(false);
    }
  };
  const login = () =>
    void runtime<{ authUrl: string }>("login")
      .then(async ({ authUrl }) => {
        if (desktop()) await openUrl(authUrl);
        else window.open(authUrl, "_blank", "noopener,noreferrer");
      })
      .catch(onError);
  const loadModels = () =>
    void runtime<{ models: typeof models }>("models", { refresh: true })
      .then((r) => setModels(r.models))
      .catch(onError);
  return (
    <div className="chat" style={visible ? undefined : { display: "none" }}>
      {renameConversation && (
        <TextPrompt
          title="重命名对话"
          initial={
            conversations.find((c) => c.id === state?.conversationId)?.title
          }
          onClose={() => setRenameConversation(false)}
          onSubmit={async (title) => {
            await runtime("conversations", {
              action: "rename",
              id: state?.conversationId,
              title,
            });
            await refresh();
          }}
        />
      )}
      <div className="chat-header">
        <ConversationPicker
          conversations={conversations}
          active={state?.conversationId || null}
          disabled={!workspaceReady || pending || Boolean(state?.busy)}
          onSelect={(id) => void switchConversation("select", id)}
          onRestore={(id) => void switchConversation("restore", id)}
        />
        <button
          title="新建对话"
          aria-label="新建对话"
          disabled={!workspaceReady || pending || state?.busy}
          onClick={() => void switchConversation("new")}
        >
          <Plus size={15} />
        </button>
        <details className="menu">
          <summary aria-label="对话操作">···</summary>
          <div className="menu-content">
            <button
              disabled={
                !workspaceReady ||
                !state?.conversationId ||
                state.busy ||
                pending
              }
              onClick={() => setRenameConversation(true)}
            >
              重命名…
            </button>
            <button
              disabled={
                !workspaceReady ||
                !state?.conversationId ||
                state.busy ||
                pending
              }
              onClick={() =>
                void switchConversation(
                  "archive",
                  state?.conversationId || undefined,
                )
              }
            >
              归档
            </button>
          </div>
        </details>
        <button
          title="模型服务"
          aria-label="模型服务"
          onClick={() => setConfigure(!configure)}
        >
          <Settings2 size={15} />
        </button>
      </div>
      {(runtimeError || state?.detail || state?.modelConfigurationError) && (
        <div className="error-bar" role="alert">
          {runtimeError ||
            state?.modelConfigurationError?.message ||
            state?.detail}
          <button
            onClick={() =>
              void runtime("reconnect")
                .then(() => {
                  setRuntimeError("");
                  binding.current = null;
                  setBoundWorkspace(null);
                  setBoundIdentity(null);
                  setConnection((value) => value + 1);
                  return refresh();
                })
                .catch(onError)
            }
          >
            重新连接
          </button>
        </div>
      )}
      {state?.runtime === "builtin" && state.modelConfigurationError && (
        <div className="runtime-progress">
          {state.services.length ? (
            <select
              aria-label="为当前会话选择服务"
              defaultValue=""
              disabled={state.busy || pending}
              onChange={(e) => {
                const service = state.services.find(
                  (s) => s.id === e.target.value,
                );
                if (!service) return;
                setPending(true);
                void runtime("bindProvider", {
                  id: service.id,
                  baseUrl: service.baseUrl,
                  api: service.api,
                  conversationId: state.conversationId,
                })
                  .then(() => refresh())
                  .catch(onError)
                  .finally(() => setPending(false));
              }}
            >
              <option value="" disabled>
                选择模型服务
              </option>
              {state.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name || service.baseUrl}
                </option>
              ))}
            </select>
          ) : (
            <button onClick={() => setConfigure(true)}>添加模型服务</button>
          )}
        </div>
      )}
      {state?.runtimeInstall?.busy && state.runtime === "codex" && (
        <div className="runtime-progress" role="status">
          <span>
            正在准备 Codex
            {state.runtimeInstall.total
              ? ` · ${Math.round((state.runtimeInstall.received / state.runtimeInstall.total) * 100)}%`
              : "…"}
          </span>
          <button onClick={() => void runtime("cancelInstall").catch(onError)}>
            取消
          </button>
        </div>
      )}
      {configure ? (
        <ProviderSettings
          key={state?.runtime || "builtin"}
          runtime={state?.runtime || "builtin"}
          services={state?.services || []}
          provider={state?.customProvider || null}
          busy={pending || Boolean(state?.busy)}
          canImport={workspaceReady}
          request={runtime}
          onRuntime={chooseRuntime}
          onLogin={login}
          onImport={() => setImporting(true)}
          onSaved={async () => {
            setModels([]);
            await refresh();
          }}
          onClose={() => setConfigure(false)}
        />
      ) : (
        <>
          {importResult && (
            <div className="runtime-progress" role="status">
              {importResult}
              <button
                aria-label="关闭导入结果"
                onClick={() => setImportResult("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {(state?.contextTransfer?.pending ||
            (!state?.contextTransfer && state?.migration?.requiresContext)) && (
            <div className="runtime-progress">
              {state?.contextTransfer?.reason === "contract-change"
                ? "运行时已更新，继续时会携带旧对话的文字记录。"
                : "继续时会携带旧版文字记录，建立新的会话。"}
              {state?.contextTransfer?.truncated && "仅携带最近记录。"}
            </div>
          )}
          <div
            ref={scroller}
            className="messages"
            tabIndex={0}
            onScroll={scroll.onScroll}
            onWheel={scroll.onWheel}
            onKeyDown={scroll.onKeyDown}
          >
            <div className="messages-content">
              {(!workspaceReady || !messages.length) && (
                <div className="quiet-empty">
                  {!doc ? (
                    "打开电路后开始对话"
                  ) : !state?.services?.length && state?.runtime !== "codex" ? (
                    <button onClick={() => setConfigure(true)}>
                      添加模型服务
                    </button>
                  ) : state?.runtime === "codex" &&
                    state.status === "auth-required" ? (
                    <button onClick={login}>使用 ChatGPT 登录</button>
                  ) : (
                    "描述要完成的电路，或选中元件后提问。"
                  )}
                </div>
              )}
              {(workspaceReady ? messages : []).map((m, index) =>
                m.type === "activity" ? (
                  index > 0 &&
                  messages[index - 1].type === "activity" ? null : (
                    <ActivityBatch
                      messages={messages.slice(
                        index,
                        messages.findIndex(
                          (item, next) =>
                            next > index && item.type !== "activity",
                        ) < 0
                          ? undefined
                          : messages.findIndex(
                              (item, next) =>
                                next > index && item.type !== "activity",
                            ),
                      )}
                      key={m.id}
                    />
                  )
                ) : m.type === "reasoning" ? (
                  <details className="message reasoning" key={m.id}>
                    <summary>思考过程</summary>
                    {m.text}
                  </details>
                ) : ["user", "assistant"].includes(m.type) ? (
                  <div className={"message " + m.type} key={m.id}>
                    {editingMessage?.id === m.id ? (
                      <div className="message-edit">
                        <textarea
                          aria-label="编辑消息"
                          value={editedText}
                          onChange={(e) => setEditedText(e.target.value)}
                        />
                        <button
                          disabled={pending || !editedText.trim()}
                          onClick={() => void resubmit()}
                        >
                          重新发送
                        </button>
                        <button
                          disabled={pending}
                          onClick={() => setEditingMessage(null)}
                        >
                          取消
                        </button>
                      </div>
                    ) : m.type === "assistant" ? (
                      <ChatMarkdown
                        text={m.text || ""}
                        onError={onError}
                        onFollowReference={
                          onFollowReference
                            ? (href) =>
                                onFollowReference(href, {
                                  ...m,
                                  context:
                                    m.context ||
                                    messages
                                      .slice(0, index)
                                      .reverse()
                                      .find(
                                        (message) => message.type === "user",
                                      )?.context,
                                })
                            : undefined
                        }
                      />
                    ) : (
                      m.text
                    )}
                    {references.renderContext(m.context)}
                    {renderMessageContext?.(m)}
                    {!editingMessage && (
                      <div className="message-actions">
                        <CopyButton text={m.text || ""} onError={onError} />
                        {!state?.busy && m.canEdit && (
                          <button
                            title="编辑并重新发送"
                            aria-label="编辑并重新发送"
                            disabled={pending}
                            onClick={() => {
                              setEditingMessage(m);
                              setEditedText(m.text || "");
                            }}
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                        {!state?.busy && m.canFork && (
                          <button
                            title="从这里创建分支"
                            aria-label="从这里创建分支"
                            disabled={pending}
                            onClick={() => void fork(m.id)}
                          >
                            <GitBranch size={12} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ) : null,
              )}
              {state?.transmission && (
                <div className="error-bar">{state.transmission.message}</div>
              )}
              {workspaceReady && questions?.workspaceKey === workspaceKey && (
                <form
                  className="agent-questions"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    const answers = Object.fromEntries(
                      questions.questions.map((q: any) => [
                        q.id,
                        String(data.get(q.id) || ""),
                      ]),
                    );
                    void runtime("answer", {
                      requestId: questions.requestId,
                      answers,
                    })
                      .then(() =>
                        setQuestions((current: any) =>
                          current?.requestId === questions.requestId
                            ? null
                            : current,
                        ),
                      )
                      .catch(onError);
                  }}
                >
                  {questions.questions.map((q: any) => (
                    <label key={q.id}>
                      {q.question}
                      <input
                        required
                        maxLength={4000}
                        name={q.id}
                        list={"answers-" + q.id}
                      />
                      <datalist id={"answers-" + q.id}>
                        {q.options?.map((o: any) => (
                          <option key={o.label} value={o.label} />
                        ))}
                      </datalist>
                    </label>
                  ))}
                  <button type="submit">继续</button>
                </form>
              )}
              {proposals.proposals.map((proposal) => (
                <div className="proposal" key={proposal.id}>
                  <span>
                    待审阅改动
                    {proposals.proposals.length > 1 && (
                      <small>
                        {" "}
                        ·{" "}
                        {new Date(proposal.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </small>
                    )}
                  </span>
                  <button
                    className="primary"
                    disabled={proposals.pending.has(proposal.id)}
                    onClick={() => setReviewing(proposal)}
                  >
                    审阅
                  </button>
                  <button
                    disabled={proposals.pending.has(proposal.id)}
                    onClick={() => discardProposal(proposal)}
                  >
                    放弃
                  </button>
                </div>
              ))}
            </div>
          </div>
          {!scroll.following && <FollowLatest onClick={scroll.latest} />}
          <div className="composer">
            {references.composer}
            {composerAttachmentSlot}
            <textarea
              value={draft}
              onChange={(e) => changeDraft(e.target.value)}
              placeholder="描述你的想法…"
              aria-label="消息"
              disabled={!workspaceReady}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <footer>
              <select
                aria-label="模型"
                value={state?.model || ""}
                onFocus={() => {
                  if (!models.length) loadModels();
                }}
                disabled={!workspaceReady || pending || state?.busy}
                onChange={(e) =>
                  void runtime("selectModel", {
                    model: e.target.value,
                    effort: state?.effort || "none",
                  })
                    .then(() => refresh())
                    .catch(onError)
                }
              >
                <option value={state?.model || ""}>
                  {state?.model || "选择模型"}
                </option>
                {models
                  .filter((m) => m.model !== state?.model)
                  .map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.name || m.label || m.model}
                    </option>
                  ))}
              </select>
              <select
                aria-label="思考深度"
                value={state?.effort || "none"}
                disabled={
                  !workspaceReady || pending || !state?.model || state.busy
                }
                onChange={(e) =>
                  void runtime("selectModel", {
                    model: state?.model,
                    effort: e.target.value,
                  })
                    .then(() => refresh())
                    .catch(onError)
                }
              >
                {[
                  ["none", "默认"],
                  ["low", "轻度"],
                  ["medium", "中"],
                  ["high", "高"],
                  ["xhigh", "极高"],
                  ["max", "最高"],
                ].map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              {state?.busy && draft.trim() && (
                <button
                  aria-label="追加意见"
                  title="追加意见"
                  disabled={
                    !documentReady ||
                    pending ||
                    references.pending ||
                    !state.canSteer
                  }
                  onClick={() => void send()}
                >
                  <Send size={15} />
                </button>
              )}
              {state?.busy ? (
                <button
                  aria-label="停止回答"
                  onClick={() =>
                    void runtime("stop")
                      .then(() => refresh())
                      .catch(onError)
                  }
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  className="primary"
                  aria-label="发送"
                  disabled={
                    !documentReady ||
                    !draft.trim() ||
                    references.pending ||
                    pending ||
                    !state?.available
                  }
                  onClick={() => void send()}
                >
                  <Send size={15} />
                </button>
              )}
            </footer>
          </div>
        </>
      )}
      {visible && reviewing && doc && reviewing.documentId === doc.id && (
        <ProposalReview
          key={reviewing.id}
          proposal={reviewing}
          doc={doc}
          circuit={circuit}
          onClose={() => setReviewing(null)}
          onDiscard={() => discardProposal(reviewing)}
          onDocument={onDocument}
          onLocate={onLocate}
        />
      )}
      {importing && (
        <ImportHistory
          workspaceKey={workspaceKey}
          request={runtime}
          onClose={() => setImporting(false)}
          onDone={(message) => {
            setImportResult(message);
            setConfigure(false);
          }}
        />
      )}
    </div>
  );
}
