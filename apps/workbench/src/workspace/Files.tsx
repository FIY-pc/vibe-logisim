import type { PreviewFile } from "./FilePreview";
import { usesFolderPreview } from "./materialPreview";
import { TextPrompt } from "../shared/TextPrompt";
import { DecisionDialog, type Decision } from "../shared/DecisionDialog";
import { useEffect, useRef, useState } from "react";
import { useTree } from "@headless-tree/react";
import {
  asyncDataLoaderFeature,
  hotkeysCoreFeature,
  searchFeature,
  selectionFeature,
  type FeatureImplementation,
  type ItemInstance,
  type TreeInstance,
} from "@headless-tree/core";
import {
  ChevronDown,
  ChevronRight,
  CircuitBoard,
  File as PlainFile,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  History,
  Plus,
  LocateFixed,
} from "lucide-react";
import { command, desktop } from "../shared/transport";
import { subscribeEvents } from "../shared/events";
import { bindingLabel, eventBinding } from "../shared/shortcuts";
import { ContextMenu } from "../shared/ContextMenu";
import { Menu, MenuItem, MenuSeparator } from "../shared/Menu";
import { useFolderPicker } from "./useFolderPicker";
import type { ImportAction } from "../generated/ImportAction";
import { Checkbox } from "../shared/Checkbox";
import { nativeDropPoint, useFileDragHover } from "./useFileDragHover";
import { useFileClipboardMenu } from "./useFileClipboardMenu";
import { DialogBody, DialogFooter, DialogFrame } from "../shared/Dialog";
import { Button, IconButton, ActionRow } from "../design/ui";
import { fullText } from "../shared/Tooltips";
export interface ProjectFolder {
  historyWarning?: string;
  recentWarning?: string;
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
interface FileClipboard {
  entry: Entry;
  cut: boolean;
  text: string;
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
/** A file's icon tells its kind at a glance, the way file managers do. */
function EntryIcon({
  name,
  directory,
  open = false,
  size,
}: {
  name: string;
  directory?: boolean;
  open?: boolean;
  size: number;
}) {
  if (directory)
    return open ? <FolderOpen size={size} /> : <Folder size={size} />;
  const extension = name.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  const Icon =
    extension === "circ"
      ? CircuitBoard
      : /^(pdf|pptx|md|txt|text|csv|tsv|log)$/.test(extension)
        ? FileText
        : /^(png|jpe?g|webp|gif|bmp|svg)$/.test(extension)
          ? FileImage
          : /^(zip|jar|7z|rar|tar|gz|tgz|xz)$/.test(extension)
            ? FileArchive
            : /^(xlsx?|ods)$/.test(extension)
              ? FileSpreadsheet
              : /^(v|sv|vhdl?|asm|s|c|h|py|js|ts|json|xml|hex|coe|mif)$/.test(
                    extension,
                  )
                ? FileCode
                : PlainFile;
  return <Icon size={size} />;
}
const unreadable = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /UTF-8/.test(message)
    ? "应用内可查看文本、PDF、PPTX 和图片。"
    : message;
};
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
  onCloseFolder?: () => void;
  onOpen: (path: string) => void;
  onPreview: (file: PreviewFile) => void;
  onError: (e: unknown) => void;
  onRename: () => Promise<void>;
  /** Files dropped on the conversation (`[data-reference-drop]`). */
  onReference?: (paths: string[]) => void;
  onCopyFile?: (
    file: { folderId: string; path: string; text: string } | null,
  ) => void;
  onReferenceHover?: (active: boolean) => void;
}
const FOLDER_REFERENCE = "请选择文件；文件夹可以在问题中按路径说明";
const referenceZoneAt = (x: number, y: number) =>
  Boolean(document.elementFromPoint(x, y)?.closest("[data-reference-drop]"));
