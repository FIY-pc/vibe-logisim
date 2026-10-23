import type { PreviewFile } from "./FilePreview";
import { TextPrompt } from "../shared/TextPrompt";
import { DecisionDialog } from "../shared/DecisionDialog";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  Ellipsis,
  LocateFixed,
  History,
  X,
} from "lucide-react";
import { command, desktop } from "../shared/transport";
import { subscribeEvents } from "../shared/events";
import { eventBinding } from "../shared/shortcuts";
import { useFolderPicker } from "./useFolderPicker";
import type { ImportAction } from "../generated/ImportAction";
import "./Files.css";
export interface ProjectFolder {
  historyWarning?: string;
  id: string;
  path: string;
  name: string;
}
interface Entry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
}
interface OperationResult {
  historyWarning?: string | null;
}
interface ImportPlan {
  id: string;
  /** Dropped on the conversation: the imported files become references. */
  reference?: boolean;
  items: {
    index: number;
    name: string;
    path: string;
    directory: boolean;
    conflict: boolean;
    replaceable: boolean;
  }[];
}
interface FileChange {
  id: string;
  title: string;
  at: number;
  undoable: boolean;
  files: { path: string; kind: "added" | "deleted" | "modified" }[];
}
interface HistorySide {
  kind: "text" | "binary" | "large" | "directory";
  text?: string;
  truncated?: boolean;
}
const normalize = (value: string) =>
  value.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
const parentOf = (value: string) =>
  normalize(value).split("/").slice(0, -1).join("/");
const join = (parent: string, name: string) =>
  parent ? parent + "/" + name : name;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** The absolute path of a file of the folder, in the folder path's style. */
