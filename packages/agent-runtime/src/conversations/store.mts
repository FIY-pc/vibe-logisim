import type {
  ConversationRecord,
  ConversationIndex,
  ConversationWorkspace,
  ConversationChange,
  RuntimeMessage,
} from "./types.mts";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
const SCHEMA = "vibe-logisim.conversations/v2";

/**
 * Conversations per workspace key (a folder, a lone document or the app), kept
 * as one JSON file. The file is read once; this process is its only writer, so
 * later reads use the copy in memory and every write saves that copy.
 */
class ConversationStore {
  declare file: string | undefined;
  declare memory: ConversationIndex | null;

  constructor(file?: string) {
    this.file = file;
    this.memory = null;
  }
  read(): ConversationIndex {
    if (this.memory) return this.memory;
    if (!this.file) return (this.memory = { schema: SCHEMA, workspaces: {} });
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        data.schema !== SCHEMA ||
        !data.workspaces ||
        typeof data.workspaces !== "object"
      )
        throw new Error("Unknown schema");
      for (const workspace of Object.values(
        data.workspaces,
      ) as ConversationWorkspace[]) {
        if (
          !workspace ||
          typeof workspace.activeId !== "string" ||
          !workspace.conversations?.[workspace.activeId]
        )
          throw new Error("Invalid workspace");
        for (const record of Object.values(workspace.conversations))
          if (!record || !Array.isArray(record.messages))
            throw new Error("Invalid conversation");
      }
      return (this.memory = data);
    } catch (error: any) {
      if (error.code === "ENOENT")
        return (this.memory = { schema: SCHEMA, workspaces: {} });
      throw new Error("无法读取对话记录，原文件仍保留。请重试");
    }
  }
  write(data: ConversationIndex) {
    this.memory = data;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
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
  /** The active conversation of a workspace, created when the key is new. */
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
  state(key: string) {
    const data = this.read(),
      w = this.workspace(data, key);
    return {
      activeId: w.activeId,
      conversations: Object.values(w.conversations)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          archived: Boolean(c.archived),
          preview:
            c.messages.find((m) => m.type === "user")?.text?.slice(0, 160) ||
            "",
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
        !current.messages.length &&
        !current.customTitle
      )
        return this.state(key);
      if (
        !current.messages.length &&
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
              .filter((c) => !c.archived)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ||
            this.blank();
          w.conversations[next.id] = next;
          w.activeId = next.id;
        }
      } else throw new Error("未知的对话操作");
    }
    this.write(data);
    return this.state(key);
  }
  /** Saves the active conversation's messages and model transcript. */
  remember(
    key: string,
    {
      messages,
      data: patch,
      expectedId,
    }: {
      messages: RuntimeMessage[];
      data: Partial<ConversationRecord>;
      expectedId: string | null;
    },
  ) {
    const data = this.read(),
      w = this.workspace(data, key),
      record = w.conversations[w.activeId];
    if (expectedId && record.id !== expectedId)
      throw new Error("当前对话已变化，未覆盖旧记录");
    Object.assign(record, structuredClone(patch));
    record.messages = structuredClone(messages);
    if (!record.customTitle && !record.titleGenerated) {
      const first = record.messages.find((m) => m.type === "user")?.text;
      if (first) {
        record.title = first.replace(/\s+/g, " ").trim().slice(0, 60);
        record.titleGenerated = true;
      }
    }
    record.updatedAt = new Date().toISOString();
    this.write(data);
  }
}

export { ConversationStore };
