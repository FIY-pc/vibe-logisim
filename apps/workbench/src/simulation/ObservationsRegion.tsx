import { Observations } from "./Observations";
import { useSimulation, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The observation records dialog; quoting records hands them to the conversation. */
export function ObservationsRegion() {
  const { stores } = useWorkbench();
  const { doc } = useView();
  const observations = useSimulation((state) => state.observations);
  if (!observations) return null;
  const { setObservations } = stores.simulation.getState();
  return (
    <Observations
      {...observations}
      onClose={() => setObservations(null)}
      onQuote={(references) => {
        if (!doc || doc.id !== observations.documentId) return;
        stores.conversation.getState().setQuotation({
          id: crypto.randomUUID(),
          documentId: doc.id,
          references,
        });
        setObservations(null);
        stores.shell.getState().setRight("chat");
        stores.shell.getState().setSide("review", true);
      }}
    />
  );
}
