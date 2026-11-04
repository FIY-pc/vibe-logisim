import { useRef } from "react";
import { Files } from "./Files";
import { useFiles, useNotices, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The project folder's file tree in the rail. */
export function FilesRegion() {
  const { stores, actions } = useWorkbench();
  const { doc } = useView();
  const live = useRef(doc);
  live.current = doc;
  const folder = useFiles((state) => state.folder);
  const version = useFiles((state) => state.treeVersion);
  const onError = useNotices((state) => state.onError);
  const { refreshWorkspace } = stores.documents.getState();
  // A file dropped on the conversation is quoted whole, like a viewer page.
  const reference = (paths: string[]) => {
    const folder = stores.files.getState().folder,
      doc = live.current;
    if (!folder || !paths.length) return;
    if (!doc) throw new Error("打开电路后可以引用文件");
    stores.conversation.getState().setQuotation({
      id: crypto.randomUUID(),
      documentId: doc.id,
      files: { folderId: folder.id, paths },
    });
  };
  return (
    <Files
      folder={folder}
      version={version}
      activePath={doc?.path || null}
      onFolder={actions.workspace.onFolder}
      onCloseFolder={() => void actions.workspace.closeFolder()}
      onRename={() => refreshWorkspace()}
      onOpen={actions.workspace.openDocument}
      onPreview={stores.files.getState().setPreview}
      onError={onError}
      onReference={(paths) => {
        try {
          reference(paths);
        } catch (error) {
          onError(error);
        }
      }}
      onReferenceHover={stores.conversation.getState().setReferenceDrop}
    />
  );
}
