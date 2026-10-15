import { Search } from "lucide-react";
import { useEditor, useSettings } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** Filters the active document's circuit list. */
export function CircuitSearch() {
  const { stores } = useWorkbench();
  const circuitSearch = useEditor((state) => state.circuitSearch);
  const shortcuts = useSettings((state) => state.labels);
  const { setCircuitSearch, circuitSearchInput } = stores.editor.getState();
  return (
    <label className="circuit-search">
      <Search size={14} />
      <input
        ref={circuitSearchInput}
        aria-label="查找电路"
        placeholder="查找电路"
        value={circuitSearch}
        onChange={(e) => setCircuitSearch(e.target.value)}
      />
      <kbd>{shortcuts.circuitSearch}</kbd>
    </label>
  );
}
