import { FileText } from "lucide-react";
import { useFiles, useView } from "../../workbench/hooks";

/** The active document's name, which opens its file information. */
export function FileTitle() {
  const { doc } = useView();
  const setInfoTarget = useFiles((state) => state.setInfoTarget);
  return (
    <div className="file-title">
      {doc && (
        <>
          <button title="文件信息与导出" onClick={() => setInfoTarget(doc.id)}>
            <FileText size={15} />
            {doc.name}
          </button>
          {doc.dirty && <span className="dirty-dot" title="有未保存的修改" />}
        </>
      )}
    </div>
  );
}
