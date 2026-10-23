import { Code2, X } from "lucide-react";
import { useEditor, useShell } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** Edits the active document's file as XML. */
export function SourceDialog() {
  const { stores, actions } = useWorkbench();
  const source = useEditor((state) => state.source);
  const pending = useShell((state) => state.pending);
  if (source === null) return null;
  const { setSource } = stores.editor.getState();
  return (
    <div className="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="编辑源文件"
        className="source-dialog"
      >
        <header>
          <Code2 size={18} /> {source.name}
          <button
            disabled={Boolean(pending)}
            onClick={() => setSource(null)}
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>
        <textarea
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
          <button disabled={Boolean(pending)} onClick={() => setSource(null)}>
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
      </section>
    </div>
  );
}
