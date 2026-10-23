import { Ellipsis, FolderOpen } from "lucide-react";
import { FeedbackMenu, type FeedbackController } from "../shell/Feedback";
import { Menu, MenuItem, MenuSeparator, MenuSub } from "../shared/Menu";
import { bindingLabel } from "../shared/shortcuts";
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
  const busy = Boolean(pending);
  return (
    <>
      <button className="open-folder" onClick={() => void openFolder()}>
        <FolderOpen size={16} /> 打开文件夹
      </button>
      <Menu
        label="更多"
        title="更多：文件、查找、设置与帮助"
        trigger={<Ellipsis size={16} aria-hidden="true" />}
      >
        <MenuItem
          shortcut={bindingLabel("Mod+N")}
          onSelect={() => void newFile()}
        >
          新建电路
        </MenuItem>
        <MenuItem shortcut={bindingLabel("Mod+O")} onSelect={openFile}>
          打开…
        </MenuItem>
        <MenuItem onSelect={() => void openFolder()}>打开文件夹…</MenuItem>
        <MenuSeparator />
        <MenuItem
          shortcut={shortcuts.save}
          disabled={!doc || busy}
          onSelect={() => save()}
        >
          保存
        </MenuItem>
        <MenuItem
          shortcut={bindingLabel("Mod+Shift+S")}
          disabled={!doc || busy}
          onSelect={() => save(true)}
        >
          {desktop() ? "另存为…" : "下载副本"}
        </MenuItem>
        <MenuItem
          disabled={!doc?.path || busy}
          onSelect={() => void workspace.requestReload(view).catch(onError)}
        >
          重新载入
        </MenuItem>
        <MenuItem
          shortcut={bindingLabel("Mod+W")}
          disabled={!doc || busy}
          onSelect={() => doc && requestClose(doc)}
        >
          关闭文档
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={!doc} onSelect={() => doc && setInfoTarget(doc.id)}>
          文件信息与导出…
        </MenuItem>
        <MenuItem
          disabled={!doc}
          onSelect={() => void editing.readSource(view)}
        >
          编辑源文件…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          shortcut={shortcuts.find}
          disabled={!doc}
          onSelect={() => setFind("component")}
        >
          查找元件…
        </MenuItem>
        <MenuItem
          shortcut={shortcuts.circuitSearch}
          disabled={!doc}
          onSelect={() => setFind("circuit")}
        >
          查找电路…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          shortcut={bindingLabel("Mod+,")}
          onSelect={() => stores.settings.getState().setOpen(true)}
        >
          快捷键设置…
        </MenuItem>
        <MenuSub label="帮助与反馈">
          <FeedbackMenu feedback={feedback} />
        </MenuSub>
      </Menu>
    </>
  );
}
