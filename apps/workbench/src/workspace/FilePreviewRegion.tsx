import { FilePreview } from "./FilePreview";
import { useFiles, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { readerKey } from "./reader/types";

/** Material content only. Document identity and layout belong to DocumentWorkspace. */
export function FilePreviewRegion() {
  const { stores } = useWorkbench();
  const { doc } = useView();
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
        canQuote={!!doc}
        onError={stores.notices.getState().onError}
        onActivate={() => stores.files.getState().setEditorFocus("material")}
        onQuote={(reference) => {
          if (!doc) {
            stores.notices
              .getState()
              .onError(new Error("打开电路后可以引用资料"));
            return;
          }
          stores.conversation.getState().setQuotation({
            id: crypto.randomUUID(),
            documentId: doc.id,
            references: [reference],
          });
          stores.shell.getState().setRight("chat");
          stores.shell.getState().setSide("review", true);
        }}
      />
    </section>
  );
}
