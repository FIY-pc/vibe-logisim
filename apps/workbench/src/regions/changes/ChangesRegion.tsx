import { DocumentHistory } from "../../components/DocumentHistory";
import { showRight } from "../../stores/shell";
import {
  useDocuments,
  useNotices,
  useShell,
  useSimulation,
  useView,
} from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** The changes tab: the active document's history and proposals. */
export function ChangesRegion() {
  const { actions } = useWorkbench();
  const view = useView();
  const { doc, circuit } = view;
  const visible = useShell(
    (state) => state.right === "changes" && showRight(state),
  );
  const mergeDocument = useDocuments((state) => state.mergeDocument);
  const onError = useNotices((state) => state.onError);
  return (
    <DocumentHistory
      doc={doc}
      circuit={circuit?.name || null}
      visible={visible}
      onError={onError}
      onDocument={mergeDocument}
      onLocate={(change) => actions.navigation.locateChange(view, change)}
    />
  );
}
