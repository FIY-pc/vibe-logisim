import { TextPrompt } from "../../components/TextPrompt";
import { useFiles } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** Asks for a folder path where no native folder picker is available. */
export function FolderPrompt() {
  const { stores, actions } = useWorkbench();
  const folderPrompt = useFiles((state) => state.folderPrompt);
  if (!folderPrompt) return null;
  return (
    <TextPrompt
      title="打开文件夹"
      onClose={() => stores.files.getState().setFolderPrompt(false)}
      onSubmit={actions.workspace.openFolderAt}
    />
  );
}
