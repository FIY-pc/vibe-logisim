import { Inspector } from "./Inspector";
import { PlacementInspector } from "./PlacementInspector";
import { documentComponent } from "./connectivity";
import { liveRun, watchScope } from "../simulation/store";
import type { PlacementState } from "./usePlacement";
import {
  useEditor,
  useNotices,
  useSelection,
  useSimulation,
  useView,
} from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The rail inspector: the component being placed, or the selection's
 * properties and connections. */
export function InspectorRegion({ placement }: { placement: PlacementState }) {
  const { actions } = useWorkbench();
  const view = useView();
  const { doc, circuit, scope } = view;
  const selection = useSelection();
  const place = useEditor((state) => state.place);
  const canvasObservation = useEditor((state) => state.canvasObservation);
  const session = useSimulation((state) => state.session);
  const run = useSimulation((state) => state.view);
  const components = useSimulation((state) => state.components);
  const displayed = useSimulation((state) => state.displayed);
  const watches = useSimulation((state) => state.watches);
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
  const live =
    session && run && displayed
      ? liveRun({ session, view: run, displayed }, doc, circuit.name)
      : null;
  const selected =
    selection.length === 1
      ? (circuit.components.find(
          (component) => component.id === selection[0],
        ) ?? null)
      : null;
  const nativeId = connectionComponent?.componentId || selection[0];
  const watching = live
    ? (watches[watchScope(session!.sessionId, live.view.instancePath)] ?? [])
    : [];
  return (
    <Inspector
      doc={doc!}
      circuit={circuit}
      selection={selection}
      connectionComponent={connectionComponent}
      onOpenMemory={(id) => simulating.openMemory(view, id)}
      edit={(change) => editing.edit(view, change)}
      live={live ? components[nativeId] || null : null}
      watched={watching}
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
      title="取消当前选择"
      onClick={() => actions.editor.select(view, [])}
    >
      取消选择
    </button>
  );
}
