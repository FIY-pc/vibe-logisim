import { DocumentHistory } from "./DocumentHistory";
import { showRight } from "../shell/store";
import { useDocuments, useShell, useView } from "../app/hooks";

/** The changes tab: the active document's history. */
export function ChangesRegion() {
  const { doc, circuit } = useView();
  const visible = useShell(
    (state) => state.right === "changes" && showRight(state),
  );
  const mergeDocument = useDocuments((state) => state.mergeDocument);
  return (
    <DocumentHistory
      doc={doc}
      circuit={circuit?.name || null}
      visible={visible}
      onDocument={mergeDocument}
    />
  );
}
