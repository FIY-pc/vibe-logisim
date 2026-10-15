import { InterfaceEditor } from "../../components/InterfaceEditor";
import { useDocuments, useEditor } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** The interface and appearance editor of a circuit. */
export function InterfaceEditorRegion() {
  const { stores } = useWorkbench();
  const interfaceTarget = useEditor((state) => state.interfaceTarget);
  const mergeDocument = useDocuments((state) => state.mergeDocument);
  if (!interfaceTarget) return null;
  return (
    <InterfaceEditor
      doc={interfaceTarget.doc}
      circuit={interfaceTarget.circuit}
      onDocument={mergeDocument}
      onClose={() => stores.editor.getState().setInterfaceTarget(null)}
    />
  );
}
