import { lazy, Suspense, useState } from "react";
import { useEditor, useShell, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { DecisionDialog } from "../shared/DecisionDialog";
import { DialogClose, useModal } from "../shared/Dialog";

const XmlEditor = lazy(() =>
  import("../shared/CodeEditor").then((module) => ({
    default: module.XmlEditor,
  })),
);

/** Edits the active document's file as XML. */
export function SourceDialog() {
  const open = useEditor((state) => state.source !== null);
  return open ? <SourceEditor /> : null;
}

function SourceEditor() {
  const { stores, actions } = useWorkbench();
  const source = useEditor((state) => state.source);
  const pending = useShell((state) => state.pending);
  const dialog = useModal();
  const { doc } = useView();
  const stale = Boolean(
    source && (doc?.id !== source.id || doc.revision !== source.revision),
  );
  const [discarding, setDiscarding] = useState(false);
  const { setSource } = stores.editor.getState();
  const changed = Boolean(source && source.xml !== source.original);
  // Closing with edits that were not applied asks first, as text editors do.
  const close = () => {
    if (pending) return;
    if (changed) setDiscarding(true);
    else setSource(null);
  };
  return (
    <>
      <dialog
        ref={dialog}
        className="source-dialog"
        aria-label="编辑源文件"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        {source && (
          <>
            <header>
              <h2>{source.name}</h2>
              <DialogClose disabled={Boolean(pending)} onClick={close} />
            </header>
            <Suspense fallback={<p role="status">正在打开编辑器…</p>}>
              <XmlEditor
                key={`${source.id}:${source.revision}`}
                label="源文件内容"
                autoFocus
                value={source.xml}
                readOnly={Boolean(pending) || stale}
                onChange={(xml) =>
                  setSource((current) =>
                    current?.id === source.id &&
                    current.revision === source.revision
                      ? { ...current, xml, error: undefined }
                      : current,
                  )
                }
              />
            </Suspense>
            {stale && (
              <p className="dialog-error" role="status">
                文档已切换或有后续修改；草稿保留，可复制后重新打开源文件。
              </p>
            )}
            {source.error && (
              <p className="dialog-error" role="alert">
                {source.error}
              </p>
            )}
            <footer>
              <button disabled={Boolean(pending)} onClick={close}>
                取消
              </button>
              <button
                className="primary"
                disabled={Boolean(pending) || stale || !changed}
                onClick={() => actions.editor.applySource(source)}
              >
                应用修改
              </button>
            </footer>
          </>
        )}
      </dialog>
      {discarding && (
        <DecisionDialog
          decision={{
            title: "放弃对源文件的修改？",
            message: "这些修改还没有应用，关闭后会丢失。",
            actions: [
              {
                label: "放弃修改",
                primary: true,
                run: async () => setSource(null),
              },
            ],
          }}
          onClose={() => setDiscarding(false)}
        />
      )}
    </>
  );
}
