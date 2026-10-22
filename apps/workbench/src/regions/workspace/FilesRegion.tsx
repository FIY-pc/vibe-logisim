import { useRef } from "react";
import { Files } from "../../components/Files";
import { fileReference } from "../../lib/fileReference";
import { useFiles, useNotices, useView } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** The project folder's file tree in the rail. */
export function FilesRegion() {
  const { stores, actions } = useWorkbench();
  const { doc } = useView();
  const live = useRef(doc);
  live.current = doc;
  const folder = useFiles((state) => state.folder);
  const onError = useNotices((state) => state.onError);
  const { refreshWorkspace } = stores.documents.getState();
  // A file dropped on the conversation is quoted whole, like a viewer page.
  const reference = async (paths: string[]) => {
    const folder = stores.files.getState().folder,
      doc = live.current;
    if (!folder || !paths.length) return;
    if (!doc) throw new Error("打开电路后可以引用文件");
    if (paths.length > 8) throw new Error("每条问题最多引用 8 处资料或观察");
    const references = await Promise.all(
      paths.map((path) => fileReference(folder.id, path)),
    );
    stores.conversation.getState().setQuotation({
      id: crypto.randomUUID(),
      documentId: doc.id,
      references,
    });
  };
  return (
    <Files
      folder={folder}
      activePath={doc?.path || null}
      onFolder={actions.workspace.onFolder}
      onRename={() => refreshWorkspace()}
      onOpen={actions.workspace.openDocument}
      onPreview={stores.files.getState().setPreview}
      onError={onError}
      onReference={(paths) => void reference(paths).catch(onError)}
      onReferenceHover={stores.conversation.getState().setReferenceDrop}
    />
  );
}
