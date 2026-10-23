import { useEditor, useShell } from "../app/hooks";
import { useWorkbench } from "../app/provider";
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
  const { setSource } = stores.editor.getState();
  const close = () => {
    if (!pending) setSource(null);
  };
  return (
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
              disabled={Boolean(pending)}
              onClick={() => actions.editor.applySource(source)}
            >
              应用修改
            </button>
          </footer>
        </>
      )}
    </dialog>
  );
}
