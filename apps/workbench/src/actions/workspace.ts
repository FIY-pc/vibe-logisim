import type { ProjectFolder } from "../components/Files";
import type { SourceStatus } from "../generated/SourceStatus";
import { command, desktop, openPath, savePath } from "../lib/transport";
import type { Document } from "../lib/types";
import { chooseFolder, openFolderPath } from "../lib/useFolderPicker";
import type { Stores } from "../workbench/createWorkbench";
import { reaction } from "../workbench/reaction";
import type { View } from "../workbench/view";

const comparable = (path: string) =>
  path.replace(/^\\\\\?\\/, "").replaceAll("\\", "/");
/** Windows paths compare without case; the host may add a verbatim prefix. */
const samePath = (a: string, b: string) => {
  const [x, y] = [comparable(a), comparable(b)];
  return /^[a-z]:\//i.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** Opening, saving, reloading and closing documents, and the project folder. */
export function createWorkspaceActions(stores: Stores) {
  const { documents, editor, files, notices, shell } = stores;
  const busy = <T>(action: () => Promise<T>) => shell.getState().busy(action);
  const onError = (error: unknown) => notices.getState().onError(error);
  /** Shows a document the host opened or created, at its main circuit. */
  const showDocument = (d: Document) => {
    documents.getState().update(d);
    editor.getState().setCircuitName(d.main);
  };

  const newFile = () =>
    busy(async () => {
      showDocument(await command<Document>({ op: "new", name: "未命名.circ" }));
    }).catch(onError);

  /** Asks for a circuit file: the system dialog in the desktop app, otherwise the upload input. */
  const openFile = () => {
    if (!desktop()) {
      files.getState().uploadInput.current?.click();
      return;
    }
    void busy(async () => {
      const path = await openPath();
      if (path) showDocument(await command<Document>({ op: "open", path }));
    }).catch(onError);
  };

  /** Opens a circuit file from the project folder; an open one is only shown. */
  const openDocument = (path: string) => {
    const { docs, active } = documents.getState();
    const open = docs.find((d) => d.path && samePath(d.path, path));
    if (!open)
      return void busy(() => command<Document>({ op: "open", path }))
        .then(showDocument)
        .catch(onError);
    // Reopening would reset the view to the main circuit after a slow parse.
    if (open.id === active) return;
    editor.getState().navigation.next();
    documents.getState().setActive(open.id);
    editor.getState().setPlace(null);
    editor.getState().setCircuitName(open.main);
    void command({ op: "activate", id: open.id }).catch(onError);
  };

  /** Imports a circuit file chosen in the upload input. */
  const importFile = (file: File) =>
    void busy(async () => {
      showDocument(
        await command<Document>({
          op: "import",
          name: file.name,
          xml: await file.text(),
        }),
      );
    }).catch(onError);

  /** Saves to the document's file, or asks where (outside the desktop app: downloads a copy). */
  const saveDocument = async (
    target: Document,
    saveAs = false,
  ): Promise<Document | null> => {
    let path = saveAs ? null : target.path;
    let target_revision: string | undefined;
    if (!path) {
      if (!desktop()) {
        const { xml } = await command<{ xml: string }>({
          op: "source",
          id: target.id,
          revision: target.revision,
        });
        const url = URL.createObjectURL(
          new Blob([xml], { type: "application/xml" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = target.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return null;
      }
      path = await savePath(target.path || target.name);
      if (!path) return null;
      const destination = await command<{ revision: string | null }>({
        op: "saveTarget",
        path,
      });
      target_revision = destination.revision || undefined;
    }
    const saved = await command<Document>({
      op: "save",
      id: target.id,
      revision: target.revision,
      path,
      target_revision,
    });
    documents.getState().mergeDocument(saved, target.revision);
    documents.getState().recheck();
    return saved;
  };

  const save = ({ doc }: View, saveAs = false) => {
    if (doc)
      void busy(() => saveDocument(doc, saveAs)).catch((e) => {
        documents.getState().recheck();
        onError(e);
      });
  };

  const closeDocument = async (target: Document, discard = false) => {
    await busy(() =>
      command({
        op: "close",
        id: target.id,
        revision: target.revision,
        discard,
      }),
    );
    documents
      .getState()
      .setDocs((previous) => previous.filter((d) => d.id !== target.id));
    if (documents.getState().active === target.id) {
      const next = documents.getState().docs[0];
      documents.getState().setActive(next?.id || null);
      editor.getState().setCircuitName(next?.main || "main");
      if (next) await command({ op: "activate", id: next.id });
    }
    // A run of the closed document ends on the host, which sends `ended` to
    // this window like any other run event.
  };

  /** Closes a document, first asking what to do with unsaved changes. */
  const requestClose = (target: Document) => {
    if (!target.dirty) {
      void closeDocument(target).catch(onError);
      return;
    }
    notices.getState().setDecision({
      title: `关闭 ${target.name}？`,
      message: "这个文档还有未保存的修改。",
      actions: [
        { label: "不保存", run: () => closeDocument(target, true) },
        {
          label: desktop() || target.path ? "保存并关闭" : "下载副本",
          primary: true,
          run: async () => {
            const saved = await busy(() => saveDocument(target));
            if (!saved) return false;
            await closeDocument(saved);
          },
        },
      ],
    });
  };

  /** Replaces the document with its source file, asking first when it has unsaved changes. */
  const requestReload = async ({ doc }: View) => {
    if (!doc) return;
    const status = await command<SourceStatus>({
      op: "sourceStatus",
      id: doc.id,
    });
    documents.getState().recheck();
    if (status.state !== "unchanged" && status.state !== "modified")
      throw new Error(
        status.state === "missing"
          ? "原文件已被移除，可以另存为保留当前文档。"
          : "无法读取源文件",
      );
    const reload = async (discard: boolean) => {
      const next = await busy(() =>
        command<Document>({
          op: "reload",
          id: doc.id,
          revision: doc.revision,
          source_revision: status.revision,
          discard,
        }),
      );
      documents.getState().mergeDocument(next, doc.revision);
      documents.getState().recheck();
    };
    if (!doc.dirty) {
      await reload(false);
      return;
    }
    notices.getState().setDecision({
      title: `重新载入 ${doc.name}？`,
      message: "当前未保存的修改将被源文件替换；载入后仍可撤销。",
      actions: [{ label: "重新载入", primary: true, run: () => reload(true) }],
    });
  };

  /** Shows a newly opened project folder in the rail. */
  const onFolder = (next: ProjectFolder) => {
    documents.getState().invalidate();
    files.getState().setFolder(next);
    shell.getState().revealFiles();
  };
  const openFolderAt = (path: string) =>
    openFolderPath(path, onFolder, onError);
  const openFolder = () =>
    chooseFolder(
      openFolderAt,
      () => files.getState().setFolderPrompt(true),
      onError,
    );

  /** Checks the active document's source file now, on window focus, and
   * every 3 s while it has a path. Returns the stop. */
  const watchSource = () =>
    reaction(
      [documents],
      () => {
        const { docs, active, sourceCheck } = documents.getState();
        const doc = docs.find((d) => d.id === active);
        return [doc?.id, doc?.revision, doc?.path, doc?.dirty, sourceCheck];
      },
      () => {
        const { docs, active } = documents.getState();
        const doc = docs.find((d) => d.id === active);
        if (!doc) return;
        let live = true;
        let timer: ReturnType<typeof setTimeout>;
        let checking = false;
        const { setSourceStatus } = documents.getState();
        const check = async () => {
          if (checking || !live) return;
          checking = true;
          clearTimeout(timer);
          try {
            const status = await command<SourceStatus>({
              op: "sourceStatus",
              id: doc.id,
            });
            if (live)
              setSourceStatus({ id: doc.id, revision: doc.revision, status });
          } catch (e) {
            if (live)
              setSourceStatus({
                id: doc.id,
                revision: doc.revision,
                status: { state: "unreadable", message: String(e) },
              });
          } finally {
            checking = false;
            if (live && doc.path) timer = setTimeout(check, 3000);
          }
        };
        const focus = () => void check();
        window.addEventListener("focus", focus);
        void check();
        return () => {
          live = false;
          clearTimeout(timer);
          window.removeEventListener("focus", focus);
        };
      },
    );

  return {
    showDocument,
    newFile,
    openFile,
    openDocument,
    importFile,
    saveDocument,
    save,
    closeDocument,
    requestClose,
    requestReload,
    onFolder,
    openFolder,
    openFolderAt,
    watchSource,
  };
}
export type WorkspaceActions = ReturnType<typeof createWorkspaceActions>;
