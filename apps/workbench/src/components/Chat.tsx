import type { LocateChange } from "../lib/reviewTypes";
import { useProposals } from "../lib/useProposals";
import { useChatReferences } from "./ChatReferences";
import type { Quotation } from "../lib/references";
import { eventBinding } from "../lib/shortcuts";
import { ProviderSettings } from "./ProviderSettings";
import {
  ModelPicker,
  type ModelOption,
  type ModelListResult,
} from "./ModelPicker";
import { ProposalReview, type SourceProposal } from "./ProposalReview";
import { TextPrompt } from "./TextPrompt";
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
  MoreHorizontal,
  ArrowUpRight,
  BookOpen,
  CircuitBoard,
  ScanSearch,
  Timer,
} from "lucide-react";
import { command } from "../lib/transport";
import type { Document } from "../lib/types";
interface RuntimeState {
  eventCursor: number;
  canSteer?: boolean;
  turnId?: string;
  contextTransfer?: {
    pending: boolean;
    truncated: boolean;
  } | null;
  runtime: "builtin" | "codex";
  status: string;
  available: boolean;
  detail?: string | null;
  account?: { email?: string } | null;
  signingIn?: boolean;
  defaultRuntime?: "builtin" | "codex";
  defaultServiceId?: string | null;
  accountMode?: string;
  inheritedModel?: string | null;
  modelSelection?: { model: string; effort: string | null } | null;
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
  /** A dragged file is over the conversation. */
  referenceDrop?: boolean;
  composerAttachmentSlot?: ReactNode;
  renderMessageContext?: (message: Message) => ReactNode;
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
export function Chat({
  visible,
  doc,
  circuit,
  onError,
  onDocument,
  folder,
  quotation,
  onQuoted,
  referenceDrop,
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
    [models, setModels] = useState<ModelOption[]>([]);
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
  const conversationScope = useRef({ workspaceKey, epoch: 0 });
  if (conversationScope.current.workspaceKey !== workspaceKey)
    conversationScope.current = {
      workspaceKey,
      epoch: conversationScope.current.epoch + 1,
    };
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
  const refreshConversations = async (
    key: string,
    isCurrent: () => boolean = () => true,
  ) => {
    const epoch = ++conversationScope.current.epoch;
    const result = await runtime<{
      workspaceKey?: string;
      conversations: ConversationSummary[];
    }>("conversations");
    if (
      isCurrent() &&
      conversationScope.current.epoch === epoch &&
      conversationScope.current.workspaceKey === key &&
      binding.current === key &&
      result &&
      (!result.workspaceKey || result.workspaceKey === key)
    )
      setConversations(result.conversations);
  };
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
      else if (e.type === "conversations-changed") {
        if (
          (e.workspaceKey || binding.current) ===
          conversationScope.current.workspaceKey
        ) {
          // A newer rename/selection event supersedes any pending list snapshot.
          conversationScope.current.epoch++;
          setConversations(e.conversations || []);
        }
      } else if (e.type === "runtime-error") {
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
      await refreshConversations(key, () => live);
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
  const scroll = useConversationScroll(scroller, draftKey, visible, messages);
  const send = async (text = draft) => {
    if (
      !doc ||
      !documentReady ||
      !text.trim() ||
      actionPending.current ||
      references.pending
    )
      return;
    const receipt = { key: draftKey, text };
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
          question: text,
          references: attachmentReceipt.ids,
          documentId: doc.id,
          circuit,
          selection,
          expectedTurnId: state?.busy ? state.turnId : undefined,
        });
        acknowledgeDraft(receipt);
        references.acknowledge(attachmentReceipt);
        await refresh();
        await refreshConversations(workspaceKey);
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
      void startConversation.current("new");
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
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
        await refreshConversations(workspaceKey);
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
    } finally {
      setPending(false);
    }
  };
  const login = () =>
    runtime<{ authUrl: string }>("login").then(async ({ authUrl }) => {
      if (desktop()) await openUrl(authUrl);
      else window.open(authUrl, "_blank", "noopener,noreferrer");
    });
  const modelScope = JSON.stringify([
    workspaceKey,
    state?.conversationId,
    state?.runtime,
    state?.customProvider?.id,
    state?.customProvider?.baseUrl,
    state?.customProvider?.api,
    state?.account?.email,
  ]);
  const modelScopeRef = useRef(modelScope);
  modelScopeRef.current = modelScope;
  useEffect(() => setModels([]), [modelScope]);
  const loadModels = async (force: boolean): Promise<ModelListResult> => {
    const scope = modelScope;
    const response = await runtime<ModelListResult>("models", {
      refresh: force,
    });
    if (scope !== modelScopeRef.current)
      throw new Error("模型服务已变化，请重新打开列表");
    setModels(response.models);
    return response;
  };
  const currentModel = models.find((model) => model.model === state?.model);
  const defaultEfforts = [
    ["none", "默认"],
    ["low", "轻度"],
    ["medium", "中"],
    ["high", "高"],
    ["xhigh", "极高"],
    ["max", "最高"],
  ];
  const effortLabels: Record<string, string> = Object.fromEntries([
    ...defaultEfforts,
    ["minimal", "最少"],
    ["ultra", "Ultra"],
  ]);
  const effortOptions =
    state?.runtime === "codex" && currentModel?.efforts
      ? currentModel.efforts.map((effort) => [
          effort.value,
          effortLabels[effort.value] || effort.value,
        ])
      : defaultEfforts;
  if (state?.effort && !effortOptions.some(([value]) => value === state.effort))
    effortOptions.unshift([
      state.effort,
      effortLabels[state.effort] || state.effort,
    ]);
  return (
    <div
      className="chat"
      style={visible ? undefined : { display: "none" }}
      // Files dragged from the tree or the desktop become references here.
      data-reference-drop={workspaceReady ? "" : undefined}
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
          <summary aria-label="对话操作" title="对话操作">
            <MoreHorizontal size={16} />
          </summary>
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
      {configure && (
        <ProviderSettings
          runtime={state?.runtime || "builtin"}
          services={state?.services || []}
          provider={state?.customProvider || null}
          defaultRuntime={state?.defaultRuntime}
          defaultServiceId={state?.defaultServiceId}
          conversationId={workspaceReady ? state?.conversationId : null}
          hasHistory={messages.some((message) => message.type === "user")}
          configurationError={state?.modelConfigurationError?.message}
          account={state?.account}
          signingIn={state?.signingIn}
          install={state?.runtimeInstall}
          busy={pending || Boolean(state?.busy)}
          request={runtime}
          onRuntime={chooseRuntime}
          onLogin={login}
          onSaved={async () => {
            setModels([]);
            await refresh();
          }}
          onClose={() => setConfigure(false)}
        />
      )}
      <>
        {state?.contextTransfer?.pending && (
          <div className="runtime-progress" role="status">
            {state.contextTransfer.truncated
              ? "运行时已更新，继续时会携带最近的对话。"
              : "运行时已更新，继续时会携带此前对话。"}
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
                  <div className="proposal">
                    <span>使用 API 密钥或 ChatGPT 账号。</span>
                    <button
                      className="primary"
                      onClick={() => setConfigure(true)}
                    >
                      连接 AI
                    </button>
                  </div>
                ) : state?.runtime === "codex" &&
                  state.status === "auth-required" ? (
                  <div className="proposal">
                    <span>本机 Codex 需要登录 ChatGPT 账号。</span>
                    <button
                      className="primary"
                      onClick={() => void login().catch(onError)}
                    >
                      登录 ChatGPT
                    </button>
                  </div>
                ) : draft.trim() ? (
                  "描述要完成的电路，或选中元件后提问。"
                ) : (
                  <div className="conversation-starters">
                    {(() => {
                      const shown = doc.circuits.find(
                        (c) => c.name === circuit,
                      );
                      const readable = Boolean(
                        shown &&
                        (shown.components.length || shown.wires.length),
                      );
                      return starterActions(
                        Boolean(shown) && !readable,
                        readable,
                        selection.length > 0,
                      );
                    })().map((starter) => (
                      <button
                        key={starter.id}
                        className="conversation-starter"
                        title="立即发送"
                        disabled={
                          !documentReady ||
                          pending ||
                          references.pending ||
                          !state?.available ||
                          Boolean(state?.busy)
                        }
                        onClick={() => {
                          // The ordinary send path keeps the prompt editable if it fails.
                          changeDraft(starter.prompt);
                          void send(starter.prompt);
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
            {(workspaceReady ? messages : []).map((m, index) =>
              m.type === "activity" ? (
                index > 0 && messages[index - 1].type === "activity" ? null : (
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
        <div
          className={"composer" + (referenceDrop ? " is-reference-drop" : "")}
        >
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
            <ModelPicker
              scope={modelScope}
              model={state?.model || null}
              name={currentModel?.name || currentModel?.label}
              disabled={!workspaceReady || pending}
              busy={Boolean(state?.busy)}
              configurationError={state?.modelConfigurationError?.message}
              inheritedModel={state?.inheritedModel}
              inheritLabel={
                state?.runtime === "codex" && !state.customProvider
                  ? state.accountMode === "application"
                    ? "默认模型"
                    : "跟随本机配置"
                  : undefined
              }
              inheritSelected={
                state?.runtime === "codex" &&
                !state.modelSelection &&
                !state.customProvider
              }
              load={loadModels}
              select={async (model) => {
                const effort = model?.efforts
                  ? model.efforts.some((entry) => entry.value === state?.effort)
                    ? state?.effort
                    : (model.defaultEffort ?? null)
                  : state?.effort || "none";
                await runtime(
                  "selectModel",
                  model ? { model: model.model, effort } : { inherit: true },
                );
                await refresh();
              }}
            />
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
              {effortOptions.map(([k, v]) => (
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
    </div>
  );
}
