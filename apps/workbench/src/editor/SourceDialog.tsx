import { useState } from "react";
import { useEditor, useShell } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { DecisionDialog } from "../shared/DecisionDialog";
import { DialogClose, useModal } from "../shared/Dialog";

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
            <textarea
              data-autofocus
              aria-label="源文件内容"
              value={source.xml}
              disabled={Boolean(pending)}
              onChange={(e) => setSource({ ...source, xml: e.target.value })}
              spellCheck={false}
            />
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
                disabled={Boolean(pending) || !changed}
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