// The workspace has single-file commands. Keep selection single, and relist
// folders when reopened because disk contents may have changed while collapsed.
const fileTreeFeature: FeatureImplementation<Entry> = {
  key: "workspace-files",
  overwrites: ["selection", "tree"],
  itemInstance: {
    expand: ({ item, prev }) => {
      if (!item.isFolder() || item.isExpanded()) return;
      prev?.();
      void item.invalidateChildrenIds(true);
    },
    getProps: ({ item, tree, prev }) => ({
      ...prev?.(),
      onClick: () => {
        item.setFocused();
        tree.setSelectedItems([item.getId()]);
        item.primaryAction();
        if (item.isFolder()) {
          if (item.isExpanded()) item.collapse();
          else item.expand();
        }
      },
    }),
  },
};
export function Files(props: Props) {
  // Async caches and pending interactions belong to one folder identity.
  return <FolderFiles key={props.folder?.id ?? "no-folder"} {...props} />;
}
function FolderFiles({
  folder,
  activePath,
  version,
  onFolder,
  onCloseFolder,
  onOpen,
  onPreview,
  onError,
  onRename,
  onReference,
  onCopyFile,
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
  /** The entry the context menu was opened on; null for the folder. */
  const [contextEntry, setContextEntry] = useState<Entry | null>(null);
  const [pending, setPending] = useState(false);
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
  const clipboardRef = useRef(clipboard);
  clipboardRef.current = clipboard;
  const [pasteConflict, setPasteConflict] = useState<Decision | null>(null);
  const pasteBusy = useRef(false);
  const previewRequest = useRef(0);
  const selectedPath = useRef<string | null>(null);
  const alive = useRef(true);
  const setSelected = (path: string | null) => {
    if (selectedPath.current !== path) previewRequest.current++;
    selectedPath.current = path;
    fileTree.setSelectedItems(path === null ? [] : [path]);
  };
  const [dragging, setDragging] = useState<string | null>(null),
    [dropTarget, setDropTarget] = useState<string | null>(null);
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null),
    [history, setHistory] = useState(false);
  const filesRef = useRef<HTMLDivElement>(null);
  const currentFolder = useRef(folder?.id);
  if (currentFolder.current !== folder?.id) previewRequest.current++;
  currentFolder.current = folder?.id;
  useEffect(() => {
    alive.current = true;
    currentFolder.current = folder?.id;
    return () => {
      alive.current = false;
      currentFolder.current = undefined;
      previewRequest.current++;
      onReferenceHover?.(false);
    };
  }, []);
  const skipClick = useRef(false);
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
  const warned = useRef(new Set<string>());
  const warnHistory = (warning?: string | null) => {
    if (!warning) return;
    const key = `${folder?.id}:${warning}`;
    if (warned.current.has(key)) return;
    warned.current.add(key);
    onError(new Error(`文件历史暂不可用：${warning}`));
  };
  const fileTree: TreeInstance<Entry> = useTree<Entry>({
    rootItemId: "",
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().directory,
    isSearchMatchingItem: (search, item) =>
      search.length > 0 &&
      item
        .getItemName()
        .toLocaleLowerCase()
        .startsWith(search.toLocaleLowerCase()),
    dataLoader: {
      // getChildrenWithData supplies every visible entry, including metadata.
      getItem: (path) => ({
        path,
        name: path.split("/").at(-1) || "",
        directory: path === "",
        size: 0,
      }),
      getChildrenWithData: async (
        path,
      ): Promise<{ id: string; data: Entry }[]> => {
        if (!folder || !alive.current) return [];
        try {
          const result = await command<
            OperationResult & { folder: ProjectFolder; entries: Entry[] }
          >({ op: "folderList", path });
          if (!alive.current || result.folder.id !== currentFolder.current)
            return [];
          warnHistory(result.historyWarning);
          return result.entries.map((entry) => {
            const data = { ...entry, path: normalize(entry.path) };
            return { id: data.path, data };
          });
        } catch (error) {
          // Resolve failed loads so the library leaves its loading state. Keep
          // the last listing; F5 or reopening the folder can retry the request.
          if (alive.current) onError(error);
          return fileTree
            .retrieveChildrenIds(path, true)
            .map((id) => ({ id, data: fileTree.retrieveItemData(id) }));
        }
      },
    },
    features: [
      asyncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      searchFeature,
      fileTreeFeature,
    ],
    onPrimaryAction: (item) => void select(item.getItemData()),
    onTreeHotkey: (_name, event) => {
      // Selection follows keyboard focus immediately, before the library's
      // deferred DOM focus, so a previous preview cannot arrive in that gap.
      setSelected(fileTree.getFocusedItem()?.getId() ?? null);
      event.preventDefault();
      event.stopPropagation();
    },
    hotkeys: {
      // Bulk selection has no corresponding file operation in this workspace.
      toggleSelectedItem: { isEnabled: () => false },
      selectUpwards: { isEnabled: () => false },
      selectDownwards: { isEnabled: () => false },
      selectAll: { isEnabled: () => false },
      expandOrDown: {
        isEnabled: (tree) =>
          !tree.isSearchOpen() && !!tree.getFocusedItem()?.isFolder(),
      },
      collapseOrUp: { isEnabled: (tree) => !tree.isSearchOpen() },
      customOpen: {
        hotkey: "Enter",
        isEnabled: (tree) => !tree.isSearchOpen(),
        handler: (_event, tree) => tree.getFocusedItem()?.getProps().onClick(),
      },
      customSelect: {
        hotkey: "Space",
        handler: (_event, tree) =>
          setSelected(tree.getFocusedItem()?.getId() ?? null),
      },
      customRename: {
        hotkey: "F2",
        handler: (_event, tree) =>
          setRenaming(tree.getFocusedItem()?.getItemData() ?? null),
      },
      customRefresh: { hotkey: "F5", handler: () => void refresh() },
      customDelete: {
        hotkey: "Delete",
        handler: (event, tree) => {
          if (!event.repeat)
            setRemoving(tree.getFocusedItem()?.getItemData() ?? null);
        },
      },
      customBackspace: {
        hotkey: "Backspace",
        handler: (event, tree) => {
          if (!event.repeat)
            setRemoving(tree.getFocusedItem()?.getItemData() ?? null);
        },
      },
      customContextMenu: {
        hotkey: "ContextMenu",
        handler: () => openContextMenu(),
      },
      customContextMenuShift: {
        hotkey: "Shift+F10",
        handler: () => openContextMenu(),
      },
      // A file-tree key must never undo the active circuit.
      customUndo: { hotkey: "MetaOrControl+KeyZ", handler: () => {} },
      customEscape: {
        hotkey: "Escape",
        isEnabled: (tree) => !tree.isSearchOpen(),
        handler: () => {},
      },
    },
  });
  // Leave row-action buttons to Radix and suppress workspace shortcuts while a
  // modal is open. The search input is outside the tree and has its own listener.
  fileTree.setConfig((config) => ({
    ...config,
    hotkeys: Object.fromEntries(
      Object.keys({ ...fileTree.getHotkeyPresets(), ...config.hotkeys }).map(
        (name) => {
          const presets = fileTree.getHotkeyPresets();
          const hotkey = {
            ...presets[name as keyof typeof presets],
            ...config.hotkeys?.[name as keyof typeof config.hotkeys],
          };
          return [
            name,
            {
              ...hotkey,
              isEnabled: (tree: TreeInstance<Entry>) =>
                !pending &&
                !document.querySelector('dialog[open],[aria-modal="true"]') &&
                (document.activeElement?.getAttribute("role") === "treeitem" ||
                  document.activeElement === tree.getSearchInputElement() ||
                  (document.activeElement === tree.getElement() &&
                    name === "customRefresh")) &&
                (tree.getItems().length > 0 || name === "customRefresh") &&
                (hotkey.isEnabled?.(tree) ?? true),
            },
          ];
        },
      ),
    ),
  }));
  const selectedEntry = fileTree.getSelectedItems()[0]?.getItemData();
  const selectedParent = selectedEntry
    ? selectedEntry.directory
      ? selectedEntry.path
      : parentOf(selectedEntry.path)
    : "";
  const expanded = fileTree.getState().expandedItems;
  const refresh = async () => {
    const before = document.activeElement;
    const hadTreeFocus =
      before?.getAttribute("role") === "treeitem" &&
      fileTree.getElement()?.contains(before);
    for (const path of ["", ...fileTree.getState().expandedItems]) {
      if (!alive.current) return;
      if (path && !fileTree.getItems().some((item) => item.getId() === path))
        continue;
      await fileTree.getItemInstance(path).invalidateChildrenIds(true);
    }
    if (hadTreeFocus)
      requestAnimationFrame(() => {
        if (
          alive.current &&
          document.activeElement === document.body &&
          !before?.isConnected
        )
          (
            fileTree.getFocusedItem()?.getElement() ?? fileTree.getElement()
          )?.focus();
      });
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
        if (
          parent &&
          !fileTree.getItems().some((item) => item.getId() === parent)
        )
          return;
        const item = fileTree.getItemInstance(parent);
        await item.invalidateChildrenIds(true);
        if (!current()) return;
        if (parent) item.expand();
      }
    } catch (error) {
      if (current()) onError(error);
      return;
    }
    if (!fileTree.getItems().some((item) => item.getId() === path)) return;
    fileTree.getItemInstance(path).setFocused();
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
        const element = fileTree.getItemInstance(path).getElement();
        element?.focus();
        element?.scrollIntoView({ block: "nearest" });
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
        event.topic === "workspace" ||
        (event.topic === "agent" && event.data.event.type === "files-changed")
      )
        void latestRefresh.current().catch(onError);
    });
  }, [folder?.id]);
  useEffect(() => {
    if (version && folder) void latestRefresh.current().catch(onError);
  }, [version]);
  const afterChange = async (path?: string, warning?: string | null) => {
    if (!alive.current) return;
    warnHistory(warning);
    await refresh();
    if (!alive.current) return;
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
      if (entry.directory) return;
      if (entry.name.toLowerCase().endsWith(".circ")) {
        onOpen(absolute(entry.path));
        return;
      }
    } catch (error) {
      if (current()) onError(error);
      return;
    }
    try {
      if (usesFolderPreview(entry.name)) {
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
      // A file the app cannot show still opens, saying why and where it is.
      if (current())
        onPreview({
          name: entry.name,
          path: entry.path,
          location: absolute(entry.path),
          unavailable: unreadable(error),
        });
    }
  };
  const importSources = async (
    sources: string[],
    destination: string,
    reference = false,
    duplicate = false,
  ) => {
    if (
      !folder ||
      pending ||
      document.querySelector('dialog[open],[aria-modal="true"]')
    )
      return;
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
      if (!duplicate && plan.items.some((item) => item.conflict))
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
  const rememberFile = (entry: Entry, cut: boolean, text: string) => {
    if (!alive.current) return;
    const next = { entry, cut, text };
    clipboardRef.current = next;
    setClipboard(next);
    onCopyFile?.(
      folder && !entry.directory
        ? { folderId: folder.id, path: entry.path, text }
        : null,
    );
  };
  const copyFile = async (entry: Entry, cut: boolean) => {
    const text = absolute(entry.path);
    await navigator.clipboard.writeText(text);
    rememberFile(entry, cut, text);
  };
  const pasteFile = async (parent: string, pastedText?: string) => {
    const copied = clipboardRef.current;
    if (!folder || !copied || pending || pasteBusy.current) return;
    pasteBusy.current = true;
    try {
      // A text copy in an editor or another app supersedes the file clipboard.
      const text = pastedText ?? (await navigator.clipboard.readText());
      if (!alive.current || clipboardRef.current !== copied) return;
      if (text !== copied.text) {
        setClipboard(null);
        return;
      }
      const entry = copied.entry;
      // Pasting a selected folder onto itself duplicates beside it, as in VS Code.
      if (entry.directory && parent === entry.path) parent = parentOf(parent);
      if (entry.directory && parent.startsWith(entry.path + "/"))
        throw new Error("不能粘贴到文件夹自身的子目录");
      if (!copied.cut) {
        await importSources([copied.text], parent, false, true);
        return;
      }
      const complete = async (to: string) => {
        await move(entry, to);
        // A later Copy/Cut must not be cleared by this operation finishing.
        if (alive.current && clipboardRef.current === copied)
          setClipboard(null);
      };
      const to = join(parent, entry.name);
      if (to === entry.path) {
        setClipboard(null);
        return;
      }
      const listing = await command<{ entries: Entry[] }>({
        op: "folderList",
        path: parent,
      });
      if (!alive.current) return;
      const sameName = (name: string) =>
        listing.entries.some(
          (item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        );
      if (!sameName(entry.name)) {
        await complete(to);
        return;
      }
      // Rename is atomic and refuses overwrites. Keep both instead of copying
      // then deleting: the move must preserve open circuit identity and drafts.
      setPasteConflict({
        title: "存在同名项目",
        message: `目标文件夹中已存在“${entry.name}”。保留两者会为移入的项目添加编号。`,
        actions: [
          {
            label: "保留两者",
            primary: true,
            run: async () => {
              const latest = await command<{ entries: Entry[] }>({
                op: "folderList",
                path: parent,
              });
              if (!alive.current) return;
              const dot = entry.name.lastIndexOf(".");
              const extension =
                !entry.directory && dot > 0 ? entry.name.slice(dot) : "";
              const stem = entry.name.slice(
                0,
                entry.name.length - extension.length,
              );
              let name = entry.name,
                number = 2;
              const names = new Set(
                latest.entries.map((item) => item.name.toLocaleLowerCase()),
              );
              while (names.has(name.toLocaleLowerCase()))
                name = `${stem} (${number++})${extension}`;
              await complete(join(parent, name));
            },
          },
        ],
      });
    } finally {
      pasteBusy.current = false;
    }
  };
  const ownsClipboardEvent = (target: EventTarget | null) => {
    if (
      !(target instanceof HTMLElement) ||
      pending ||
      document.querySelector('dialog[open],[aria-modal="true"]') ||
      target.closest('input,textarea,select,[contenteditable="true"]')
    )
      return false;
    return (
      target === fileTree.getElement() ||
      (!!filesRef.current?.contains(target) &&
        !!target.closest('[role="treeitem"]'))
    );
  };
  useFileClipboardMenu(
    () => ownsClipboardEvent(document.activeElement),
    (action) => {
      if (action === "paste") void pasteFile(selectedParent).catch(onError);
      else if (selectedEntry)
        void copyFile(selectedEntry, action === "cut").catch(onError);
    },
    onError,
  );
  const chooseImport = async (directory: boolean, destination: string) => {
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
  const dragHover = useFileDragHover(filesRef, (x, y) => {
    const drag = pointer.current;
    const reference = referenceZoneAt(x, y);
    hoverReference(reference && !drag?.entry.directory);
    const parent = targetAt(x, y);
    setDropTarget(
      drag &&
        (parent === drag.entry.path ||
          parent?.startsWith(drag.entry.path + "/"))
        ? null
        : parent,
    );
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        !folder ||
        pending ||
        event.defaultPrevented ||
        event.repeat ||
        document.querySelector('dialog[open],[aria-modal="true"]') ||
        (event.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable='true']",
        ) ||
        eventBinding(event) !== "Mod+Shift+N"
      )
        return;
      event.preventDefault();
      setCreate({ kind: "folder", parent: selectedParent });
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [folder?.id, pending, selectedParent]);
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
      dragHover.update(event.clientX, event.clientY);
    };
    const finish = (event: PointerEvent) => {
      dragHover.cancel();
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
      dragHover.cancel();
      pointer.current = null;
      setDragging(null);
      setDropTarget(null);
      hoverReference(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("pointermove", update, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      dragHover.cancel();
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
    };
  }, [folder?.id, pending]);
  useEffect(() => {
    if (!desktop() || !folder) return;
    let disposed = false,
      unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "leave") {
            dragHover.cancel();
            setDropTarget(null);
            hoverReference(false);
            return;
          }
          const { x, y } = nativeDropPoint(payload.position);
          const parent = targetAt(x, y),
            reference = referenceZoneAt(x, y);
          if (payload.type === "drop") {
            dragHover.cancel();
            setDropTarget(null);
            hoverReference(false);
            // Files dropped on the conversation land in the project root.
            if (reference) {
              // Chat owns image drops, including standalone circuits. Only
              // other materials retain the project's import-and-reference flow.
              const imageTarget = document
                .elementFromPoint(x, y)
                ?.closest("[data-image-drop]");
              const paths = imageTarget
                ? payload.paths.filter(
                    (path) => !/\.(png|jpe?g|webp)$/i.test(path),
                  )
                : payload.paths;
              if (paths.length)
                void importSources(paths, "", true).catch(onError);
            } else if (parent !== null)
              void importSources(payload.paths, parent).catch(onError);
          } else if (
            !pending &&
            !document.querySelector('dialog[open],[aria-modal="true"]')
          ) {
            dragHover.update(x, y);
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
  }, [folder?.id, pending]);
  useEffect(() => {
    if (
      dropTarget === null ||
      dropTarget === "" ||
      expanded.includes(dropTarget)
    )
      return;
    const timer = setTimeout(
      () => fileTree.getItemInstance(dropTarget).expand(),
      650,
    );
    return () => clearTimeout(timer);
  }, [dropTarget, expanded]);
  const items = fileTree.getItems();
  const focusedId = fileTree.getState().focusedItem;
  // Refresh can remove the focused path. Keep one reachable tab stop without
  // stealing focus from a dialog or menu that initiated the disk operation.
  useEffect(() => {
    if (!focusedId || items.some((item) => item.getId() === focusedId)) return;
    let parent = parentOf(focusedId);
    while (parent && !items.some((item) => item.getId() === parent))
      parent = parentOf(parent);
    const next = items.find((item) => item.getId() === parent) ?? items[0];
    fileTree.applySubStateUpdate("focusedItem", next?.getId() ?? null);
    setSelected(next?.getId() ?? null);
  }, [items, focusedId]);
  const openContextMenu = () => {
    const row = fileTree.getFocusedItem()?.getElement();
    const rect = row?.getBoundingClientRect();
    if (row && rect)
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 20,
          clientY: rect.bottom,
        }),
      );
  };
  const renderItem = (item: ItemInstance<Entry>): React.ReactNode => {
    const entry = item.getItemData();
    const props = item.getProps();
    return (
      <div key={item.getKey()} role="none">
        <div
          className={
            "file-row" +
            (clipboard?.cut && clipboard.entry.path === entry.path
              ? " file-cut"
              : "") +
            (item.isSelected() ? " file-selected" : "") +
            (item.isMatchingSearch() ? " file-search-match" : "") +
            (activeRelative === entry.path ? " file-current" : "") +
            (dropTarget === entry.path && entry.directory
              ? " file-drop-target"
              : "")
          }
          data-file-target={entry.directory ? entry.path : parentOf(entry.path)}
          data-file-path={entry.path}
        >
          <button
            {...props}
            className={
              "file-entry" + (dragging === entry.path ? " file-dragging" : "")
            }
            aria-current={activeRelative === entry.path ? "page" : undefined}
            aria-busy={item.isLoading() || undefined}
            style={{ paddingLeft: 10 + item.getItemMeta().level * 13 }}
            data-tip={entry.path}
            onFocus={() => {
              item.setFocused();
              setSelected(entry.path);
            }}
            onPointerDown={(event) => {
              if (event.button === 0 && !pending) {
                item.setFocused();
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
            onClick={(event) => {
              if (!pending && !skipClick.current) props.onClick(event);
            }}
          >
            {entry.directory ? (
              item.isExpanded() ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )
            ) : (
              <span className="tree-spacer" />
            )}
            <EntryIcon
              name={entry.name}
              directory={entry.directory}
              open={item.isExpanded()}
              size={14}
            />
            <span>{entry.name}</span>
          </button>
          <Menu
            label={`${entry.name} 的操作`}
            title="更多操作"
            tabIndex={-1}
            disabled={pending}
          >
            {actions(entry)}
          </Menu>
        </div>
        {item.isFolder() && item.isExpanded() && (
          <div role="group">{item.getChildren().map(renderItem)}</div>
        )}
      </div>
    );
  };
  /** The commands for an entry, or for the folder itself when null. */
  const actions = (entry: Entry | null) => {
    const parent = entry
      ? entry.directory
        ? entry.path
        : parentOf(entry.path)
      : "";
    const path = () => absolute(entry?.path || "");
    return (
      <>
        <MenuItem onSelect={() => setCreate({ kind: "file", parent })}>
          新建文件…
        </MenuItem>
        <MenuItem
          shortcut={bindingLabel("Mod+Shift+N")}
          onSelect={() => setCreate({ kind: "folder", parent })}
        >
          新建文件夹…
        </MenuItem>
        {desktop() && (
          <>
            <MenuItem
              onSelect={() => void chooseImport(false, parent).catch(onError)}
            >
              导入文件…
            </MenuItem>
            <MenuItem
              onSelect={() => void chooseImport(true, parent).catch(onError)}
            >
              导入文件夹…
            </MenuItem>
          </>
        )}
        <MenuSeparator />
        {entry && (
          <>
            <MenuItem
              shortcut={bindingLabel("Mod+X")}
              onSelect={() => void copyFile(entry, true).catch(onError)}
            >
              剪切
            </MenuItem>
            <MenuItem
              shortcut={bindingLabel("Mod+C")}
              onSelect={() => void copyFile(entry, false).catch(onError)}
            >
              复制
            </MenuItem>
          </>
        )}
        <MenuItem
          shortcut={bindingLabel("Mod+V")}
          disabled={!clipboard || pending}
          onSelect={() => void pasteFile(parent).catch(onError)}
        >
          粘贴
        </MenuItem>
        <MenuSeparator />
        {desktop() && (
          <MenuItem
            onSelect={() =>
              void import("@tauri-apps/plugin-opener")
                .then(({ revealItemInDir }) => revealItemInDir(path()))
                .catch(onError)
            }
          >
            在文件管理器中显示
          </MenuItem>
        )}
        <MenuItem
          onSelect={() => {
            setClipboard(null);
            onCopyFile?.(null);
            void navigator.clipboard.writeText(path()).catch(onError);
          }}
        >
          复制路径
        </MenuItem>
        {entry && (
          <>
            <MenuSeparator />
            <MenuItem shortcut="F2" onSelect={() => setRenaming(entry)}>
              重命名…
            </MenuItem>
            <MenuItem onSelect={() => setMoving(entry)}>移动…</MenuItem>
            <MenuItem
              danger
              shortcut="Delete"
              onSelect={() => setRemoving(entry)}
            >
              移入回收站…
            </MenuItem>
          </>
        )}
        <MenuSeparator />
        <MenuItem shortcut="F5" onSelect={() => void refresh().catch(onError)}>
          刷新文件夹
        </MenuItem>
        <MenuItem onSelect={() => setHistory(true)}>文件改动…</MenuItem>
        {!entry && onCloseFolder && (
          <>
            <MenuSeparator />
            <MenuItem disabled={pending} onSelect={onCloseFolder}>
              关闭文件夹
            </MenuItem>
          </>
        )}
      </>
    );
  };
  /** The entry under a right-click in the tree, or null for empty space. */
  const entryAt = (target: EventTarget) => {
    const path = (target as HTMLElement).closest<HTMLElement>(
      "[data-file-path]",
    )?.dataset.filePath;
    return path === undefined
      ? null
      : (items.find((item) => item.getId() === path)?.getItemData() ?? null);
  };
  return (
    <div
      className="files"
      ref={filesRef}
      onKeyDownCapture={(event) => {
        if (!ownsClipboardEvent(event.target)) return;
        const binding = eventBinding(event.nativeEvent);
        if (binding === "Escape" && clipboardRef.current?.cut) {
          setClipboard(null);
          return;
        }
        if (binding !== "Mod+C" && binding !== "Mod+X" && binding !== "Mod+V")
          return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (binding === "Mod+V") void pasteFile(selectedParent).catch(onError);
        else if (selectedEntry)
          void copyFile(selectedEntry, binding === "Mod+X").catch(onError);
      }}
      onCopy={(event) => {
        if (!ownsClipboardEvent(event.target) || !selectedEntry) return;
        event.preventDefault();
        const text = absolute(selectedEntry.path);
        event.clipboardData.setData("text/plain", text);
        rememberFile(selectedEntry, false, text);
      }}
      onCut={(event) => {
        if (!ownsClipboardEvent(event.target) || !selectedEntry) return;
        event.preventDefault();
        const text = absolute(selectedEntry.path);
        event.clipboardData.setData("text/plain", text);
        rememberFile(selectedEntry, true, text);
      }}
      onPaste={(event) => {
        if (!ownsClipboardEvent(event.target) || !clipboard) return;
        event.preventDefault();
        void pasteFile(
          selectedParent,
          event.clipboardData.getData("text/plain"),
        ).catch(onError);
      }}
    >
      {folderDialog}
      {pasteConflict && (
        <DecisionDialog
          decision={pasteConflict}
          onClose={() => setPasteConflict(null)}
        />
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
      <ContextMenu content={actions(null)} disabled={!folder || pending}>
        <div
          className={
            "panel-heading" + (dropTarget === "" ? " file-drop-target" : "")
          }
          data-file-target=""
          onContextMenu={() => setContextEntry(null)}
        >
          <span>{folder?.name || "文件夹"}</span>
          <div>
            {folder && (
              <>
                <IconButton
                  aria-label="新建文件"
                  data-tip="新建文件"
                  disabled={pending}
                  onClick={() =>
                    setCreate({ kind: "file", parent: selectedParent })
                  }
                >
                  <Plus size={13} />
                </IconButton>
                <IconButton
                  aria-label="定位当前文件"
                  data-tip="定位当前文件"
                  disabled={!activeRelative || pending}
                  onClick={() =>
                    activeRelative && void reveal(activeRelative).catch(onError)
                  }
                >
                  <LocateFixed size={13} />
                </IconButton>
                <Menu label="文件夹操作" title="更多操作" disabled={pending}>
                  {actions(null)}
                </Menu>
              </>
            )}
          </div>
        </div>
      </ContextMenu>
      {folder && fileTree.isSearchOpen() && (
        <input
          {...fileTree.getSearchInputElementProps()}
          className="file-tree-search"
          aria-label="按名称定位文件"
          placeholder="输入文件名，↑↓ 定位，Esc 关闭"
        />
      )}
      {folder ? (
        <ContextMenu content={actions(contextEntry)} disabled={pending}>
          <div
            className={
              "file-tree" + (dropTarget === "" ? " file-drop-root" : "")
            }
            {...fileTree.getContainerProps(folder.name)}
            tabIndex={items.length === 0 ? 0 : -1}
            aria-busy={
              pending || fileTree.getState().loadingItemChildrens.length > 0
            }
            data-file-target=""
            onContextMenu={(event) => {
              const entry = entryAt(event.target);
              if (entry) setSelected(entry.path);
              setContextEntry(entry);
            }}
          >
            {fileTree.getRootItem().getChildren().map(renderItem)}
            {pending && (
              <div className="file-working" role="status">
                正在处理…
              </div>
            )}
          </div>
        </ContextMenu>
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
  onImported?: (paths: string[]) => void;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [choices, setChoices] = useState<Record<number, ImportAction>>(() =>
    Object.fromEntries(
      plan.items
        .filter((item) => !item.conflict)
        .map((item) => [item.index, "keepBoth"]),
    ),
  );
  const [applyRemaining, setApplyRemaining] = useState(false);
  const conflicts = plan.items.filter((item) => item.conflict);
  const remaining = conflicts.filter((item) => !choices[item.index]);
  const current = remaining[0];
  useEffect(
    () => () => {
      void command({
        op: "folderImportCancel",
        folder_id: folderId,
        plan_id: plan.id,
      }).catch(() => {});
    },
    [],
  );
  const close = async () => {
    await command({
      op: "folderImportCancel",
      folder_id: folderId,
      plan_id: plan.id,
    });
    onClose();
  };
  const apply = async (selected: Record<number, ImportAction>) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const result = await command<OperationResult & { imported: string[] }>({
        op: "folderImportApply",
        folder_id: folderId,
        plan_id: plan.id,
        choices: plan.items.map((item) => ({
          index: item.index,
          action: selected[item.index],
        })),
      });
      await onChanged(result.imported[0], result.historyWarning);
      onImported?.([
        ...plan.items
          .filter((item) => selected[item.index] === "skip")
          .map((item) => item.path),
        ...result.imported,
      ]);
      onClose();
    } catch (e) {
      setError(message(e));
      await onChanged();
    } finally {
      setPending(false);
    }
  };
  const choose = (action: ImportAction) => {
    if (!current || pending) return;
    const selected = { ...choices, [current.index]: action };
    if (applyRemaining) {
      // A batch replacement cannot replace one destination twice, or replace
      // a directory/large file that the host cannot recover in file history.
      const replaced = new Set(
        plan.items
          .filter((item) => selected[item.index] === "replace")
          .map((item) => item.path),
      );
      for (const item of remaining.slice(1)) {
        if (
          action === "replace" &&
          (!item.replaceable || replaced.has(item.path))
        )
          continue;
        selected[item.index] = action;
        if (action === "replace") replaced.add(item.path);
      }
    }
    if (conflicts.some((item) => !selected[item.index])) {
      setChoices(selected);
      setApplyRemaining(false);
    } else {
      // Keep the last question visible if publication fails, so retry/cancel
      // remain explicit. Nothing is copied until all conflicts are resolved.
      void apply(selected);
    }
  };
  if (!current) return null;
  return (
    <DialogFrame
      className="file-import-dialog"
      title={current.replaceable ? "替换现有文件？" : "存在同名项目"}
      aria-label="文件同名冲突"
      onClose={() => void close().catch((e) => setError(message(e)))}
      closeDisabled={pending}
      maxWidth="480px"
    >
      <DialogBody>
        <p>目标文件夹中已存在“{current.name}”。</p>
        <p className="file-import-path" {...fullText(current.path)}>
          <EntryIcon
            name={current.name}
            directory={current.directory}
            size={16}
          />
          <span>{current.path}</span>
        </p>
        <p className="file-import-detail">
          {current.replaceable
            ? "替换会覆盖现有内容；保留两者会为导入的文件添加编号。"
            : "此项目不能直接替换。保留两者会为导入的项目添加编号。"}
        </p>
        {conflicts.length > 1 && (
          <p className="file-import-detail">
            第 {conflicts.length - remaining.length + 1} 个，共{" "}
            {conflicts.length} 个冲突
          </p>
        )}
        {remaining.length > 1 && (
          <label className="file-import-remaining">
            <Checkbox
              checked={applyRemaining}
              disabled={pending}
              onCheckedChange={setApplyRemaining}
            />
            对其余可同样处理的冲突应用此选择
          </label>
        )}
        {error && (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button
          variant="soft"
          color="gray"
          disabled={pending}
          data-autofocus
          onClick={() => void close().catch((e) => setError(message(e)))}
        >
          取消
        </Button>
        {plan.items.length > 1 && (
          <Button
            variant="soft"
            color="gray"
            disabled={pending}
            onClick={() => choose("skip")}
          >
            跳过
          </Button>
        )}
        <Button
          variant={current.replaceable ? "soft" : "solid"}
          disabled={pending}
          onClick={() => choose("keepBoth")}
        >
          保留两者
        </Button>
        {current.replaceable && (
          <Button
            variant="solid"
            disabled={pending}
            onClick={() => choose("replace")}
          >
            {pending ? "正在导入…" : "替换"}
          </Button>
        )}
      </DialogFooter>
    </DialogFrame>
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
  const [entries, setEntries] = useState<FileChange[] | null>(null),
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
    const loaded = await command<FileChange[]>({
      op: "folderHistory",
      folder_id: folderId,
    });
    setEntries(loaded);
    // Open on the newest change, as change lists in version control tools do.
    const newest = loaded[0];
    if (newest?.files.length)
      setSelection(
        (current) => current ?? { id: newest.id, path: newest.files[0].path },
      );
  };
  useEffect(() => {
    void load().catch((e) => setError(message(e)));
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
    <DialogFrame
      className="file-history-dialog"
      title="文件改动"
      aria-label="文件改动"
      onClose={onClose}
      closeDisabled={pending}
      maxWidth="1100px"
      width="94vw"
    >
      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      {entries?.length === 0 ? (
        <DialogBody className="file-history-empty">
          <History size={28} aria-hidden="true" />
          <p>还没有文件改动</p>
          <p className="muted">
            移动、导入、移入回收站的文件和 AI 改过的文件会列在这里。
            <br />
            选中一项可以对照改动前后的内容，也可以撤销。
          </p>
        </DialogBody>
      ) : (
        <DialogBody scroll={false} className="file-history-body">
          <aside>
            {!entries && !error && <p role="status">正在读取…</p>}
            {entries?.map((entry) => (
              <section key={entry.id}>
                <div className="file-history-entry">
                  <span>
                    {entry.title}
                    <time>{new Date(entry.at).toLocaleString()}</time>
                  </span>
                  <Button
                    variant="soft"
                    color="gray"
                    disabled={pending || !entry.undoable}
                    data-tip={
                      !entry.undoable ? "包含未保留内容的大文件" : undefined
                    }
                    onClick={() => setConfirm(entry)}
                  >
                    撤销
                  </Button>
                </div>
                {entry.files.map((file) => (
                  <ActionRow
                    variant="ghost"
                    color="gray"
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
                  </ActionRow>
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
              entries && <p>选择文件查看改动</p>
            )}
          </div>
        </DialogBody>
      )}
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
    </DialogFrame>
  );
}
