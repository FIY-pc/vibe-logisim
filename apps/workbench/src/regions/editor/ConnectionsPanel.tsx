import { useEditor, useShell } from "../../workbench/hooks";

/** The connections tab: the signal view the canvas last opened. */
export function ConnectionsPanel() {
  const right = useShell((state) => state.right);
  const signalView = useEditor((state) => state.signalView);
  if (right !== "connections") return null;
  return (
    signalView || (
      <div className="quiet-empty">
        选中元件或导线后，Ctrl+点击信号可定位来源。
      </div>
    )
  );
}
