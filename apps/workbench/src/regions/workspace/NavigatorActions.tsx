import { FilePlus2, FolderOpen } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { useWorkbench } from "../../workbench/provider";

/** The rail navigator's open and new file buttons. */
export function NavigatorActions() {
  const { openFile, newFile } = useWorkbench().actions.workspace;
  return (
    <>
      <IconButton
        title="打开电路"
        icon={<FolderOpen size={15} />}
        onClick={openFile}
      />
      <IconButton
        title="新建电路文件"
        icon={<FilePlus2 size={15} />}
        onClick={() => void newFile()}
      />
    </>
  );
}
