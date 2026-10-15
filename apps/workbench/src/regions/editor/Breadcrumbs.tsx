import type { PlacementState } from "../../lib/usePlacement";
import { useView } from "../../workbench/hooks";
import {
  InstanceStatus,
  ParentInstanceButton,
} from "../simulation/InstanceBar";
import { CircuitActions } from "./CircuitActions";
import { PlacementControls } from "./PlacementControls";

/** The bar above the canvas: where the shown circuit is, its commands, the
 * component being placed and the simulation instance shown. */
export function Breadcrumbs({ placement }: { placement: PlacementState }) {
  const { doc, circuit } = useView();
  if (!doc || !circuit) return null;
  return (
    <div className="breadcrumbs">
      <span>{doc.name}</span>
      <span>/</span>
      <ParentInstanceButton />
      <strong>{circuit.name}</strong>
      <CircuitActions />
      <PlacementControls placement={placement} />
      <InstanceStatus />
    </div>
  );
}
