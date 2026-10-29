import { Inspector } from "./Inspector";
import { PlacementInspector } from "./PlacementInspector";
import { live } from "../simulation/store";
import { componentState } from "../simulation/simulation";
import type { PlacementState } from "./usePlacement";
import {
  useEditor,
  useNotices,
  useSelection,
  useSimulation,
  useSimulationState,
  useView,
} from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { tip } from "../shared/Tooltips";

/** The rail inspector: the component being placed, or the selection's
 * properties and connections. */
export function InspectorRegion({ placement }: { placement: PlacementState }) {
  const { actions } = useWorkbench();
  const view = useView();
  const { doc, circuit, scope } = view;
  const selection = useSelection();
  const place = useEditor((state) => state.place);
  const canvasObservation = useEditor((state) => state.canvasObservation);
  const shown = live(useSimulationState(), view);
  const components = useSimulation((state) => state.components);
  const trace = useSimulation((state) => state.trace);
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
            !component.partial && component.componentId === selection[0],
        ) || null
      : null;
  const selected =
    selection.length === 1
      ? (circuit.components.find(
          (component) => component.id === selection[0],
        ) ?? null)
      : null;
  const component = shown ? components[selection[0]] : undefined;
  return (
    <Inspector
      doc={doc!}
      circuit={circuit}
      selection={selection}
      connectionComponent={connectionComponent}
      onOpenMemory={(id) => simulating.openMemory(view, id)}
      onNarrow={(ids) => editing.select(view, ids)}
      edit={(change) => editing.edit(view, change)}
      live={component ? componentState(selection[0], component) : null}
      watched={shown ? (trace?.signals.map((signal) => signal.id) ?? []) : []}
      onInput={async (bits) => {
        if (selected) await simulating.setInput(view, selected, bits);
      }}
      onWatch={(key) => {
        simulating.toggleWatch(view, key);
      }}
      onPress={() => {
        if (selected) simulating.press(view, selected);
      }}
      onRelease={() => simulating.release()}
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
      {...tip("取消当前选择", "Esc")}
      onClick={() => actions.editor.select(view, [])}
    >
      取消选择
    </button>
  );
}
