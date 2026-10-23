import { TextPrompt } from "../shared/TextPrompt";
import { useFiles } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** Asks for the name of a new circuit file in the project folder. */
export function NewFilePrompt() {
  const { stores, actions } = useWorkbench();
  const open = useFiles((state) => state.newFilePrompt);
  if (!open) return null;
  return (
    <TextPrompt
      title="新建电路文件"
      initial="circuit.circ"
      onClose={() => stores.files.getState().setNewFilePrompt(false)}
      onSubmit={actions.workspace.createFile}
    />
  );
}
