import { memo } from "react";
import { FilePreview } from "./FilePreview";
import { useDocuments, useFiles } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { readerKey } from "./reader/types";

/** Keep the reader's expensive document tree independent of workspace updates.
 * Only the material and the document receiving quotations affect this region. */
export const FilePreviewRegion = memo(function FilePreviewRegion() {
  const { stores } = useWorkbench();
  const documentId = useDocuments(
    (state) => state.docs.find((doc) => doc.id === state.active)?.id ?? null,
  );
  const preview = useFiles((state) => state.preview);
  if (!preview) return null;
  return (
    <section className="document-reader" aria-label="资料阅读器">
      <FilePreview
        key={
          readerKey(preview) +
          ":" +
          (preview.revision || preview.pathVersion || "")
        }
        file={preview}
        canQuote={!!documentId}
        onError={stores.notices.getState().onError}
        onActivate={() => stores.files.getState().setEditorFocus("material")}
        onQuote={(reference) => {
          if (!documentId) {
            stores.notices
              .getState()
              .onError(new Error("打开电路后可以引用资料"));
            return;
          }
          stores.conversation.getState().setQuotation({
            id: crypto.randomUUID(),
            documentId,
            references: [reference],
          });
          stores.shell.getState().setRight("chat");
          stores.shell.getState().setSide("review", true);
        }}
      />
    </section>
  );
});
