import { Inspector } from "../../components/Inspector";
import { PlacementInspector } from "../../components/PlacementInspector";
import { documentComponent } from "../../lib/connections";
import type { PlacementState } from "../../lib/usePlacement";
import {
  useEditor,
  useNotices,
  useSelection,
  useSimulation,
  useView,
} from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";
import { activeSimulation } from "../../workbench/view";

/** The rail inspector: the component being placed, or the selection's
 * properties and connections. */
export function InspectorRegion({ placement }: { placement: PlacementState }) {
  const { actions } = useWorkbench();
  const view = useView();
  const { doc, circuit, scope } = view;
  const selection = useSelection();
  const place = useEditor((state) => state.place);
  const canvasObservation = useEditor((state) => state.canvasObservation);
  const sim = useSimulation((state) => state.sim);
  const onError = useNotices((state) => state.onError);
  const { editor: editing, simulation: simulating } = actions;
  if (place)
    return (
      <PlacementInspector
        key={`${doc?.id}:${place.library}:${place.name}`}
        placement={placement}
      />
    );
  if (!circuit) return <div className="quiet-empty">选择元件以查看属性</div>;
  const connectionComponent =
    canvasObservation.scope === scope && selection.length === 1
      ? canvasObservation.focus?.components.find(
          (component) =>
            documentComponent(circuit, component)?.id === selection[0],
        ) || null
      : null;
  return (
    <Inspector
      doc={doc!}
      circuit={circuit}
      selection={selection}
      connectionComponent={connectionComponent}
      onOpenMemory={(id) => simulating.openMemory(view, id)}
      edit={(change) => editing.edit(view, change)}
      simulation={activeSimulation(sim, view)}
      simulate={(op, attributes) => simulating.simulate(view, op, attributes)}
      onError={onError}
    />
  );
}

/** Clears the selection, while there is one. */
export function InspectorActions() {
  const { actions } = useWorkbench();
  const view = useView();
  const selection = useSelection();
  if (!selection.length) return null;
  return (
    <button
      className="quiet-button"
      title="取消当前选择"
      onClick={() => actions.editor.select(view, [])}
    >
      取消选择
    </button>
  );
}
