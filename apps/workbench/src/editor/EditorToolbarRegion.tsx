import { EditorToolbar } from "./EditorToolbar";
import {
  useEditor,
  useNotices,
  useSelection,
  useSettings,
  useShell,
  useView,
} from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** Tools, history, deletion, zoom and grid for the shown circuit. */
export function EditorToolbarRegion() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc } = view;
  const selection = useSelection();
  const tool = useEditor((state) => state.tool);
  const place = useEditor((state) => state.place);
  const zoom = useEditor((state) => state.zoom);
  const showGrid = useEditor((state) => state.showGrid);
  const arranging = useEditor((state) => state.arranging);
  const pending = useShell((state) => state.pending);
  const shortcuts = useSettings((state) => state.labels);
  const onError = useNotices((state) => state.onError);
  if (!doc) return null;
  const { setTool, setPlace, requestFit, requestZoom, setShowGrid } =
    stores.editor.getState();
  const editing = actions.editor;
  return (
    <EditorToolbar
      tool={tool}
      place={place}
      shortcuts={shortcuts}
      pending={pending}
      canUndo={doc.canUndo}
      canRedo={doc.canRedo}
      hasSelection={Boolean(selection.length)}
      onTool={setTool}
      onCancelPlace={() => setPlace(null)}
      onHistory={(op) => editing.history(view, op)}
      onDelete={() =>
        void editing
          .edit(view, { kind: "delete", ids: selection })
          .catch(onError)
      }
      onFit={requestFit}
      zoom={zoom}
      onZoom={requestZoom}
      showGrid={showGrid}
      arranging={arranging}
      onToggleGrid={() => setShowGrid((shown) => !shown)}
      onArrange={() => void editing.arrange(view)}
    />
  );
}