export const absolutePath = (folderPath: string, relative: string) => {
  const base = folderPath
    .replace(/^\\\\\?\\UNC\\/, "\\\\")
    .replace(/^\\\\\?\\/, "");
  const separator = base.includes("\\") ? "\\" : "/";
  return (
    base.replace(/[\\/]$/, "") +
    (relative ? separator + relative.replace(/\//g, separator) : "")
  );
};
interface Props {
  folder: ProjectFolder | null;
  activePath?: string | null;
  /** Changes whenever the tree should be listed again. */
  version?: number;
  onFolder: (f: ProjectFolder) => void;
  onOpen: (path: string) => void;
  onPreview: (file: PreviewFile) => void;
  onError: (e: unknown) => void;
  onRename: () => Promise<void>;
  /** Files dropped on the conversation (`[data-reference-drop]`). */
  onReference?: (paths: string[]) => void;
  onReferenceHover?: (active: boolean) => void;
}
const FOLDER_REFERENCE = "请选择文件；文件夹可以在问题中按路径说明";
const referenceZoneAt = (x: number, y: number) =>
  Boolean(document.elementFromPoint(x, y)?.closest("[data-reference-drop]"));
export function Files({
  folder,
  activePath,
  version,
  onFolder,
  onOpen,
  onPreview,
  onError,
  onRename,
  onReference,
  onReferenceHover,
}: Props) {
  const { openFolder: open, folderDialog } = useFolderPicker(onFolder, onError);
  const [create, setCreate] = useState<{
    kind: "file" | "folder";
    parent: string;
  } | null>(null);
  const [renaming, setRenaming] = useState<Entry | null>(null),
    [moving, setMoving] = useState<Entry | null>(null),
    [removing, setRemoving] = useState<Entry | null>(null);
  const [menu, setMenu] = useState<{
    entry: Entry | null;
    x: number;
    y: number;
  } | null>(null);
  const [pending, setPending] = useState(false),
    [selected, setSelectedState] = useState<string | null>(null);
  const previewRequest = useRef(0);
  const selectedPath = useRef<string | null>(null);
  const alive = useRef(true);
  const setSelected = (path: string | null) => {
    if (selectedPath.current !== path) previewRequest.current++;
    selectedPath.current = path;
    setSelectedState(path);
  };
  const [entries, setEntries] = useState<Record<string, Entry[]>>({}),
    [expanded, setExpanded] = useState(new Set([""]));
  const [dragging, setDragging] = useState<string | null>(null),
    [dropTarget, setDropTarget] = useState<string | null>(null);
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null),
    [history, setHistory] = useState(false);
  const filesRef = useRef<HTMLDivElement>(null),
    menuRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const currentFolder = useRef(folder?.id);
  if (currentFolder.current !== folder?.id) previewRequest.current++;
  currentFolder.current = folder?.id;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      previewRequest.current++;
    };
  }, []);
  const skipClick = useRef(false),
    search = useRef({ text: "", at: 0 });
  const pointer = useRef<{
    entry: Entry;
    x: number;
    y: number;
    started: boolean;
    folder: string;
  } | null>(null);
  const referenceHover = useRef(false);
  const hoverReference = (active: boolean) => {
    if (referenceHover.current === active) return;
    referenceHover.current = active;
    onReferenceHover?.(active);
  };
  const absolute = (relative: string) => absolutePath(folder!.path, relative);
  const activeRelative =
    folder &&
    activePath &&
    normalize(activePath).startsWith(
      normalize(folder.path).replace(/\/$/, "") + "/",
    )
      ? normalize(activePath).slice(
          normalize(folder.path).replace(/\/$/, "").length + 1,
        )
      : null;
  const all = Object.values(entries).flat();
  const selectedEntry = all.find((e) => e.path === selected);
  const selectedParent = selectedEntry
    ? selectedEntry.directory
      ? selectedEntry.path
      : parentOf(selectedEntry.path)
    : "";
  const warned = useRef(new Set<string>());
  const warnHistory = (warning?: string | null) => {
    if (!warning) return;
    const key = `${folder?.id}:${warning}`;
    if (warned.current.has(key)) return;
    warned.current.add(key);
    onError(new Error(`文件历史暂不可用：${warning}`));
  };
  const list = async (path = "") => {
    const result = await command<
      OperationResult & { folder: ProjectFolder; entries: Entry[] }
    >({
      op: "folderList",
      path,
    });
    if (result.folder.id !== currentFolder.current) return;
    warnHistory(result.historyWarning);
    setEntries((previous) => ({
      ...previous,
      [path]: result.entries.map((e) => ({ ...e, path: normalize(e.path) })),
    }));
  };
  const refresh = async () => {
    for (const path of expanded) {
      try {
        await list(path);
      } catch (error) {
        if (path === "") throw error;
        setExpanded((previous) => {
          const next = new Set(previous);
          next.delete(path);
          return next;
        });
      }
    }
  };
  const reveal = async (path: string, focus = true) => {
    const folderId = folder?.id;
    if (!folderId || currentFolder.current !== folderId) return;
    const request = ++previewRequest.current;
    const current = () =>
      alive.current &&
      currentFolder.current === folderId &&
      previewRequest.current === request;
    const parts = parentOf(path).split("/").filter(Boolean),
      paths = [""];
    for (let i = 1; i <= parts.length; i++)
      paths.push(parts.slice(0, i).join("/"));
    try {
      for (const parent of paths) {
        await list(parent);
        if (!current()) return;
      }
    } catch (error) {
      if (current()) onError(error);
      return;
    }
    setExpanded((previous) => new Set([...previous, ...paths]));
    setSelected(path);
    const selectedRequest = previewRequest.current;
    if (focus)
      requestAnimationFrame(() => {
        if (
          !alive.current ||
          currentFolder.current !== folderId ||
          previewRequest.current !== selectedRequest
        )
          return;
        rowRefs.current.get(path)?.focus();
        rowRefs.current.get(path)?.scrollIntoView({ block: "nearest" });
      });
  };
  // The AI changes files and opens documents from its own turns; the host
  // reconnecting (`resync`) can have missed either.
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  useEffect(() => {
    if (!folder) return;
    return subscribeEvents((event) => {
      if (
        event.topic === "resync" ||
        (event.topic === "agent" &&
          ["files-changed", "document-opened"].includes(event.data.event.type))
      )
        void latestRefresh.current().catch(onError);
    });
  }, [folder?.id]);
  useEffect(() => {
    if (version && folder) void latestRefresh.current().catch(onError);
  }, [version]);
  const afterChange = async (path?: string, warning?: string | null) => {
    warnHistory(warning);
    await refresh();
    await onRename();
    if (path) await reveal(path);
  };
  const move = async (entry: Entry, to: string) => {
    if (pending || entry.path === to) return;
    const id = folder!.id;
    setPending(true);
    try {
      const result = await command<OperationResult>({
        op: "folderRename",
        folder_id: id,
        from: entry.path,
        to,
      });
      if (currentFolder.current === id)
        await afterChange(to, result.historyWarning);
    } finally {
      setPending(false);
    }
  };
  const select = async (entry: Entry) => {
    const folderId = folder?.id;
    if (!folderId || currentFolder.current !== folderId) return;
    setSelected(entry.path);
    const request = ++previewRequest.current;
    const current = () =>
      alive.current &&
      currentFolder.current === folderId &&
      previewRequest.current === request;
    try {
      if (entry.directory) {
        if (expanded.has(entry.path))
          setExpanded((previous) => {
            const next = new Set(previous);
            next.delete(entry.path);
            return next;
          });
        else {
          await list(entry.path);
          if (current())
            setExpanded((previous) => new Set([...previous, entry.path]));
        }
        return;
      }
      if (entry.name.toLowerCase().endsWith(".circ")) {
        onOpen(absolute(entry.path));
      } else if (/\.(pdf|png|jpe?g|webp)$/i.test(entry.name)) {
        const result = await command<PreviewFile>({
          op: "folderPreview",
          folder_id: folderId,
          path: entry.path,
        });
        if (current()) onPreview({ ...result, name: entry.name });
      } else {
        const result = await command<
          PreviewFile & { relativePath: string; folderId: string }
        >({
          op: "folderRead",
          folder_id: folderId,
          path: entry.path,
        });
        if (current())
          onPreview({ ...result, name: entry.name, path: result.relativePath });
      }
    } catch (error) {
      if (current()) onError(error);
    }
  };
  const showMenu = (entry: Entry | null, x: number, y: number) => {
    if (!pending) {
      if (entry) setSelected(entry.path);
      setMenu({
        entry,
        x: Math.max(8, Math.min(x, window.innerWidth - 230)),
        y: Math.max(8, Math.min(y, window.innerHeight - 370)),
      });
    }
  };
  const importSources = async (
    sources: string[],
    destination: string,
    reference = false,
  ) => {
    if (!folder || pending || document.querySelector("dialog[open]")) return;
    if (reference && sources.length > 8)
      throw new Error("每条问题最多引用 8 处资料或观察");
    const folder_id = folder.id;
    setPending(true);
    try {
      const plan = await command<ImportPlan>({
        op: "folderImportPrepare",
        folder_id,
        sources,
        destination,
      });
      const refused =
        reference && plan.items.some((item) => item.directory)
          ? FOLDER_REFERENCE
          : null;
      if (currentFolder.current !== folder_id || refused) {
        await command({
          op: "folderImportCancel",
          folder_id,
          plan_id: plan.id,
        });
        if (refused) throw new Error(refused);
        return;
      }
      if (plan.items.some((item) => item.conflict))
        setImportPlan({ ...plan, reference });
      else {
        try {
          const result = await command<
            OperationResult & { imported: string[] }
          >({
            op: "folderImportApply",
            folder_id,
            plan_id: plan.id,
            choices: plan.items.map((item) => ({
              index: item.index,
              action: "keepBoth",
            })),
          });
          await afterChange(result.imported[0], result.historyWarning);
          if (reference) onReference?.(result.imported);
        } catch (error) {
          await command({
            op: "folderImportCancel",
            folder_id,
            plan_id: plan.id,
          });
          await afterChange();
          throw error;
        }
      }
    } finally {
      setPending(false);
    }
  };
  const chooseImport = async (directory: boolean, destination: string) => {
    setMenu(null);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const paths = await open({
      directory,
      multiple: true,
      title: directory ? "导入文件夹" : "导入文件",
    });
    if (paths)
      await importSources(Array.isArray(paths) ? paths : [paths], destination);
  };
  const targetAt = (x: number, y: number) => {
    const node = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-file-target]");
    return node && filesRef.current?.contains(node)
      ? (node.dataset.fileTarget ?? null)
      : null;
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        !folder ||
        pending ||
        event.defaultPrevented ||
        event.repeat ||
        document.querySelector("dialog[open]") ||
        (event.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable='true']",
        ) ||
        eventBinding(event) !== "Mod+Shift+N"
      )
        return;
      event.preventDefault();
      setMenu(null);
      setCreate({ kind: "folder", parent: selectedParent });
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [folder?.id, pending, selectedParent]);
  useEffect(() => {
    setEntries({});
    setExpanded(new Set([""]));
    setSelected(null);
    setMenu(null);
    setCreate(null);
    setRenaming(null);
    setMoving(null);
    setRemoving(null);
    setDragging(null);
    setDropTarget(null);
    setImportPlan(null);
    setHistory(false);
    pointer.current = null;
    if (folder) void list().catch(onError);
  }, [folder?.id]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        if (selected) rowRefs.current.get(selected)?.focus();
      }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu, selected]);
  // Pointer dragging remains available when Tauri's native file-drop hook is on
  // (Windows' native hook intentionally disables HTML5 drag events).
  useEffect(() => {
    const update = (event: PointerEvent) => {
      const drag = pointer.current;
      if (!drag || pending) return;
      if (
        !drag.started &&
        Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5
      )
        return;
      drag.started = true;
      event.preventDefault();
      setDragging(drag.entry.path);
      hoverReference(
        !drag.entry.directory && referenceZoneAt(event.clientX, event.clientY),
      );
      const parent = targetAt(event.clientX, event.clientY);
      setDropTarget(
        parent === drag.entry.path || parent?.startsWith(drag.entry.path + "/")
          ? null
          : parent,
      );
      const tree = filesRef.current?.querySelector(".file-tree");
      if (tree) {
        const rect = tree.getBoundingClientRect();
        if (event.clientY < rect.top + 24) tree.scrollTop -= 8;
        else if (event.clientY > rect.bottom - 24) tree.scrollTop += 8;
      }
    };
    const finish = (event: PointerEvent) => {
      const drag = pointer.current;
      pointer.current = null;
      setDragging(null);
      setDropTarget(null);
      hoverReference(false);
      if (!drag?.started) return;
      skipClick.current = true;
      setTimeout(() => {
        skipClick.current = false;
      }, 0);
      if (referenceZoneAt(event.clientX, event.clientY)) {
        if (drag.folder !== currentFolder.current) return;
        if (drag.entry.directory) onError(new Error(FOLDER_REFERENCE));
        else onReference?.([drag.entry.path]);
        return;
      }
      const parent = targetAt(event.clientX, event.clientY);
      if (
        drag.folder !== currentFolder.current ||
        parent === null ||
        parent === drag.entry.path ||
        parent.startsWith(drag.entry.path + "/")
      )
        return;
      void move(drag.entry, join(parent, drag.entry.name)).catch(onError);
    };
    const cancel = () => {
      pointer.current = null;
      setDragging(null);
      setDropTarget(null);
      hoverReference(false);
    };
    window.addEventListener("pointermove", update, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [folder?.id, pending, entries, expanded]);
  useEffect(() => {
    if (!desktop() || !folder) return;
    let disposed = false,
      unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "leave") {
            setDropTarget(null);
            hoverReference(false);
            return;
          }
          const x = payload.position.x / window.devicePixelRatio,
            y = payload.position.y / window.devicePixelRatio;
          const parent = targetAt(x, y),
            reference = referenceZoneAt(x, y);
          if (payload.type === "drop") {
            setDropTarget(null);
            hoverReference(false);
            // Files dropped on the conversation land in the project root.
            if (reference)
              void importSources(payload.paths, "", true).catch(onError);
            else if (parent !== null)
              void importSources(payload.paths, parent).catch(onError);
          } else if (!pending && !document.querySelector("dialog[open]")) {
            setDropTarget(parent);
            hoverReference(reference);
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(onError);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [folder?.id, pending, expanded]);
  useEffect(() => {
    if (dropTarget === null || expanded.has(dropTarget)) return;
    const timer = setTimeout(
      () =>
        void list(dropTarget)
          .then(() =>
            setExpanded((previous) => new Set([...previous, dropTarget])),
          )
          .catch(onError),
      650,
    );
    return () => clearTimeout(timer);
  }, [dropTarget, expanded]);
  const visible: Entry[] = [];
  const flatten = (parent: string) => {
    for (const entry of entries[parent] || []) {
      visible.push(entry);
      if (entry.directory && expanded.has(entry.path)) flatten(entry.path);
    }
  };
  flatten("");
  const focusEntry = (entry: Entry | undefined) => {
    if (!entry) return;
    setSelected(entry.path);
    rowRefs.current.get(entry.path)?.focus();
    rowRefs.current.get(entry.path)?.scrollIntoView({ block: "nearest" });
  };
  const keyboard = (event: React.KeyboardEvent) => {
    if (pending || document.querySelector("dialog[open]")) return;
    const entry = visible.find((e) => e.path === selected) ?? visible[0],
      at = visible.indexOf(entry);
    const handled =
      [
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Enter",
        " ",
        "F2",
        "F5",
        "Delete",
        "Backspace",
        "ContextMenu",
        "Escape",
      ].includes(event.key) ||
      (event.key === "F10" && event.shiftKey) ||
      (event.key.toLowerCase() === "c" && (event.ctrlKey || event.metaKey)) ||
      (event.key.toLowerCase() === "z" && (event.ctrlKey || event.metaKey));
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === "ArrowDown")
      focusEntry(visible[Math.min(at + 1, visible.length - 1)]);
    else if (event.key === "ArrowUp") focusEntry(visible[Math.max(at - 1, 0)]);
    else if (event.key === "Home") focusEntry(visible[0]);
    else if (event.key === "End") focusEntry(visible.at(-1));
    else if (event.key === "ArrowRight" && entry?.directory) {
      if (!expanded.has(entry.path)) void select(entry).catch(onError);
      else focusEntry(visible[at + 1]);
    } else if (event.key === "ArrowLeft" && entry) {
      if (entry.directory && expanded.has(entry.path))
        void select(entry).catch(onError);
      else focusEntry(visible.find((e) => e.path === parentOf(entry.path)));
    } else if (event.key === "Enter" && entry)
      void select(entry).catch(onError);
    else if (event.key === " " && entry) setSelected(entry.path);
    else if (event.key === "F2" && entry) setRenaming(entry);
    else if (event.key === "F5") void refresh().catch(onError);
    else if (
      ["Delete", "Backspace"].includes(event.key) &&
      entry &&
      !event.repeat
    )
      setRemoving(entry);
    else if (
      (event.key === "ContextMenu" ||
        (event.key === "F10" && event.shiftKey)) &&
      entry
    ) {
      const rect = rowRefs.current.get(entry.path)?.getBoundingClientRect();
      if (rect) showMenu(entry, rect.left + 20, rect.bottom);
    } else if (
      event.key.toLowerCase() === "c" &&
      (event.ctrlKey || event.metaKey) &&
      entry
    )
      void navigator.clipboard.writeText(entry.path).catch(onError);
    else if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.length === 1 &&
      event.key !== " "
    ) {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      search.current = {
        text:
          now - search.current.at < 800
            ? search.current.text + event.key
            : event.key,
        at: now,
      };
      const query = /^(.)\1+$/.test(search.current.text)
        ? event.key
        : search.current.text;
      focusEntry(
        [...visible.slice(at + 1), ...visible.slice(0, at + 1)].find((e) =>
          e.name.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()),
        ),
      );
    }
  };
  const tree = (parent: string, depth: number): React.ReactNode =>
    (entries[parent] || []).map((entry, index) => (
      <div key={entry.path} role="none">
        <div
          className={
            "file-row" +
            (selected === entry.path ? " file-selected" : "") +
            (activeRelative === entry.path ? " file-current" : "") +
            (dropTarget ===
              (entry.directory ? entry.path : parentOf(entry.path)) &&
            entry.directory
              ? " file-drop-target"
              : "")
          }
          data-file-target={entry.directory ? entry.path : parentOf(entry.path)}
          onContextMenu={(event) => {
            event.preventDefault();
            showMenu(entry, event.clientX, event.clientY);
          }}
        >
          <button
            ref={(node) => {
              if (node) rowRefs.current.set(entry.path, node);
              else rowRefs.current.delete(entry.path);
            }}
            className={
              "file-entry" + (dragging === entry.path ? " file-dragging" : "")
            }
            role="treeitem"
            aria-level={depth + 1}
            aria-posinset={index + 1}
            aria-setsize={(entries[parent] || []).length}
            aria-expanded={
              entry.directory ? expanded.has(entry.path) : undefined
            }
            aria-selected={selected === entry.path}
            aria-current={activeRelative === entry.path ? "page" : undefined}
            tabIndex={
              selected === entry.path ||
              (!selected && visible[0]?.path === entry.path)
                ? 0
                : -1
            }
            style={{ paddingLeft: 10 + depth * 13 }}
            title={entry.path}
            onFocus={() => setSelected(entry.path)}
            onPointerDown={(event) => {
              if (event.button === 0 && !pending) {
                setSelected(entry.path);
                pointer.current = {
                  entry,
                  x: event.clientX,
                  y: event.clientY,
                  started: false,
                  folder: folder!.id,
                };
              }
            }}
            onClick={() => {
              if (!skipClick.current) void select(entry).catch(onError);
            }}
          >
            {entry.directory ? (
              expanded.has(entry.path) ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )
            ) : (
              <span className="tree-spacer" />
            )}
            {entry.directory ? <Folder size={14} /> : <FileText size={14} />}
            <span>{entry.name}</span>
          </button>
          <button
            className="file-rename"
            tabIndex={-1}
            aria-label={`${entry.name} 的操作`}
            title="更多操作"
            aria-haspopup="menu"
            disabled={pending}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              showMenu(entry, rect.right, rect.bottom);
            }}
          >
            <Ellipsis size={13} />
          </button>
        </div>
        {entry.directory && expanded.has(entry.path) && (
          <div role="group">{tree(entry.path, depth + 1)}</div>
        )}
      </div>
    ));
  const menuParent = menu?.entry
    ? menu.entry.directory
      ? menu.entry.path
      : parentOf(menu.entry.path)
    : "";
  return (
    <div className="files" ref={filesRef}>
      {folderDialog}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="文件操作"
            className="menu-content file-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
              event.preventDefault();
              const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ],
                at = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
              buttons[
                (at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                  buttons.length
              ]?.focus();
            }}
          >
            <button
              role="menuitem"
              onClick={() => {
                setCreate({ kind: "file", parent: menuParent });
                setMenu(null);
              }}
            >
              新建文件…
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setCreate({ kind: "folder", parent: menuParent });
                setMenu(null);
              }}
            >
              新建文件夹…
            </button>
            {desktop() && (
              <>
                <button
                  role="menuitem"
                  onClick={() =>
                    void chooseImport(false, menuParent).catch(onError)
                  }
                >
                  导入文件…
                </button>
                <button
                  role="menuitem"
                  onClick={() =>
                    void chooseImport(true, menuParent).catch(onError)
                  }
                >
                  导入文件夹…
                </button>
                <hr />
                <button
                  role="menuitem"
                  onClick={() => {
                    const path = absolute(menu.entry?.path || "");
                    setMenu(null);
                    void import("@tauri-apps/plugin-opener")
                      .then(({ revealItemInDir }) => revealItemInDir(path))
                      .catch(onError);
                  }}
                >
                  在文件管理器中显示
                </button>
              </>
            )}
            <button
              role="menuitem"
              onClick={() => {
                const path = absolute(menu.entry?.path || "");
                setMenu(null);
                void navigator.clipboard.writeText(path).catch(onError);
              }}
            >
              复制路径
            </button>
            {menu.entry && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    setRenaming(menu.entry);
                    setMenu(null);
                  }}
                >
                  重命名… <kbd>F2</kbd>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMoving(menu.entry);
                    setMenu(null);
                  }}
                >
                  移动…
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setRemoving(menu.entry);
                    setMenu(null);
                  }}
                >
                  移入回收站…
                </button>
              </>
            )}
            <hr />
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void refresh().catch(onError);
              }}
            >
              刷新文件夹
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setHistory(true);
                setMenu(null);
              }}
            >
              文件改动…
            </button>
          </div>,
          document.body,
        )}
      {removing && (
        <DecisionDialog
          decision={{
            title: "移入回收站",
            message: `将“${removing.name}”移入回收站？`,
            actions: [
              {
                label: "移入回收站",
                primary: true,
                run: async () => {
                  setPending(true);
                  try {
                    const result = await command<OperationResult>({
                      op: "folderTrash",
                      folder_id: folder!.id,
                      path: removing.path,
                    });
                    await afterChange(undefined, result.historyWarning);
                    setSelected(null);
                  } finally {
                    setPending(false);
                  }
                },
              },
            ],
          }}
          onClose={() => setRemoving(null)}
        />
      )}
      {moving && (
        <TextPrompt
          title="移动到文件夹"
          initial={parentOf(moving.path) || "."}
          onClose={() => setMoving(null)}
          onSubmit={async (value) => {
            const parent = normalize(value).replace(/\/$/, "");
            await move(moving, join(parent === "." ? "" : parent, moving.name));
          }}
        />
      )}
      {create && (
        <TextPrompt
          title={create.kind === "folder" ? "新建文件夹" : "新建文件"}
          initial={create.kind === "folder" ? "" : "circuit.circ"}
          onClose={() => setCreate(null)}
          onSubmit={async (name) => {
            if (/[/\\]/.test(name)) throw new Error("文件名不能包含路径分隔符");
            const path = join(create.parent, name);
            const result = await command<OperationResult>({
              op: "folderCreate",
              folder_id: folder!.id,
              path,
              directory: create.kind === "folder",
            });
            await afterChange(path, result.historyWarning);
            if (create.kind === "file" && name.endsWith(".circ"))
              onOpen(absolute(path));
          }}
        />
      )}
      {renaming && (
        <TextPrompt
          title="重命名"
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            if (/[/\\]/.test(name)) throw new Error("文件名不能包含路径分隔符");
            await move(renaming, join(parentOf(renaming.path), name));
          }}
        />
      )}
      {importPlan && folder && (
        <ImportDialog
          plan={importPlan}
          folderId={folder.id}
          onClose={() => setImportPlan(null)}
          onChanged={afterChange}
          onImported={importPlan.reference ? onReference : undefined}
        />
      )}
      {history && folder && (
        <HistoryDialog
          folderId={folder.id}
          onClose={() => setHistory(false)}
          onChanged={afterChange}
        />
      )}
      <div
        className={
          "panel-heading" + (dropTarget === "" ? " file-drop-target" : "")
        }
        data-file-target=""
        onContextMenu={(event) => {
          if (folder) {
            event.preventDefault();
            showMenu(null, event.clientX, event.clientY);
          }
        }}
      >
        <span>{folder?.name || "文件夹"}</span>
        <div>
          {folder && (
            <>
              <button
                aria-label="新建文件"
                title="新建文件"
                disabled={pending}
                onClick={() =>
                  setCreate({ kind: "file", parent: selectedParent })
                }
              >
                <Plus size={13} />
              </button>
              <button
                aria-label="定位当前文件"
                title="定位当前文件"
                disabled={!activeRelative || pending}
                onClick={() =>
                  activeRelative && void reveal(activeRelative).catch(onError)
                }
              >
                <LocateFixed size={13} />
              </button>
              <button
                aria-label="文件夹操作"
                title="更多操作"
                aria-haspopup="menu"
                disabled={pending}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  showMenu(null, rect.left, rect.bottom);
                }}
              >
                <Ellipsis size={13} />
              </button>
            </>
          )}
        </div>
      </div>
      {folder ? (
        <div
          className={"file-tree" + (dropTarget === "" ? " file-drop-root" : "")}
          role="tree"
          aria-label={folder.name}
          aria-busy={pending}
          data-file-target=""
          onKeyDown={keyboard}
          onContextMenu={(event) => {
            if (!(event.target as HTMLElement).closest(".file-row")) {
              event.preventDefault();
              showMenu(null, event.clientX, event.clientY);
            }
          }}
        >
          {tree("", 0)}
          {pending && (
            <div className="file-working" role="status">
              正在处理…
            </div>
          )}
        </div>
      ) : (
        <button
          className="open-folder"
          onClick={() => void open().catch(onError)}
        >
          <FolderOpen size={14} />
          打开文件夹
        </button>
      )}
    </div>
  );
}
function ImportDialog({
  plan,
  folderId,
  onClose,
  onChanged,
  onImported,
}: {
  plan: ImportPlan;
  folderId: string;
  onClose: () => void;
  onChanged: (path?: string, warning?: string | null) => Promise<void>;
  /** The imported files, and the existing ones kept instead of a copy. */
  onImported?: (paths: string[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [choices, setChoices] = useState<Record<number, ImportAction>>(() =>
    Object.fromEntries(plan.items.map((item) => [item.index, "keepBoth"])),
  );
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      void command({
        op: "folderImportCancel",
        folder_id: folderId,
        plan_id: plan.id,
      }).catch(() => {});
    };
  }, []);
  const close = async () => {
    await command({
      op: "folderImportCancel",
      folder_id: folderId,
      plan_id: plan.id,
    });
    onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="text-prompt file-import-dialog"
      aria-label="导入文件"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) void close().catch((e) => setError(message(e)));
      }}
    >
      <header>导入文件</header>
      <div className="file-import-items">
        {plan.items.map((item) => (
          <div key={item.index}>
            <span title={item.path}>
              {item.directory ? <Folder size={15} /> : <FileText size={15} />}{" "}
              {item.path}
            </span>
            {item.conflict ? (
              <select
                aria-label={`${item.name} 的重名处理`}
                value={choices[item.index]}
                disabled={pending}
                onChange={(event) =>
                  setChoices((previous) => ({
                    ...previous,
                    [item.index]: event.target.value as ImportAction,
                  }))
                }
              >
                <option value="keepBoth">保留两者</option>
                {item.replaceable && (
                  <option value="replace">覆盖现有文件</option>
                )}
                <option value="skip">跳过</option>
              </select>
            ) : (
              <span>新增</span>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      <footer>
        <button
          disabled={pending}
          onClick={() => void close().catch((e) => setError(message(e)))}
        >
          取消
        </button>
        <button
          className="primary"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError("");
            void command<OperationResult & { imported: string[] }>({
              op: "folderImportApply",
              folder_id: folderId,
              plan_id: plan.id,
              choices: plan.items.map((item) => ({
                index: item.index,
                action: choices[item.index],
              })),
            })
              .then(async (result) => {
                await onChanged(result.imported[0], result.historyWarning);
                onImported?.([
                  ...plan.items
                    .filter((item) => choices[item.index] === "skip")
                    .map((item) => item.path),
                  ...result.imported,
                ]);
                onClose();
              })
              .catch(async (e) => {
                setError(message(e));
                await onChanged();
              })
              .finally(() => setPending(false));
          }}
        >
          {pending ? "正在导入…" : "导入"}
        </button>
      </footer>
    </dialog>
  );
}
function HistoryDialog({
  folderId,
  onClose,
  onChanged,
}: {
  folderId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [entries, setEntries] = useState<FileChange[]>([]),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [selection, setSelection] = useState<{
      id: string;
      path: string;
    } | null>(null),
    [detail, setDetail] = useState<{
      before: HistorySide | null;
      after: HistorySide | null;
    } | null>(null);
  const [confirm, setConfirm] = useState<FileChange | null>(null);
  const load = async () => {
    setEntries(
      await command<FileChange[]>({ op: "folderHistory", folder_id: folderId }),
    );
  };
  useEffect(() => {
    dialog.current?.showModal();
    void load().catch((e) => setError(message(e)));
    return () => dialog.current?.close();
  }, [folderId]);
  useEffect(() => {
    setDetail(null);
    if (!selection) return;
    let alive = true;
    void command<{ before: HistorySide | null; after: HistorySide | null }>({
      op: "folderHistoryDetail",
      folder_id: folderId,
      ...selection,
    })
      .then((result) => {
        if (alive) setDetail(result);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [selection, folderId]);
  const side = (value: HistorySide | null) =>
    !value ? (
      <p>不存在</p>
    ) : value.kind === "text" ? (
      <>
        {value.truncated && <p>仅显示前 200000 字符</p>}
        <pre>{value.text || "（空文件）"}</pre>
      </>
    ) : (
      <p>
        {
          {
            directory: "文件夹",
            large: "文件较大，未保留可恢复副本",
            binary: "二进制文件，可通过撤销恢复",
          }[value.kind]
        }
      </p>
    );
  return (
    <dialog
      ref={dialog}
      className="file-history-dialog"
      aria-label="文件改动"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <header>
        <span>
          <History size={16} />
          文件改动
        </span>
        <button aria-label="关闭" disabled={pending} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      <div className="file-history-body">
        <aside>
          {!entries.length && <p>暂无文件改动</p>}
          {entries.map((entry) => (
            <section key={entry.id}>
              <div className="file-history-entry">
                <span>
                  {entry.title}
                  <time>{new Date(entry.at).toLocaleString()}</time>
                </span>
                <button
                  disabled={pending || !entry.undoable}
                  title={!entry.undoable ? "包含未保留内容的大文件" : undefined}
                  onClick={() => setConfirm(entry)}
                >
                  撤销
                </button>
              </div>
              {entry.files.map((file) => (
                <button
                  key={file.path}
                  className={
                    selection?.id === entry.id && selection.path === file.path
                      ? "selected"
                      : ""
                  }
                  onClick={() =>
                    setSelection({ id: entry.id, path: file.path })
                  }
                >
                  <span className={`file-change-${file.kind}`}>
                    {
                      { added: "新增", deleted: "删除", modified: "修改" }[
                        file.kind
                      ]
                    }
                  </span>
                  <span>{file.path}</span>
                </button>
              ))}
            </section>
          ))}
        </aside>
        <div className="file-history-detail">
          {selection ? (
            <>
              <h3>{selection.path}</h3>
              {detail ? (
                <div className="file-history-comparison">
                  <section>
                    <h4>改动前</h4>
                    {side(detail.before)}
                  </section>
                  <section>
                    <h4>改动后</h4>
                    {side(detail.after)}
                  </section>
                </div>
              ) : (
                <p role="status">正在读取…</p>
              )}
            </>
          ) : (
            <p>选择文件查看改动</p>
          )}
        </div>
      </div>
      {confirm && (
        <DecisionDialog
          decision={{
            title: "撤销文件改动",
            message: `撤销“${confirm.title}”涉及的 ${confirm.files.length} 项改动？`,
            actions: [
              {
                label: "撤销这次改动",
                primary: true,
                run: async () => {
                  setPending(true);
                  setError("");
                  try {
                    await command({
                      op: "folderHistoryUndo",
                      folder_id: folderId,
                      id: confirm.id,
                    });
                    await onChanged();
                    setSelection(null);
                    await load();
                  } finally {
                    setPending(false);
                  }
                },
              },
            ],
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </dialog>
  );
}
