import { command } from "../shared/transport";
import type { Document } from "../shared/types";
import type {
  WorkSnapshot,
  SharedMessage,
} from "../../../../packages/classroom/src/types";
export interface ShareTarget {
  documentId: string;
  folderId: string;
  conversationId: string | null;
  includeConversation: boolean;
}
export interface PreparedWork {
  snapshot: WorkSnapshot;
  target: ShareTarget;
}
export function sharedMessages(messages: any[]): SharedMessage[] {
  return messages
    .filter((m) => ["user", "assistant", "activity"].includes(m.type))
    .map((m) => ({
      id: String(m.id),
      type: m.type,
      text:
        m.type === "activity"
          ? [m.label, m.detail, m.toolOutput?.text].filter(Boolean).join("\n")
          : String(m.text || ""),
      ...(m.resultStatus || m.status
        ? { status: String(m.resultStatus || m.status) }
        : {}),
    }));
}
/** Explicit capture of one document and one folder-bound conversation. No profile, credentials or other files. */
export async function prepareWork(
  documentId: string,
  includeConversation: boolean,
  expected?: ShareTarget,
): Promise<PreparedWork> {
  const before = await command<any>({ op: "status", summary: true });
  const folderId = before.folder?.id;
  if (!folderId || (expected && folderId !== expected.folderId))
    throw new Error("工作文件夹已变化，请重新预览共享内容");
  const doc = await command<Document>({ op: "read", id: documentId });
  const source = await command<{ xml: string }>({
    op: "source",
    id: doc.id,
    revision: doc.revision,
  });
  const render = await command<{ image: string }>({
    op: "render",
    id: doc.id,
    revision: doc.revision,
    circuit: doc.main,
  });
  if (render.image.length > 1024 * 1024)
    throw new Error("电路预览超过 1 MB，请缩小电路后再共享");
  let messages: SharedMessage[] = [],
    conversationId: string | null = null;
  if (includeConversation) {
    const history = await command<any>({
      op: "agent",
      method: "history",
      args: {},
    });
    if (history.busy)
      throw Object.assign(new Error("请等待当前 AI 回合结束后共享"), {
        code: "SHARING_BUSY",
      });
    if (history.workspaceKey !== folderId)
      throw new Error("对话尚未绑定当前文件夹，请先打开右侧对话栏");
    conversationId = history.conversationId;
    if (expected && conversationId !== expected.conversationId)
      throw new Error("当前对话已变化，自动共享已暂停，请重新预览");
    messages = sharedMessages(history.messages || []);
  }
  const after = await command<any>({ op: "status", summary: true });
  if (after.folder?.id !== folderId)
    throw new Error("工作文件夹已变化，请重新预览");
  if (messages.length > 1000 || messages.some((m) => m.text.length > 20000))
    throw new Error(
      "当前对话超过共享上限（1000 条，每条 20000 字），请取消共享对话或使用较短的对话",
    );
  return {
    target: { documentId, folderId, conversationId, includeConversation },
    snapshot: {
      image: render.image,
      name: doc.name,
      xml: source.xml,
      revision: doc.revision,
      circuit: doc.main,
      components: doc.circuits.reduce((n, c) => n + c.components.length, 0),
      wires: doc.circuits.reduce((n, c) => n + c.wires.length, 0),
      conversationId,
      messages,
      status: "working",
      progress: 0,
      note: "",
    },
  };
}
