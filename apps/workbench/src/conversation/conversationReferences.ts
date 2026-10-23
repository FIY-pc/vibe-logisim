import { useRef } from "react";
import { command } from "../shared/transport";
import type { Document } from "../shared/types";
import {
  documentComponent,
  documentWire,
  type ConnectionFocus,
} from "../editor/connectivity";
import type { ProjectFolder } from "../workspace/Files";
import type { PreviewFile } from "../workspace/FilePreview";
export interface ReferenceContext {
  projectId?: string;
  revisionId?: string;
  circuit?: string;
  folderId?: string;
  pathVersion?: number;
}
type CircuitReference = {
  kind: "circuit";
  projectId?: string;
  revisionId?: string;
  circuit?: string;
  componentId?: string;
  wireId?: string;
  sessionId?: string;
  instancePath?: string;
};
type FileReference = {
  kind: "file";
  path: string;
  page: number;
  pathVersion?: number;
};
export type ConversationReference =
  CircuitReference | FileReference | { kind: "web"; href: string };
function relativePath(path: string | null) {
  if (
    !path ||
    /[\\\u0000-\u001f\u007f]|%2e|%2f|%5c|%00/i.test(path) ||
    path.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("文件引用路径无效");
  return path;
}
function integer(value: string | null, minimum: number) {
  if (value === null) return undefined;
  const result = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < minimum)
    throw new Error("文件引用版本或页码无效");
  return result;
}
export function parseConversationReference(
  value: string,
): ConversationReference {
  if (!value || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error("引用无效");
  if (/^https?:\/\//i.test(value)) {
    new URL(value);
    return { kind: "web", href: value };
  }
  if (/^circuit:\/\/object\?/i.test(value)) {
    const url = new URL(value),
      params = url.searchParams;
    if (
      url.hash ||
      [...params.keys()].some((key) => params.getAll(key).length !== 1)
    )
      throw new Error("引用参数无效");
    return { ...Object.fromEntries(params), kind: "circuit" };
  }
  if (/^workspace:\/\//i.test(value)) {
    // The host emits a case-sensitive workspace-relative path, not a URL host.
    // Parse before decoding so URL normalization cannot hide path traversal.
    const [encoded, query, extra] = value
      .slice("workspace://".length)
      .split("?");
    if (!encoded || extra !== undefined || value.includes("#"))
      throw new Error("文件引用参数无效");
    const params = new URLSearchParams(query);
    if (
      [...params.keys()].some(
        (key) =>
          !["pathVersion", "page"].includes(key) ||
          params.getAll(key).length !== 1,
      )
    )
      throw new Error("文件引用参数无效");
    return {
      kind: "file",
      path: relativePath(decodeURIComponent(encoded)),
      page: integer(params.get("page"), 1) || 1,
      pathVersion: integer(params.get("pathVersion"), 0),
    };
  }
  let path: string;
  try {
    path = decodeURIComponent(value);
  } catch {
    throw new Error("文件引用路径无效");
  }
  if (path.startsWith("./")) path = path.slice(2);
  if (/[?#]/.test(path)) throw new Error("文件引用路径无效");
  return { kind: "file", path: relativePath(path), page: 1 };
}
export async function locateCircuitReference(
  reference: CircuitReference,
  context: ReferenceContext | undefined,
  doc: Document,
) {
  if ((reference.projectId || context?.projectId) !== doc.id)
    throw new Error("电路引用属于另一份文档，请先打开对应电路");
  if ((reference.revisionId || context?.revisionId) !== doc.revision)
    throw new Error("电路已改变，这条引用属于此前版本；请重新指认当前对象");
  const circuit = doc.circuits.find(
    (item) => item.name === (reference.circuit || context?.circuit),
  );
  if (!circuit || (!reference.componentId && !reference.wireId))
    throw new Error("电路引用缺少有效的电路或对象");
  let id = reference.componentId
    ? circuit.components.find((item) => item.id === reference.componentId)?.id
    : circuit.wires.find((item) => item.id === reference.wireId)?.id;
  if (!id) {
    const { focus } = await command<{ focus: ConnectionFocus }>({
      op: "observe",
      id: doc.id,
      revision: doc.revision,
      circuit: circuit.name,
    });
    // Native observer IDs are coordinate-derived. Resolve via factory/location
    // in the named circuit, never by an array index or a matching label alone.
    if (reference.componentId) {
      const native = focus.components.filter(
        (item) => item.componentId === reference.componentId,
      );
      if (native.length === 1) id = documentComponent(circuit, native[0])?.id;
    } else {
      const native = (focus.wires || []).filter(
        (item) => item.wireId === reference.wireId,
      );
      if (native.length === 1) id = documentWire(circuit, native[0])?.id;
    }
  }
  if (!id) throw new Error("引用的对象不存在，或同位置对象无法唯一确定");
  return {
    circuit: circuit.name,
    id,
    runtimeReference: Boolean(reference.sessionId),
  };
}
export function useConversationReferences({
  doc,
  folder,
  onCircuit,
  onDocument,
  onPreview,
  onNotice,
  onError,
}: {
  doc: Document | null;
  folder: ProjectFolder | null;
  onCircuit: (name: string, id: string) => void;
  onDocument: (doc: Document) => void;
  onPreview: (file: PreviewFile) => void;
  onNotice: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const live = useRef({ doc, folder });
  live.current = { doc, folder };
  const epoch = useRef(0);
  return (href: string, context?: ReferenceContext) => {
    const ticket = ++epoch.current,
      captured = { doc, folder };
    const current = () =>
      ticket === epoch.current &&
      live.current.doc?.id === captured.doc?.id &&
      live.current.doc?.revision === captured.doc?.revision &&
      live.current.folder?.id === captured.folder?.id;
    void (async () => {
      const reference = parseConversationReference(href);
      if (reference.kind === "web") return;
      if (reference.kind === "circuit") {
        if (!doc) throw new Error("请先打开引用所属的电路");
        const target = await locateCircuitReference(reference, context, doc);
        if (!current()) return;
        onCircuit(target.circuit, target.id);
        if (target.runtimeReference)
          onNotice("已定位当前定义；原运行画面请从留存观察查看");
        return;
      }
      if (!folder) throw new Error("打开工程文件夹后可以查看这条文件引用");
      if (context?.folderId && context.folderId !== folder.id)
        throw new Error("引用属于另一个工程文件夹");
      const resolved = await command<{
        path: string;
        folderId: string;
        pathVersion: number;
      }>({
        op: "folderResolve",
        folder_id: folder.id,
        path: reference.path,
        path_version: reference.pathVersion ?? context?.pathVersion,
      });
      if (!current()) return;
      if (resolved.folderId !== folder.id)
        throw new Error("工程文件夹已改变，请重新打开引用");
      const path = relativePath(resolved.path),
        name = path.split("/").at(-1)!;
      if (/\.(pdf|png|jpe?g|webp)$/i.test(name)) {
        const result = await command<PreviewFile & { folderId: string }>({
          op: "folderPreview",
          folder_id: folder.id,
          path,
        });
        if (!current()) return;
        if (result.folderId !== folder.id)
          throw new Error("工程文件夹已改变，请重新打开引用");
        onPreview({ ...result, name, path, page: reference.page });
      } else {
        const result = await command<{
          text: string;
          revision: string;
          folderId: string;
          pathVersion: number;
        }>({ op: "folderRead", folder_id: folder.id, path });
        if (!current()) return;
        if (result.folderId !== folder.id)
          throw new Error("工程文件夹已改变，请重新打开引用");
        if (/\.circ$/i.test(name)) {
          const separator = folder.path.includes("\\") ? "\\" : "/";
          const absolute =
            folder.path.replace(/[\\/]$/, "") +
            separator +
            path.replaceAll("/", separator);
          const opened = await command<Document>({
            op: "open",
            path: absolute,
          });
          if (current()) onDocument(opened);
        } else
          onPreview({
            name,
            path,
            text: result.text,
            revision: result.revision,
            folderId: result.folderId,
            pathVersion: result.pathVersion,
          });
      }
    })().catch((error) => {
      if (current()) onError(error);
    });
  };
}
