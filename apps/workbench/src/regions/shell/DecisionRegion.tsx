import { DecisionDialog } from "../../components/DecisionDialog";
import { useNotices } from "../../workbench/hooks";

/** The pending decision, such as discarding unsaved changes. */
export function DecisionRegion() {
  const decision = useNotices((state) => state.decision);
  const setDecision = useNotices((state) => state.setDecision);
  if (!decision) return null;
  return (
    <DecisionDialog decision={decision} onClose={() => setDecision(null)} />
  );
}
