import { Ellipsis, FolderOpen } from "lucide-react";
import { FeedbackMenu, type FeedbackController } from "../shell/Feedback";
import { desktop } from "../shared/transport";
import { useNotices, useSettings, useShell, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The open-folder button and the menu of file, search and app commands. */
export function FileMenu({ feedback }: { feedback: FeedbackController }) {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc } = view;
  const pending = useShell((state) => state.pending);
  const shortcuts = useSettings((state) => state.labels);
  const onError = useNotices((state) => state.onError);
  const { workspace, editor: editing } = actions;
  const { newFile, openFile, openFolder, requestClose } = workspace;
  const { setInfoTarget } = stores.files.getState();
  const { setFind } = stores.editor.getState();
  const save = (saveAs = false) => workspace.save(view, saveAs);
  return (
    <>
      <button className="open-folder" onClick={() => void openFolder()}>
        <FolderOpen size={17} /> 打开文件夹
      </button>
      <details className="menu">
        <summary aria-label="更多" title="更多：文件、快捷键、反馈与更新">
          <Ellipsis size={18} />
        </summary>
        <div className="menu-content">
          <button aria-label="新建电路文件" onClick={() => void newFile()}>
            新建电路 <kbd>Ctrl N</kbd>
          </button>
          <button onClick={openFile}>
            打开… <kbd>Ctrl O</kbd>
          </button>
          <button onClick={() => void openFolder()}>打开文件夹…</button>
          <button disabled={!doc || Boolean(pending)} onClick={() => save()}>
            保存 <kbd>{shortcuts.save}</kbd>
          </button>
          <button
            disabled={!doc || Boolean(pending)}
            onClick={() => save(true)}
          >
            {desktop() ? "另存为…" : "下载副本"} <kbd>Ctrl Shift S</kbd>
          </button>
          <button
            disabled={!doc?.path || Boolean(pending)}
            onClick={() => void workspace.requestReload(view).catch(onError)}
          >
            重新载入
          </button>
          <button
            disabled={!doc || Boolean(pending)}
            onClick={() => doc && requestClose(doc)}
          >
            关闭文档 <kbd>Ctrl W</kbd>
          </button>
          <button
            disabled={!doc}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              if (doc) setInfoTarget(doc.id);
            }}
          >
            文件信息与导出…
          </button>
          <button disabled={!doc} onClick={() => setFind("component")}>
            查找元件… <kbd>{shortcuts.find}</kbd>
          </button>
          <button disabled={!doc} onClick={() => setFind("circuit")}>
            查找电路… <kbd>{shortcuts.circuitSearch}</kbd>
          </button>
          <button disabled={!doc} onClick={() => void editing.readSource(view)}>
            编辑源文件
          </button>
          <button
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              stores.settings.getState().setOpen(true);
            }}
          >
            快捷键设置
          </button>
          <FeedbackMenu feedback={feedback} />
        </div>
      </details>
    </>
  );
}
