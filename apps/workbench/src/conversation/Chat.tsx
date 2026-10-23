import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  CircuitBoard,
  MoreHorizontal,
  Pencil,
  Plus,
  ScanSearch,
  Send,
  Settings2,
  Square,
  Timer,
  Undo2,
} from "lucide-react";
import type { JsonValue } from "../generated/serde_json/JsonValue";
import { subscribeEvents } from "../shared/events";
import type { Quotation } from "./references";
import { eventBinding } from "../shared/shortcuts";
import { command } from "../shared/transport";
import type { Document } from "../shared/types";
import { useChatReferences } from "./ChatReferences";
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
import type { ProjectFolder } from "../workspace/Files";
import {
  ModelPicker,
  type ModelListResult,
  type ModelOption,
} from "./ModelPicker";
import {
  ProviderSettings,
  type ProviderConfiguration,
} from "./ProviderSettings";
import { TextPrompt } from "../shared/TextPrompt";
export type { Message } from "./ConversationContent";

/** The sidecar's `status` snapshot; the host adds `eventCursor`. */
interface RuntimeState {
  eventCursor: number;
  status: string;
  detail?: string | null;
  available: boolean;
  busy: boolean;
  canSteer?: boolean;
  turnId?: string | null;
  conversationId: string | null;
  model: string | null;
  effort: string | null;
  customProvider: Partial<ProviderConfiguration> | null;
  services: ProviderConfiguration[];
  defaultServiceId?: string | null;
  messages: Message[];
  transmission?: { message: string } | null;
  modelConfigurationError?: { message: string } | null;
}
/** A turn's file changes, recorded by the folder history as one entry. */
interface FilesChange {
  folderId: string;
  conversationId: string | null;
  change: {
    id: string;
    title: string;
    at: number;
    undoable: boolean;
    files: { path: string; kind: string }[];
  };
  undone?: boolean;
}
interface Props {
  visible: boolean;
  doc: Document | null;
  folder: ProjectFolder | null;
  circuit: string | null;
  onError: (e: unknown) => void;
  /** The AI edited an open document. */
  onDocument: (d: Document, expectedBaseRevision?: string) => void;
  /** The AI opened or created a document. */
  onOpened: (d: Document) => void;
  /** Files in the project folder changed outside the open documents. */
  onFilesChanged: () => Promise<void>;
  selection: string[];
  quotation: Quotation | null;
  onQuoted: (id: string) => void;
  /** A dragged file is over the conversation. */
  referenceDrop?: boolean;
  onFollowReference?: (href: string, message: Message) => void;
}
// One-click first prompts. Build prompts adapt to what is open: an empty
// circuit is built in place, otherwise a new file keeps existing work intact.
const STARTER_HOW =
  "优先用结构化的电路工具放置元件和连线，再用仿真核对真值表；用清晰的连线和布局表达电路。";
function starterActions(
  emptyOpen: boolean,
  readable: boolean,
  selected: boolean,
) {
  const adder = {
    id: "build",
    label: "构建一个全加器",
    icon: CircuitBoard,
    prompt:
      (emptyOpen
        ? "在当前打开的这个空电路里构建一个全加器，输入为 A、B、Cin，输出为 Sum、Cout。"
        : "帮我在工作区中新建一份全加器电路，输入为 A、B、Cin，输出为 Sum、Cout。保留已有文件。") +
      STARTER_HOW +
      "最后简要说明原理和如何操作它。",
  };
  if (!readable)
    return [
      adder,
      {
        id: "explain",
        label: "认识与门、或门和非门",
        icon: BookOpen,
        prompt:
          "我是逻辑电路新手。用简单的输入输出例子，讲解与门、或门和非门分别做什么，以及怎样在画布上操作和观察它们。",
      },
      {
        id: "check",
        label: "构建一个计数器",
        icon: Timer,
        prompt:
          (emptyOpen
            ? "在当前打开的这个空电路里构建一个四位二进制计数器，带时钟和复位输入，能直观看到计数变化。"
            : "帮我在工作区中新建一份四位二进制计数器电路，带时钟和复位输入，能直观看到计数变化。保留已有文件。") +
          STARTER_HOW +
          "最后简要说明怎么启动、单步和复位。",
      },
    ];
  const target = selected ? "选中的部分" : "当前电路";
  return [
    adder,
    {
      id: "explain",
      label: `讲解一下${target}`,
      icon: BookOpen,
      prompt: `请结合实际电路讲解${target}：它要完成什么功能，输入和输出是什么，信号怎样流动，各部分为什么这样连接。用初学者能理解的方式说明，先不要修改文件。`,
    },
    {
      id: "check",
      label: selected ? "检查选中部分的问题" : "检查电路中的问题",
      icon: ScanSearch,
      prompt: `帮我检查${target}中可能的问题，结合实际连线、元件属性和可用的运行反馈，指出具体位置和原因。不确定的地方请说明，先不要修改文件。`,
    },
  ];
}
const runtime = <T,>(method: string, args: unknown = {}) =>
  command<T>({ op: "agent", method, args: args as JsonValue });
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const kindNames: Record<string, string> = {
  added: "新增",
  deleted: "删除",
  modified: "修改",
};
const defaultEfforts = [
  ["none", "默认"],
  ["low", "轻度"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "极高"],
  ["max", "最高"],
];

