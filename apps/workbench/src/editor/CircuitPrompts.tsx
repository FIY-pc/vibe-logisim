import { TextPrompt } from "../shared/TextPrompt";
import { useEditor, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The prompts that rename the shown circuit and add a circuit. */
export function CircuitPrompts() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { circuit } = view;
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
          onSubmit={(name) => navigation.renameCircuit(view, name)}
        />
      )}
      {circuitPrompt && (
        <TextPrompt
          title="新建电路"
          onClose={() => setCircuitPrompt(false)}
          onSubmit={(name) => navigation.addCircuit(view, name)}
        />
      )}
    </>
  );
}
