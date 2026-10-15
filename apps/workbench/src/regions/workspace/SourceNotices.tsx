import { desktop } from "../../lib/transport";
import { sourceStatusOf } from "../../stores/documents";
import {
  useDocuments,
  useNotices,
  useShell,
  useView,
} from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** Notices about the active document's source file and failed saves. */
export function SourceNotices() {
  const { actions } = useWorkbench();
  const view = useView();
  const { doc } = view;
  const sourceStatus = useDocuments((state) => sourceStatusOf(state, doc));
  const saveFailures = useDocuments((state) => state.saveFailures);
  const recheck = useDocuments((state) => state.recheck);
  const pending = useShell((state) => state.pending);
  const onError = useNotices((state) => state.onError);
  if (!doc) return null;
  const save = (saveAs = false) => actions.workspace.save(view, saveAs);
  return (
    <>
      {sourceStatus &&
        !["unchanged", "untitled"].includes(sourceStatus.state) && (
          <div className="source-notice" role="status">
            <span>
              {sourceStatus.state === "modified"
                ? "源文件已被其他程序修改"
                : sourceStatus.state === "missing"
                  ? "原文件已被移除"
                  : "无法读取源文件"}
            </span>
            {sourceStatus.state === "modified" && (
              <button
                disabled={Boolean(pending)}
                onClick={() =>
                  void actions.workspace.requestReload(view).catch(onError)
                }
              >
                重新载入
              </button>
            )}
            <button disabled={Boolean(pending)} onClick={() => save(true)}>
              {desktop() ? "另存为…" : "下载副本"}
            </button>
            {sourceStatus.state === "unreadable" && (
              <button onClick={recheck}>重试</button>
            )}
          </div>
        )}
      {saveFailures[doc.id] && (
        <div className="source-notice" role="alert">
          <span>修改已保留，写回文件失败：{saveFailures[doc.id]}</span>
          <button disabled={Boolean(pending)} onClick={() => save()}>
            重试保存
          </button>
        </div>
      )}
    </>
  );
}
