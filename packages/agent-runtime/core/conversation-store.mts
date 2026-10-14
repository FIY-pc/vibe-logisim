import type {
  ConversationRecord,
  RuntimeKind,
  ConversationIndex,
  ConversationWorkspace,
  ConversationChange,
  ContextTransfer,
  RuntimeMessage,
  ProtocolObject,
} from "./types.mts";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
const SCHEMA = "vibe-logisim.conversations/v1";

// Workspace-owned conversations are local records. A Codex thread is attached
// lazily; creating, finding and organizing conversations never invokes a model.
class ConversationStore {
  declare defaultRuntime: RuntimeKind;
  declare file: string | undefined;
  declare memory: ConversationIndex | null;

  constructor(file?: string, defaultRuntime: RuntimeKind = "builtin") {
    this.defaultRuntime = defaultRuntime;
    this.file = file;
    this.memory = null;
  }
  read(): ConversationIndex {
    if (!this.file) return this.memory || { schema: SCHEMA, workspaces: {} };
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        data.schema === SCHEMA &&
        data.workspaces &&
        typeof data.workspaces === "object"
      ) {
        for (const workspace of Object.values(
          data.workspaces,
        ) as ConversationWorkspace[]) {
          if (
            !workspace ||
            typeof workspace.activeId !== "string" ||
            !workspace.conversations?.[workspace.activeId]
          )
            throw new Error("Invalid workspace");
          for (const record of Object.values(workspace.conversations)) {
            if (
              !record ||
              !["builtin", "codex"].includes(record.runtime) ||
              !Array.isArray(record.messages) ||
              !record.messageContexts
            )
              throw new Error("Invalid conversation");
          }
        }
        return data;
      }
      throw new Error("Unknown schema");
    } catch (error: any) {
      if (error.code === "ENOENT") return { schema: SCHEMA, workspaces: {} };
      throw new Error("无法读取对话记录，原文件仍保留。请重试");
    }
  }
  write(data: ConversationIndex) {
    if (!this.file) {
      this.memory = structuredClone(data);
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const next = data;
    const temp = this.file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, this.file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  blank(id: string = randomUUID()): ConversationRecord {
    const now = new Date().toISOString();
    return {
      id,
      title: "新对话",
      createdAt: now,
      updatedAt: now,
      archived: false,
      runtime: this.defaultRuntime,
      threadId: null,
      toolContract: null,
      messageContexts: {},
      messages: [],
    };
  }
  workspace(data: ConversationIndex, key: string): ConversationWorkspace {
    if (typeof key !== "string" || !key) throw new Error("请先打开文件夹");
    if (!Object.hasOwn(data.workspaces, key)) {
      const first = this.blank();
      data.workspaces[key] = {
        activeId: first.id,
        conversations: { [first.id]: first },
      };
    }
    return data.workspaces[key];
  }
  ensure(key: string) {
    const data = this.read(),
      exists = Object.hasOwn(data.workspaces, key),
      w = this.workspace(data, key);
    if (!exists) this.write(data);
    return structuredClone(w.conversations[w.activeId]);
  }
  active(key: string) {
    const data = this.read(),
      w = data.workspaces[key];
    return w ? structuredClone(w.conversations[w.activeId]) : null;
  }
  get(key: string, id: string) {
    const w = this.read().workspaces[key];
    if (!w || !Object.hasOwn(w.conversations, id))
      throw new Error("对话不属于当前文件夹");
    return structuredClone(w.conversations[id]);
  }
  state(key: string) {
    const data = this.read(),
      w = this.workspace(data, key),
      current = w.conversations[w.activeId];
    return {
      activeId: w.activeId,
      conversation: structuredClone(current),
      conversations: Object.values(w.conversations)
        .sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt))
        .map((c: any) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          archived: Boolean(c.archived),
          preview:
            (c.messages || [])
              .find((m: any) => m.type === "user")
              ?.text?.slice(0, 160) || "",
        })),
    };
  }
  change(key: string, action: string, request: ConversationChange = {}) {
    const data = this.read(),
      w = this.workspace(data, key);
    let record: ConversationRecord;
    if (action === "new") {
      const current = w.conversations[w.activeId];
      // Repeated clicks on an unused blank conversation should not fill history.
      if (
        request.reuseEmpty &&
        !current.threadId &&
        !current.messages?.length &&
        !current.customTitle
      )
        return this.state(key);
      if (
        !current.messages?.length &&
        !current.customTitle &&
        typeof request.draftTitle === "string" &&
        request.draftTitle.trim()
      )
        current.title = request.draftTitle.trim().slice(0, 60);
      record = this.blank();
      w.conversations[record.id] = record;
      w.activeId = record.id;
    } else {
      if (!Object.hasOwn(w.conversations, request.id || ""))
        throw new Error("对话不属于当前文件夹");
      record = w.conversations[request.id!];
      if (action === "select") {
        if (record.archived) throw new Error("请先恢复这条已归档对话");
        w.activeId = record.id;
      } else if (action === "rename") {
        const title =
          typeof request.title === "string" ? request.title.trim() : "";
        if (!title || title.length > 100)
          throw new Error("对话名称须为 1–100 个字");
        record.title = title;
        record.customTitle = true;
      } else if (action === "archive" || action === "restore") {
        record.archived = action === "archive";
        if (record.archived && w.activeId === record.id) {
          const next =
            Object.values(w.conversations)
              .filter((c: any) => !c.archived)
              .sort((a: any, b: any) =>
                b.updatedAt.localeCompare(a.updatedAt),
              )[0] || this.blank();
          w.conversations[next.id] = next;
          w.activeId = next.id;
        }
      } else throw new Error("未知的对话操作");
    }
    this.write(data);
    return this.state(key);
  }
  runtimeData(
    key: string,
    patch: Partial<ConversationRecord>,
    expectedId?: string,
  ) {
    const data = this.read(),
      w = this.workspace(data, key),
      record = w.conversations[w.activeId];
    if (expectedId && record.id !== expectedId)
      throw new Error("当前对话已变化，未覆盖旧记录");
    Object.assign(record, structuredClone(patch));
    this.write(data);
    return structuredClone(record);
  }
  remember(
    key: string,
    {
      threadId,
      messages,
      messageId,
      context,
      toolContract,
      runtimeData,
      expectedId,
    }: {
      threadId?: string | null;
      messages?: RuntimeMessage[];
      messageId?: string;
      context?: ProtocolObject;
      toolContract?: ProtocolObject | null;
      runtimeData?: Partial<ConversationRecord>;
      expectedId?: string | null;
    },
  ) {
    const data = this.read(),
      w = this.workspace(data, key),
      record = w.conversations[w.activeId];
    if (record.threadId && threadId && record.threadId !== threadId)
      throw new Error("当前对话已变化，未覆盖旧记录");
    if (expectedId && record.id !== expectedId)
      throw new Error("当前对话已变化，未覆盖旧记录");
    if (runtimeData) Object.assign(record, structuredClone(runtimeData));
    if (threadId) record.threadId = threadId;
    if (toolContract !== undefined)
      record.toolContract = structuredClone(toolContract);
    if (messages) record.messages = structuredClone(messages);
    if (messageId)
      record.messageContexts[messageId] = structuredClone(context || {});
    if (!record.customTitle && !record.titleGenerated) {
      const first = record.messages.find((m: any) => m.type === "user")?.text;
      if (first) {
        record.title = first.replace(/\s+/g, " ").trim().slice(0, 60);
        record.titleGenerated = true;
      }
    }
    record.updatedAt = new Date().toISOString();
    this.write(data);
  }
  rebind(
    key: string,
    {
      threadId,
      messages,
      toolContract,
      contextTransfer,
      reason = "capability-updated",
    }: {
      threadId: string;
      messages?: RuntimeMessage[];
      toolContract?: ProtocolObject | null;
      contextTransfer?: ContextTransfer | null;
      reason?: string;
    },
  ) {
    const data = this.read(),
      w = this.workspace(data, key),
      record = w.conversations[w.activeId];
    if (!threadId || typeof threadId !== "string")
      throw new Error("新的原生会话无效");
    if (record.threadId && record.threadId !== threadId) {
      const old = Array.isArray(record.supersededThreadIds)
        ? record.supersededThreadIds
        : [];
      record.supersededThreadIds = [
        ...new Set([...old, record.threadId]),
      ].slice(-8);
    }
    record.threadId = threadId;
    record.toolContract = structuredClone(toolContract || null);
    if (contextTransfer !== undefined)
      record.contextTransfer = structuredClone(contextTransfer);
    if (messages) record.messages = structuredClone(messages);
    record.updatedAt = new Date().toISOString();
    record.lastRebind = { reason, at: record.updatedAt };
    this.write(data);
  }
  acknowledgeContextTransfer(
    key: string,
    {
      conversationId,
      threadId,
      transferId,
      turnId,
    }: {
      conversationId: string;
      threadId: string;
      transferId: string;
      turnId: string;
    },
  ) {
    const data = this.read(),
      record = data.workspaces[key]?.conversations[conversationId];
    if (
      !record ||
      record.threadId !== threadId ||
      !record.contextTransfer ||
      record.contextTransfer.id !== transferId
    )
      return null;
    record.contextTransfer.pending = false;
    record.contextTransfer.acknowledgedTurnId = turnId;
    this.write(data);
    return structuredClone(record.contextTransfer);
  }
  replaceHistory(
    key: string,
    {
      threadId,
      messages,
      messageContexts = {},
      contextTransfer,
    }: {
      threadId?: string | null;
      messages?: RuntimeMessage[];
      messageContexts?: Record<string, ProtocolObject>;
      contextTransfer?: ContextTransfer | null;
    },
  ) {
    const data = this.read(),
      w = this.workspace(data, key),
      record = w.conversations[w.activeId];
    if (record.threadId && threadId && record.threadId !== threadId)
      throw new Error("当前对话已变化，未覆盖旧记录");
    if (threadId) record.threadId = threadId;
    record.messages = structuredClone(messages || []);
    record.messageContexts = structuredClone(messageContexts || {});
    if (contextTransfer !== undefined)
      record.contextTransfer = structuredClone(contextTransfer);
    if (!record.customTitle && !record.titleGenerated) {
      const first = record.messages.find((m: any) => m.type === "user")?.text;
      if (first) {
        record.title = first.replace(/\s+/g, " ").trim().slice(0, 60);
        record.titleGenerated = true;
      }
    }
    record.updatedAt = new Date().toISOString();
    this.write(data);
  }
  fork(
    key: string,
    {
      sourceId,
      sourceThreadId,
      messageId,
      turnId,
      threadId,
      messages,
      messageContexts,
      toolContract,
    }: {
      sourceId: string;
      sourceThreadId: string | null;
      messageId: string;
      turnId: string | null;
      threadId: string;
      messages: RuntimeMessage[];
      messageContexts: Record<string, ProtocolObject>;
      toolContract: ProtocolObject | null;
    },
  ) {
    const data = this.read(),
      w = this.workspace(data, key),
      source = w.conversations[w.activeId];
    if (
      source.id !== sourceId ||
      source.threadId !== sourceThreadId ||
      !threadId ||
      threadId === sourceThreadId
    ) {
      throw new Error("原对话已变化，未切换到新分支");
    }
    const base = source.title.slice(0, 80) + " · 分支";
    const titles = new Set(
      Object.values(w.conversations).map((c: any) => c.title),
    );
    let title = base,
      n = 2;
    while (titles.has(title)) title = base + " " + n++;
    const child: ConversationRecord = {
      ...this.blank(),
      title,
      titleGenerated: true,
      threadId,
      toolContract: structuredClone(toolContract || null),
      messages,
      messageContexts,
      forkedFrom: {
        conversationId: sourceId,
        threadId: sourceThreadId,
        messageId,
        turnId,
      },
    };
    if (source.contextTransfer)
      child.contextTransfer = structuredClone(source.contextTransfer);
    w.conversations[child.id] = child;
    w.activeId = child.id;
    this.write(data);
    return this.state(key);
  }
}

export { ConversationStore };
