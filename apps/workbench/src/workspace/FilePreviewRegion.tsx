import { FilePreview } from "./FilePreview";
import { useFiles, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** A project file's preview; quoting it hands it to the conversation. */
export function FilePreviewRegion() {
  const { stores } = useWorkbench();
  const { doc } = useView();
  const preview = useFiles((state) => state.preview);
  if (!preview) return null;
  return (
    <FilePreview
      file={preview}
      onClose={() => stores.files.getState().setPreview(null)}
      onQuote={(reference) => {
        if (doc) {
          stores.conversation.getState().setQuotation({
            id: crypto.randomUUID(),
            documentId: doc.id,
            references: [reference],
          });
          stores.shell.getState().setRight("chat");
          stores.shell.getState().setSide("review", true);
        }
      }}
    />
  );
}
