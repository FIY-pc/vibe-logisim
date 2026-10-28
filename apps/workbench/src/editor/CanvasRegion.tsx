import { Canvas } from "./Canvas";
import type { PlacementState } from "./usePlacement";
import { live } from "../simulation/store";
import {
  useEditor,
  useNotices,
  useSelection,
  useSimulation,
  useSimulationState,
  useView,
} from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The shown circuit's canvas. */
export function CanvasRegion({ placement }: { placement: PlacementState }) {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc, circuit } = view;
  const selection = useSelection();
  const tool = useEditor((state) => state.tool);
  const place = useEditor((state) => state.place);
  const fitToken = useEditor((state) => state.fitToken);
  const zoomRequest = useEditor((state) => state.zoomRequest);
  const deleteRequest = useEditor((state) => state.deleteRequest);
  const showGrid = useEditor((state) => state.showGrid);
  const focusTarget = useEditor((state) => state.focusTarget);
  const shown = live(useSimulationState(), view);
  const paint = useSimulation((state) => state.paint);
  const pending = useSimulation((state) => state.pending);
  const pressed = useSimulation((state) => state.pressed);
  const onError = useNotices((state) => state.onError);
  if (!doc || !circuit) return null;
  const { setZoom, setCanvasObservation, setPlace, setSignalView } =
    stores.editor.getState();
  const { editor: editing, simulation: simulating, navigation } = actions;
  return (
    <Canvas
      key={`${doc.id}:${circuit.name}`}
      doc={doc}
      circuit={circuit}
      tool={tool}
      selection={selection}
      setSelection={(s) => editing.inspect(view, s)}
      place={place}
      edit={(change) => editing.edit(view, change)}
      live={shown ? paint : null}
      pending={shown ? pending.map((item) => item.componentId) : []}
      pressed={shown ? pressed : null}
      onPoke={(component, point) =>
        void simulating.poke(view, component, point)
      }
      onPress={(component) => simulating.press(view, component)}
      onRelease={() => simulating.release()}
      onError={onError}
      onStale={() =>
        void stores.documents.getState().refreshWorkspace().catch(onError)
      }
      fitToken={fitToken}
      zoomRequest={zoomRequest}
      deleteRequest={deleteRequest}
      onZoomChange={setZoom}
      onObservation={setCanvasObservation}
      showGrid={showGrid}
      placement={placement}
      onCancelPlace={() => setPlace(null)}
      onPlace={(revision, change) =>
        editing.placeComponent(doc, circuit.name, revision, change)
      }
      focusTarget={
        focusTarget?.documentId === doc.id &&
        focusTarget.revision === doc.revision &&
        focusTarget.circuit === circuit.name
          ? focusTarget
          : null
      }
      onSignalView={setSignalView}
      onSignalOpen={() => {
        stores.shell.getState().setRight("connections");
        stores.shell.getState().setSide("review", true);
      }}
      onOpenMemory={(id) => simulating.openMemory(view, id)}
      onEnterCircuit={(name, id) => navigation.enterCircuit(view, name, id)}
    />
  );
}
