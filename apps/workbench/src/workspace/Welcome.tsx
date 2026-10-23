import { FolderOpen } from "lucide-react";
import { useFiles } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The editor area while no circuit is open. */
export function Welcome() {
  const { openFile, openFolder } = useWorkbench().actions.workspace;
  const folder = useFiles((state) => state.folder);
  return (
    <div className="welcome">
      <svg className="empty-symbol" aria-hidden="true" viewBox="0 0 180 120">
        <path d="M9 74h38V34h34v61h39V54h50" />
        <circle cx="9" cy="74" r="5" />
        <circle cx="47" cy="34" r="5" />
        <circle cx="81" cy="95" r="5" />
        <circle cx="120" cy="54" r="5" />
        <circle cx="170" cy="54" r="5" />
      </svg>
      <h1>{folder ? "选择一个电路" : "尚未打开项目"}</h1>
      <div>
        <button
          className="primary"
          onClick={folder ? openFile : () => void openFolder()}
        >
          <FolderOpen size={17} />
          {folder ? "打开电路" : "打开文件夹"}
        </button>
      </div>
    </div>
  );
}
