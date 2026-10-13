import type { PreviewFile } from "./FilePreview";
import { TextPrompt } from "./TextPrompt";
import { DecisionDialog } from "./DecisionDialog";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  FolderPlus,
  Ellipsis,
} from "lucide-react";
import { command, desktop } from "../lib/transport";
import { eventBinding } from "../lib/shortcuts";
import "./Files.css";
export interface ProjectFolder {
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
interface Props {
  folder: ProjectFolder | null;
  onFolder: (f: ProjectFolder) => void;
  onOpen: (path: string) => void;
  onPreview: (file: PreviewFile) => void;
  onError: (e: unknown) => void;
  onRename: () => Promise<void>;
}
export function Files({
  folder,
  onFolder,
  onOpen,
  onPreview,
  onError,
  onRename,
}: Props) {
  const [create, setCreate] = useState<"file" | "folder" | null>(null);
  const [renaming, setRenaming] = useState<Entry | null>(null);
  const [moving, setMoving] = useState<Entry | null>(null);
  const [removing, setRemoving] = useState<Entry | null>(null);
  const [menu, setMenu] = useState<{
    entry: Entry | null;
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentFolder = useRef(folder?.id);
  currentFolder.current = folder?.id;
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const normalize = (value: string) => value.replace(/\\/g, "/");
  const parentOf = (value: string) =>
    normalize(value).split("/").slice(0, -1).join("/");
  const absolute = (relative: string) => {
    const base = folder!.path
      .replace(/^\\\\\?\\UNC\\/, "\\\\")
      .replace(/^\\\\\?\\/, "");
    const separator = base.includes("\\") ? "\\" : "/";
    return (
      base.replace(/[\\/]$/, "") +
      (relative ? separator + relative.replace(/\//g, separator) : "")
    );
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        !folder ||
        pending ||
        event.defaultPrevented ||
        event.repeat ||
        document.querySelector("dialog[open]") ||
        target?.closest("input, textarea, select, [contenteditable='true']") ||
        eventBinding(event) !== "Mod+Shift+N"
      )
        return;
      event.preventDefault();
      setMenu(null);
      setCreate("folder");
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [folder?.id, pending]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  const showMenu = (entry: Entry | null, x: number, y: number) => {
    if (!pending)
      setMenu({
        entry,
        x: Math.max(8, Math.min(x, window.innerWidth - 225)),
        y: Math.max(8, Math.min(y, window.innerHeight - 225)),
      });
  };
  const afterChange = async (parent = "") => {
    const paths = [""];
    const parts = normalize(parent).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++)
      paths.push(parts.slice(0, i).join("/"));
    setExpanded(new Set(paths));
    setEntries({});
    await Promise.all(paths.map((p) => list(p)));
    await onRename();
  };
  const move = async (entry: Entry, to: string) => {
    if (pending || normalize(entry.path) === normalize(to)) return;
    setPending(true);
    try {
      await command({
        op: "folderRename",
        folder_id: folder!.id,
        from: entry.path,
        to,
      });
      await afterChange(parentOf(to));
    } finally {
      setPending(false);
    }
  };
  const drop = async (event: React.DragEvent, parent: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    if (!dragging || pending) return;
    const source = JSON.parse(
      event.dataTransfer.getData("application/x-vibe-project-entry") || "null",
    );
    if (!source || source.folder !== folder?.id || source.path !== dragging)
      return;
    const entry = Object.values(entries)
      .flat()
      .find((item) => item.path === dragging);
    setDragging(null);
    if (entry) await move(entry, (parent ? parent + "/" : "") + entry.name);
  };
  const dragOver = (event: React.DragEvent, parent: string) => {
    if (
      !dragging ||
      pending ||
      parent === dragging ||
      parent.startsWith(dragging + "/")
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(parent);
  };
  const refresh = async () => {
    for (const path of expanded) await list(path);
  };
  const [entries, setEntries] = useState<Record<string, Entry[]>>({}),
    [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const list = async (path = "") => {
    const result = await command<{ folder: ProjectFolder; entries: Entry[] }>({
      op: "folderList",
      path,
    });
    if (result.folder.id !== currentFolder.current) return;
    setEntries((previous) => ({
      ...previous,
      [path]: result.entries.map((entry) => ({
        ...entry,
        path: normalize(entry.path),
      })),
    }));
  };
  useEffect(() => {
    setEntries({});
    setMenu(null);
    setCreate(null);
    setRenaming(null);
    setMoving(null);
    setRemoving(null);
    setDragging(null);
    setDropTarget(null);
    setExpanded(new Set([""]));
    if (folder) void list().catch(onError);
  }, [folder?.id]);
  const open = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true, multiple: false });
    if (typeof path === "string")
      onFolder(await command<ProjectFolder>({ op: "folderOpen", path }));
  };
  const select = async (entry: Entry) => {
    if (entry.directory) {
      if (expanded.has(entry.path)) {
        setExpanded((previous) => {
          const next = new Set(previous);
          next.delete(entry.path);
          return next;
        });
      } else {
        await list(entry.path);
        setExpanded((previous) => new Set([...previous, entry.path]));
      }
      return;
    }
    if (entry.name.toLowerCase().endsWith(".circ"))
      onOpen(folder!.path + "/" + entry.path);
    else if (/\.(pdf|png|jpe?g|webp)$/i.test(entry.name)) {
      const result = await command<PreviewFile>({
        op: "folderPreview",
        path: entry.path,
      });
      onPreview({ ...result, name: entry.name });
    } else {
      const result = await command<{ text: string }>({
        op: "folderRead",
        path: entry.path,
      });
      onPreview({ name: entry.name, path: entry.path, text: result.text });
    }
  };
  const tree = (parent: string, depth: number): React.ReactNode =>
    (entries[parent] || []).map((entry) => (
      <div key={entry.path}>
        <div
          className={
            "file-row" +
            (dropTarget === entry.path && entry.directory
              ? " file-drop-target"
              : "")
          }
          onContextMenu={(event) => {
            event.preventDefault();
            showMenu(entry, event.clientX, event.clientY);
          }}
          onDragOver={(event) =>
            dragOver(event, entry.directory ? entry.path : parentOf(entry.path))
          }
          onDrop={(event) =>
            void drop(
              event,
              entry.directory ? entry.path : parentOf(entry.path),
            ).catch(onError)
          }
        >
          <button
            className="file-entry"
            draggable={!pending}
            onDragStart={(event) => {
              setDragging(entry.path);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(
                "application/x-vibe-project-entry",
                JSON.stringify({ folder: folder?.id, path: entry.path }),
              );
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropTarget(null);
            }}
            style={{ paddingLeft: 10 + depth * 13 }}
            onClick={() => void select(entry).catch(onError)}
            title={entry.path}
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
            aria-label={`${entry.name} 的操作`}
            title="更多操作"
            aria-haspopup="menu"
            disabled={pending}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              showMenu(entry, bounds.right, bounds.bottom);
            }}
          >
            <Ellipsis size={13} />
          </button>
        </div>
        {entry.directory &&
          expanded.has(entry.path) &&
          tree(entry.path, depth + 1)}
      </div>
    ));
  return (
    <div className="files">
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
                  "button",
                ),
              ];
              const at = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              buttons[
                (at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                  buttons.length
              ]?.focus();
            }}
          >
            {desktop() && (
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
                  重命名…
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
                    await command({
                      op: "folderTrash",
                      folder_id: folder!.id,
                      path: removing.path,
                    });
                    await afterChange(parentOf(removing.path));
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
            await move(
              moving,
              (parent === "." ? "" : parent + "/") + moving.name,
            );
          }}
        />
      )}
      {create && (
        <TextPrompt
          title={create === "folder" ? "新建文件夹" : "新建文件"}
          initial={create === "folder" ? "" : "circuit.circ"}
          onClose={() => setCreate(null)}
          onSubmit={async (name) => {
            await command({
              op: "folderCreate",
              folder_id: folder!.id,
              path: name,
              directory: create === "folder",
            });
            await list();
            if (create === "file" && name.endsWith(".circ"))
              onOpen(folder!.path + "/" + name);
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
            const parent = parentOf(renaming.path);
            await move(renaming, (parent ? parent + "/" : "") + name);
          }}
        />
      )}
      <div
        className={
          "panel-heading" + (dropTarget === "" ? " file-drop-target" : "")
        }
        onDragOver={(event) => dragOver(event, "")}
        onDrop={(event) => void drop(event, "").catch(onError)}
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
            <button
              aria-label="新建文件"
              title="新建文件"
              onClick={() => setCreate("file")}
            >
              <Plus size={13} />
            </button>
          )}
          {folder && (
            <button
              aria-label="新建文件夹"
              title="新建文件夹"
              onClick={() => setCreate("folder")}
            >
              <FolderPlus size={13} />
            </button>
          )}
          {folder && (
            <button
              aria-label="刷新文件夹"
              title="刷新"
              onClick={() => void refresh().catch(onError)}
            >
              <RefreshCw size={13} />
            </button>
          )}
          {desktop() && (
            <button
              aria-label="打开工程文件夹"
              title="打开文件夹"
              onClick={() => void open().catch(onError)}
            >
              <FolderOpen size={14} />
            </button>
          )}
        </div>
      </div>
      {folder ? (
        <div className="file-tree">{tree("", 0)}</div>
      ) : desktop() ? (
        <button
          className="open-folder"
          onClick={() => void open().catch(onError)}
        >
          <FolderOpen size={14} />
          打开文件夹
        </button>
      ) : null}
    </div>
  );
}
