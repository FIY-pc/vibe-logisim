import { Files } from "../../components/Files";
import { useFiles, useNotices, useView } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** The project folder's file tree in the rail. */
export function FilesRegion() {
  const { stores, actions } = useWorkbench();
  const { doc } = useView();
  const folder = useFiles((state) => state.folder);
  const onError = useNotices((state) => state.onError);
  const { refreshWorkspace } = stores.documents.getState();
  return (
    <Files
      folder={folder}
      activePath={doc?.path || null}
      onFolder={actions.workspace.onFolder}
      onRename={() => refreshWorkspace()}
      onOpen={actions.workspace.openDocument}
      onPreview={stores.files.getState().setPreview}
      onError={onError}
    />
  );
}
