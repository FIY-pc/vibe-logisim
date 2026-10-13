import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ConversationStore } = require("../core/conversation-store.cjs");
const {
  createContextTransfer,
  historyContext: textHistoryContext,
} = require("../core/context-transfer.cjs");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function source(file: string) {
  if (typeof file !== "string" || !file)
    throw new Error("请选择旧版 sessions.json");
  const location = await realpath(file);
  if ((await stat(location)).size > 64 * 1024 * 1024)
    throw new Error("对话文件超过 64 MB");
  const text = await readFile(location, "utf8");
  if (Buffer.byteLength(text) > 64 * 1024 * 1024)
    throw new Error("对话文件超过 64 MB");
  const data = JSON.parse(text);
  if (
    ![
      "vibe-logisim.codex-sessions/v0",
      "vibe-logisim.codex-sessions/v1",
    ].includes(data.schema) ||
    !data.workspaces ||
    Array.isArray(data.workspaces)
  )
    throw new Error("不是可识别的旧版对话文件");
  const store = new ConversationStore(null);
  store.memory = data;
  // Upgrade v0 in memory using the same shape as the original store; never write the source.
  if (data.schema.endsWith("/v0")) {
    data.schema = "vibe-logisim.codex-sessions/v1";
    data.workspaces = Object.fromEntries(
      Object.entries(data.workspaces).map(([key, value]) => [
        key,
        {
          activeId: "legacy",
          conversations: {
            legacy: {
              ...store.blank("legacy"),
              ...(value as object),
              id: "legacy",
              title: "之前的对话",
            },
          },
        },
      ]),
    );
  }
  for (const w of Object.values(data.workspaces) as any[]) {
    if (!w || !w.conversations || Array.isArray(w.conversations))
      throw new Error("旧版对话索引不完整");
    for (const [id, c] of Object.entries(w.conversations) as [string, any][]) {
      if (
        !c ||
        c.id !== id ||
        !Array.isArray(c.messages) ||
        c.messages.some(
          (m: any) =>
            !m || typeof m.id !== "string" || typeof m.type !== "string",
        )
      )
        throw new Error("旧版对话内容不完整");
      if (c.runtime && !["builtin", "codex"].includes(c.runtime))
        throw new Error("旧版对话使用了未知运行时");
    }
  }
  return { location, revision: hash(text), data };
}
export async function previewHistory(file: string) {
  const { location, revision, data } = await source(file);
  return {
    file: location,
    revision,
    workspaces: Object.entries(data.workspaces).map(
      ([key, w]: [string, any]) => ({
        key,
        count: Object.keys(w.conversations).length,
        titles: Object.values(w.conversations)
          .filter((c: any) => c.messages.length)
          .slice(0, 3)
          .map((c: any) => c.title || "未命名对话"),
      }),
    ),
  };
}
export async function importHistory(
  store: any,
  args: { file: string; revision: string; sourceKey: string },
  targetKey: string,
) {
  const { location, revision, data } = await source(args.file);
  if (revision !== args.revision) throw new Error("旧版记录已改变，请重新预览");
  const sourceWorkspace = data.workspaces[args.sourceKey];
  if (!sourceWorkspace) throw new Error("找不到所选记录");
  const target = store.read(),
    workspace = store.workspace(target, targetKey);
  let imported = 0,
    skipped = 0;
  for (const record of Object.values(sourceWorkspace.conversations) as any[]) {
    const id =
      "import-" +
      hash(location + "\n" + args.sourceKey + "\n" + record.id).slice(0, 32);
    if (Object.hasOwn(workspace.conversations, id)) {
      skipped++;
      continue;
    }
    const runtime = record.runtime || "codex";
    const copy: any = {
      ...store.blank(id),
      title: String(record.title || "之前的对话"),
      customTitle: true,
      createdAt:
        typeof record.createdAt === "string" &&
        Number.isFinite(Date.parse(record.createdAt))
          ? record.createdAt
          : new Date().toISOString(),
      updatedAt:
        typeof record.updatedAt === "string" &&
        Number.isFinite(Date.parse(record.updatedAt))
          ? record.updatedAt
          : new Date().toISOString(),
      archived: Boolean(record.archived),
      runtime,
      messages: record.messages,
      migration: {
        sourceId: record.id,
        sourceRuntime: runtime,
        sourceThreadId:
          typeof record.threadId === "string" ? record.threadId : null,
        requiresContext: runtime === "codex" || !record.runtimeMessages?.length,
      },
    };
    if (runtime === "codex") {
      copy.contextTransfer = createContextTransfer(
        record.messages,
        "history-import",
        [
          ...(record.supersededThreadIds || []),
          ...(record.contextTransfer?.sourceThreadIds || []),
          record.threadId,
        ],
      );
    }
    if (runtime === "builtin") {
      copy.runtimeMessages = Array.isArray(record.runtimeMessages)
        ? record.runtimeMessages
        : [];
      copy.runtimeSelection = record.runtimeSelection || null;
      // Unfinished queued requests must never execute just because records were imported.
      copy.runtimeQueued = [];
      copy.runtimeCheckpoints = {};
    }
    workspace.conversations[id] = copy;
    imported++;
  }
  store.write(target);
  return { imported, skipped };
}
export function historyContext(record: any) {
  if (!record?.migration?.requiresContext) return null;
  return textHistoryContext(record.messages, "history-import").context;
}
