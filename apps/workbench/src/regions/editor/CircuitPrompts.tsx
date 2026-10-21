import { TextPrompt } from "../../components/TextPrompt";
import { useEditor, useSimulation, useView } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** The prompts that rename the shown circuit and add a circuit. */
export function CircuitPrompts() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { circuit } = view;
  const sim = useSimulation((state) => state.sim);
  const renameCircuit = useEditor((state) => state.renameCircuit);
  const circuitPrompt = useEditor((state) => state.circuitPrompt);
  const { setRenameCircuit, setCircuitPrompt } = stores.editor.getState();
  const { navigation } = actions;
  return (
    <>
      {renameCircuit && circuit && (
        <TextPrompt
          title="重命名电路"
          initial={circuit.name}
          onClose={() => setRenameCircuit(false)}
          onSubmit={(name) => navigation.renameCircuit(view, sim, name)}
        />
      )}
      {circuitPrompt && (
        <TextPrompt
          title="新建电路"
          onClose={() => setCircuitPrompt(false)}
          onSubmit={(name) => navigation.addCircuit(view, sim, name)}
        />
      )}
    </>
  );
}
