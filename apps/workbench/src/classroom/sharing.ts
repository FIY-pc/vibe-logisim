import { command } from "../shared/transport";
import type { Document } from "../shared/types";
import { credentialPattern } from "../../../../packages/agent-runtime/src/models/public-fields.mts";
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
let cachedCircuit: { key: string; xml: string; image: string } | undefined;
export function sharedMessages(messages: any[]): SharedMessage[] {
  return messages
    .filter((m) => ["user", "assistant", "activity"].includes(m.type))
    .slice(-1000)
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
    }))
    .map((m) => ({
      ...m,
      text:
        m.text.length > 20000
          ? m.text.slice(0, 19980) + "\n[记录已截断]"
          : m.text,
    }))
    .map((m) => ({
      ...m,
      text: m.text.replace(
        new RegExp(credentialPattern.source, "gi"),
        "[密钥已隐藏]",
      ),
    }))
    .reverse()
    .filter(
      (() => {
        let used = 0;
        return (m: SharedMessage) => (used += m.text.length) <= 500000;
      })(),
    )
    .reverse();
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
  if (doc.path && before.folder?.path) {
    const clean = (s: string) =>
      s
        .replace(/^\\\\\?\\/, "")
        .replace(/\\/g, "/")
        .replace(/\/+$/, "");
    let root = clean(before.folder.path),
      file = clean(doc.path);
    if (/^[A-Za-z]:/.test(root) || root.startsWith("//")) {
      root = root.toLowerCase();
      file = file.toLowerCase();
    }
    if (!file.startsWith(root + "/"))
      throw new Error("当前电路不属于课堂绑定的工作文件夹，已暂停同步");
  }
  const key = `${folderId}:${doc.id}:${doc.revision}:${doc.main}`;
  const source =
    cachedCircuit?.key === key
      ? cachedCircuit
      : await command<{ xml: string }>({
          op: "source",
          id: doc.id,
          revision: doc.revision,
        });
  if (typeof source.xml !== "string" || !source.xml.trim())
    throw new Error("未读取到电路 XML，请重新打开电路");
  if (source.xml.length > 8 * 1024 * 1024)
    throw new Error("电路 XML 超过 8 MB，请拆分过大的电路文件");
  const render =
    cachedCircuit?.key === key
      ? cachedCircuit
      : await command<{ image: string }>({
          op: "render",
          id: doc.id,
          revision: doc.revision,
          circuit: doc.main,
        });
  if (render.image.length > 1024 * 1024)
    throw new Error("电路预览超过 1 MB，请缩小电路后再共享");
  cachedCircuit = { key, xml: source.xml, image: render.image };
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
    messages = sharedMessages(history.messages || []);
  }
  const after = await command<any>({ op: "status", summary: true });
  if (after.folder?.id !== folderId)
    throw new Error("工作文件夹已变化，请重新预览");
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
    },
  };
}
