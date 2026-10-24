import { FileText } from "lucide-react";
import { useFiles, useView } from "../app/hooks";

/** The active document's name, which opens its file information. */
export function FileTitle() {
  const { doc } = useView();
  const setInfoTarget = useFiles((state) => state.setInfoTarget);
  return (
    <div className="file-title">
      {doc && (
        <>
          <button
            data-tip="文件信息与导出"
            onClick={() => setInfoTarget(doc.id)}
          >
            <FileText size={15} />
            {doc.name}
          </button>
          {doc.dirty && (
            <span
              className="dirty-dot"
              role="img"
              aria-label="有未保存的修改"
              data-tip="有未保存的修改"
            />
          )}
        </>
      )}
    </div>
  );
}
