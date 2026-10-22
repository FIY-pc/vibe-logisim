import { FindDialog } from "../../components/FindDialog";
import { useEditor, useSimulation, useView } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** Finds a component or circuit of the active document and shows it. */
export function FindRegion() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc, circuit } = view;
  const find = useEditor((state) => state.find);
  if (!find || !doc || !circuit) return null;
  const { navigation } = actions;
  return (
    <FindDialog
      mode={find}
      doc={doc}
      circuit={circuit}
      onClose={() => stores.editor.getState().setFind(null)}
      onChoose={(name, id) =>
        id
          ? navigation.focusObject(view, name, id)
          : navigation.switchCircuit(view, name)
      }
    />
  );
}
