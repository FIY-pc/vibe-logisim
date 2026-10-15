import { Canvas } from "../../components/Canvas";
import type { PlacementState } from "../../lib/usePlacement";
import {
  useEditor,
  useNotices,
  useSelection,
  useSimulation,
  useView,
} from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** The shown circuit's canvas. */
export function CanvasRegion({ placement }: { placement: PlacementState }) {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc, circuit } = view;
  const selection = useSelection();
  const sim = useSimulation((state) => state.sim);
  const tool = useEditor((state) => state.tool);
  const place = useEditor((state) => state.place);
  const fitToken = useEditor((state) => state.fitToken);
  const zoomRequest = useEditor((state) => state.zoomRequest);
  const showGrid = useEditor((state) => state.showGrid);
  const focusTarget = useEditor((state) => state.focusTarget);
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
      simulation={sim}
      simulate={(op, attributes) => simulating.simulate(view, op, attributes)}
      onError={onError}
      fitToken={fitToken}
      zoomRequest={zoomRequest}
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
      onEnterCircuit={(name, id) =>
        navigation.enterCircuit(view, sim, name, id)
      }
    />
  );
}