export function Chat({
  visible,
  doc,
  folder,
  circuit,
  onError,
  onDocument,
  onOpened,
  onFilesChanged,
  selection,
  quotation,
  onQuoted,
  referenceDrop,
  onFollowReference,
}: Props) {
  const [state, setState] = useState<RuntimeState | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [conversations, setConversations] = useState<ConversationSummary[]>([]),
    [models, setModels] = useState<ModelOption[]>([]),
    [fileChanges, setFileChanges] = useState<FilesChange[]>([]);
  const [draftRecord, setDraftRecord] = useState({ key: "", text: "" }),
    [configure, setConfigure] = useState(false),
    [pending, setPending] = useState(false),
    [runtimeError, setRuntimeError] = useState(""),
    [renameConversation, setRenameConversation] = useState(false),
    [editingMessage, setEditingMessage] = useState<Message | null>(null),
    [editedText, setEditedText] = useState("");
  // Conversations live per folder in the sidecar; without a folder the open
  // document scopes the local draft only (sending needs a folder).
  const scope = folder ? folder.id : doc?.id || "global";
  const [boundTo, setBoundTo] = useState<{
    scope: string;
    documentId?: string;
  } | null>(null);
  const [connection, setConnection] = useState(0);
  const bound = useRef<{ scope: string; documentId?: string } | null>(null);
  const target = useRef({ scope, documentId: doc?.id });
  target.current = { scope, documentId: doc?.id };
  const live = useRef(state);
  live.current = state;
  // The folder binding keeps the draft; sending and staging references also
  // wait for the current document to be bound.
  const scopeReady = Boolean(state) && boundTo?.scope === scope;
  const ready = scopeReady && boundTo?.documentId === doc?.id;
  const busy = Boolean(state?.busy);
  const scroller = useRef<HTMLDivElement>(null);

  // Runtime calls that change the conversation run one after another.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(action: () => Promise<T>): Promise<T> => {
    const next = queue.current.catch(() => {}).then(action);
    queue.current = next;
    return next;
  };
  const actionPending = useRef(false);
  const act = async (work: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setPending(true);
    try {
      await enqueue(work);
    } catch (e) {
      onError(e);
    } finally {
      actionPending.current = false;
      setPending(false);
    }
  };

  // Events carry a sequence; a snapshot carries the cursor it was taken at.
  // Events newer than the snapshot are replayed from the buffer after it.
  const cursor = useRef(0),
    snapshotCursor = useRef(0),
    buffered = useRef<{ sequence: number; event: any }[]>([]),
    applyEvent = useRef<(event: any) => void>(() => {});
  const refresh = async (): Promise<RuntimeState> => {
    const next = await runtime<RuntimeState>("status");
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
  // A list event that arrives while a list request is in flight is newer than
  // the request's answer; the epoch lets the late answer be dropped.
  const listEpoch = useRef(0);
  const loadConversations = async () => {
    const epoch = ++listEpoch.current;
    const result = await runtime<{
      conversations: ConversationSummary[];
    } | null>("conversations");
    if (
      result &&
      listEpoch.current === epoch &&
      bound.current?.scope === target.current.scope
    )
      setConversations(result.conversations);
  };
  applyEvent.current = (e) => {
    switch (e.type) {
      case "status":
        setState(e);
        setMessages(e.messages || []);
        break;
      case "history":
        setMessages(e.messages);
        break;
      case "user-message":
        setMessages((previous) => [
          ...previous,
          {
            id: e.id,
            type: "user",
            text: e.text,
            context: e.context,
            canEdit: e.canEdit,
          },
        ]);
        break;
      case "assistant-delta":
      case "reasoning-delta": {
        const id =
          e.type === "reasoning-delta" && !e.itemId.endsWith(":reasoning")
            ? e.itemId + ":reasoning"
            : e.itemId;
        setMessages((previous) =>
          previous.some((m) => m.id === id)
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
              ],
        );
        break;
      }
      case "assistant-completed":
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
        break;
      case "activity":
        setMessages((previous) =>
          previous.some((m) => m.id === e.id)
            ? previous.map((m) => (m.id === e.id ? mergeActivity(m, e) : m))
            : [...previous, e],
        );
        break;
      case "conversations-changed":
        // Lists are per folder; one for a folder this view has left is stale.
        if (e.workspaceKey && e.workspaceKey !== target.current.scope) break;
        listEpoch.current++;
        setConversations(e.conversations || []);
        break;
      case "runtime-error":
        setRuntimeError(e.message);
        setState((old) => (old ? { ...old, busy: false } : old));
        break;
      case "document-changed":
        onDocument(e.document, e.expectedBaseRevision);
        break;
      case "document-opened":
        onOpened(e.document);
        break;
      case "files-changed":
        setFileChanges((previous) => [
          ...previous.filter((item) => item.change.id !== e.change.id),
          {
            folderId: e.folderId,
            conversationId: live.current?.conversationId ?? null,
            change: e.change,
          },
        ]);
        break;
    }
  };
  useEffect(
    () =>
      subscribeEvents((event) => {
        if (event.topic === "resync") {
          bound.current = null;
          setBoundTo(null);
          setConnection((value) => value + 1);
          return;
        }
        if (event.topic !== "agent") return;
        const item = event.data;
        buffered.current.push(item);
        if (buffered.current.length > 2048) buffered.current.shift();
        if (item.sequence > cursor.current) {
          cursor.current = item.sequence;
          applyEvent.current(item.event);
        }
      }),
    [],
  );
  // Binds the current document whenever it or the folder changes; while the
  // AI is answering, the binding waits for the turn to end.
  useEffect(() => {
    if (state?.busy) return;
    const wanted = target.current;
    if (
      bound.current?.scope === wanted.scope &&
      bound.current.documentId === wanted.documentId
    )
      return;
    void enqueue(async () => {
      if (
        target.current.scope !== wanted.scope ||
        target.current.documentId !== wanted.documentId ||
        live.current?.busy
      )
        return;
      if (bound.current?.scope !== wanted.scope) {
        bound.current = null;
        setBoundTo(null);
      }
      await runtime("bind", { documentId: wanted.documentId });
      bound.current = wanted;
      setBoundTo(wanted);
      await refresh();
      await loadConversations();
    }).catch((error) => setRuntimeError(errorText(error)));
  }, [doc?.id, folder?.id, busy, connection]);
  const reconnect = () =>
    runtime("reconnect")
      .then(() => {
        setRuntimeError("");
        bound.current = null;
        setBoundTo(null);
        setConnection((value) => value + 1);
      })
      .catch(onError);

  const draftKey = scopeReady
    ? "vibe.draft:" + scope + ":" + (state?.conversationId || "")
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
    documentId: doc?.id,
    quotation,
    onQuoted,
    onError,
    ready: ready && Boolean(state?.conversationId),
  });
  useEffect(() => {
    setEditingMessage(null);
    setEditedText("");
    setRuntimeError("");
  }, [scope, state?.conversationId]);
  const scroll = useConversationScroll(scroller, draftKey, visible, messages);

  const send = (text = draft) => {
    if (!ready || !text.trim() || references.pending) return;
    const receipt = { key: draftKey, text },
      attachments = references.receipt();
    void act(async () => {
      const current = live.current;
      if (current?.busy && !current.canSteer)
        throw new Error("请等待当前回答结束，或停止后发送");
      await runtime("ask", {
        question: text,
        references: attachments.ids,
        documentId: doc?.id,
        circuit: circuit ?? undefined,
        selection,
        expectedTurnId: current?.busy ? current.turnId : undefined,
      });
      acknowledgeDraft(receipt);
      references.acknowledge(attachments);
      await refresh();
      await loadConversations();
    });
  };
  const resubmit = () => {
    const message = editingMessage;
    if (!ready || !message || !editedText.trim() || busy) return;
    void act(async () => {
      await runtime("ask", {
        question: editedText,
        references:
          message.context?.references?.map((reference) => reference.id) || [],
        documentId: doc?.id,
        circuit: circuit ?? undefined,
        selection,
        editMessageId: message.id,
      });
      setEditingMessage(null);
      await refresh();
      await loadConversations();
    });
  };
  const switchConversation = (action: string, id?: string) => {
    if (!ready || busy) return;
    void act(async () => {
      await runtime("conversations", { action, id });
      await refresh();
      await loadConversations();
    });
  };
  const undoFiles = (item: FilesChange) =>
    void act(async () => {
      await command({
        op: "folderHistoryUndo",
        folder_id: item.folderId,
        id: item.change.id,
      });
      setFileChanges((previous) =>
        previous.map((entry) =>
          entry === item ? { ...entry, undone: true } : entry,
        ),
      );
      await onFilesChanged();
    });
  // The shortcut listener stays registered for the component's lifetime and
  // reaches the current state through this ref. A listener added again after
  // every render would be dropped from a key press whenever an earlier window
  // listener (the workbench shortcuts reveal this panel on the same key)
  // renders this component before it runs.
  const startConversation = useRef(switchConversation);
  startConversation.current = switchConversation;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        eventBinding(event) !== "Mod+Shift+O" ||
        document.querySelector('dialog[open],[aria-modal="true"]')
      )
        return;
      event.preventDefault();
      startConversation.current("new");
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const modelScope = JSON.stringify([
    scope,
    state?.conversationId,
    state?.customProvider?.id,
    state?.customProvider?.baseUrl,
    state?.customProvider?.api,
  ]);
  const modelScopeRef = useRef(modelScope);
  modelScopeRef.current = modelScope;
  useEffect(() => setModels([]), [modelScope]);
  const loadModels = async (force: boolean): Promise<ModelListResult> => {
    const response = await runtime<ModelListResult>("models", {
      refresh: force,
    });
    if (modelScope !== modelScopeRef.current)
      throw new Error("模型服务已变化，请重新打开列表");
    setModels(response.models);
    return response;
  };
  const currentModel = models.find((model) => model.model === state?.model);
  const effortOptions = [...defaultEfforts];
  if (state?.effort && !effortOptions.some(([value]) => value === state.effort))
    effortOptions.unshift([state.effort, state.effort]);
  const shownChanges = fileChanges.filter(
    (item) =>
      item.folderId === folder?.id &&
      item.conversationId === (state?.conversationId ?? null),
  );
  const shown = doc?.circuits.find((c) => c.name === circuit);
  const readable = Boolean(
    shown && (shown.components.length || shown.wires.length),
  );
  const locked = !ready || pending || busy;
  return (
    <div
      className="chat"
      style={visible ? undefined : { display: "none" }}
      // Files dragged from the tree or the desktop become references here.
      data-reference-drop={ready ? "" : undefined}
    >
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
            await loadConversations();
          }}
        />
      )}
      <div className="chat-header">
        <ConversationPicker
          conversations={conversations}
          active={state?.conversationId || null}
          disabled={locked}
          onSelect={(id) => switchConversation("select", id)}
          onRestore={(id) => switchConversation("restore", id)}
        />
        <button
          title="新建对话"
          aria-label="新建对话"
          disabled={locked}
          onClick={() => switchConversation("new")}
        >
          <Plus size={15} />
        </button>
        <details className="menu">
          <summary aria-label="对话操作" title="对话操作">
            <MoreHorizontal size={16} />
          </summary>
          <div className="menu-content">
            <button
              disabled={locked || !state?.conversationId}
              onClick={() => setRenameConversation(true)}
            >
              重命名…
            </button>
            <button
              disabled={locked || !state?.conversationId}
              onClick={() =>
                switchConversation(
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
          title="AI 设置"
          aria-label="AI 设置"
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
          {!runtimeError && state?.modelConfigurationError ? (
            <button onClick={() => setConfigure(true)}>
              {state.services.length ? "选择模型服务" : "添加模型服务"}
            </button>
          ) : (
            <button onClick={() => void reconnect()}>重新连接</button>
          )}
        </div>
      )}
      {configure && (
        <ProviderSettings
          services={state?.services || []}
          provider={state?.customProvider || null}
          defaultServiceId={state?.defaultServiceId}
          conversationId={ready ? state?.conversationId : null}
          hasHistory={messages.some((message) => message.type === "user")}
          configurationError={state?.modelConfigurationError?.message}
          busy={pending || busy}
          request={runtime}
          onSaved={async () => {
            setModels([]);
            await refresh();
          }}
          onClose={() => setConfigure(false)}
        />
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
          {(!ready || !messages.length) && (
            <div className="quiet-empty">
              {!state ? (
                runtimeError ? (
                  ""
                ) : (
                  "正在连接 AI…"
                )
              ) : !state.services.length ? (
                <div className="chat-card">
                  <span>添加一个模型服务后开始对话。</span>
                  <button
                    className="primary"
                    onClick={() => setConfigure(true)}
                  >
                    连接 AI
                  </button>
                </div>
              ) : draft.trim() ? (
                "描述要完成的电路，或选中元件后提问。"
              ) : (
                <div className="conversation-starters">
                  {starterActions(
                    Boolean(shown) && !readable,
                    readable,
                    selection.length > 0,
                  ).map((starter) => (
                    <button
                      key={starter.id}
                      className="conversation-starter"
                      title="立即发送"
                      disabled={
                        locked || references.pending || !state.available
                      }
                      onClick={() => {
                        // The ordinary send path keeps the prompt editable if it fails.
                        changeDraft(starter.prompt);
                        send(starter.prompt);
                      }}
                    >
                      <starter.icon size={16} />
                      <span>{starter.label}</span>
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {(ready ? messages : []).map((m, index) =>
            m.type === "activity" ? (
              index > 0 && messages[index - 1].type === "activity" ? null : (
                <ActivityBatch
                  key={m.id}
                  messages={messages.slice(
                    index,
                    messages.findIndex(
                      (item, next) => next > index && item.type !== "activity",
                    ) < 0
                      ? undefined
                      : messages.findIndex(
                          (item, next) =>
                            next > index && item.type !== "activity",
                        ),
                  )}
                />
              )
            ) : m.type === "reasoning" ? (
              <details className="message reasoning" key={m.id}>
                <summary>思考过程</summary>
                {m.text}
              </details>
            ) : m.type === "user" || m.type === "assistant" ? (
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
                      onClick={resubmit}
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
                                  .find((message) => message.type === "user")
                                  ?.context,
                            })
                        : undefined
                    }
                  />
                ) : (
                  m.text
                )}
                {references.renderContext(m.context)}
                {!editingMessage && (
                  <div className="message-actions">
                    <CopyButton text={m.text || ""} onError={onError} />
                    {!busy && m.canEdit && (
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
                  </div>
                )}
              </div>
            ) : null,
          )}
          {state?.transmission && (
            <div className="error-bar">{state.transmission.message}</div>
          )}
          {ready &&
            shownChanges.map((item) => (
              <div className="chat-card" key={item.change.id}>
                <span>
                  <strong>AI 改动了 {item.change.files.length} 个文件</strong>
                  <ul>
                    {item.change.files.map((file) => (
                      <li key={file.path}>
                        <small>{kindNames[file.kind] || file.kind}</small>
                        {file.path}
                      </li>
                    ))}
                  </ul>
                </span>
                {item.undone ? (
                  <small>已撤销</small>
                ) : (
                  <button
                    disabled={pending || busy || !item.change.undoable}
                    title={
                      item.change.undoable
                        ? undefined
                        : "包含未保留内容的大文件"
                    }
                    onClick={() => undoFiles(item)}
                  >
                    <Undo2 size={13} />
                    撤销
                  </button>
                )}
              </div>
            ))}
        </div>
      </div>
      {!scroll.following && <FollowLatest onClick={scroll.latest} />}
      <div className={"composer" + (referenceDrop ? " is-reference-drop" : "")}>
        {references.composer}
        <textarea
          value={draft}
          onChange={(e) => changeDraft(e.target.value)}
          placeholder="描述你的想法…"
          aria-label="消息"
          disabled={!ready}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
        />
        <footer>
          <ModelPicker
            scope={modelScope}
            model={state?.model || null}
            name={currentModel?.name || currentModel?.label}
            disabled={!ready || pending}
            busy={busy}
            configurationError={state?.modelConfigurationError?.message}
            load={loadModels}
            select={async (model) => {
              await runtime("selectModel", {
                model: model.model,
                effort: model.efforts
                  ? model.efforts.some((entry) => entry.value === state?.effort)
                    ? state?.effort
                    : (model.defaultEffort ?? null)
                  : state?.effort || "none",
              });
              await refresh();
            }}
          />
          <select
            aria-label="思考深度"
            value={state?.effort || "none"}
            disabled={locked || !state?.model}
            onChange={(e) =>
              void runtime("selectModel", {
                model: state?.model,
                effort: e.target.value,
              })
                .then(() => refresh())
                .catch(onError)
            }
          >
            {effortOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {busy && draft.trim() && (
            <button
              aria-label="追加意见"
              title="追加意见"
              disabled={
                !ready || pending || references.pending || !state?.canSteer
              }
              onClick={() => send()}
            >
              <Send size={15} />
            </button>
          )}
          {busy ? (
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
                !ready ||
                !draft.trim() ||
                references.pending ||
                pending ||
                !state?.available
              }
              onClick={() => send()}
            >
              <Send size={15} />
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
