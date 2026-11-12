import { Button } from "../design/ui";
import { FolderOpen, GraduationCap } from "lucide-react";
import { useClassroom } from "../classroom/Classroom";
import { FeedbackMenu, type FeedbackController } from "../shell/Feedback";
import { Menu, MenuItem, MenuSeparator, MenuSub } from "../shared/Menu";
import { bindingLabel } from "../shared/shortcuts";
import { desktop } from "../shared/transport";
import {
  useFiles,
  useNotices,
  useSettings,
  useShell,
  useView,
} from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The open-folder button and the menu of file, search and app commands. */
export function FileMenu({ feedback }: { feedback: FeedbackController }) {
  const { stores, actions } = useWorkbench();
  const classroom = useClassroom();
  const view = useView();
  const { doc } = view;
  const pending = useShell((state) => state.pending);
  const folder = useFiles((state) => state.folder);
  const recentProjects = useFiles((state) => state.recentProjects);
  const recentError = useFiles((state) => state.recentError);
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
      <Button
        variant="ghost"
        color="gray"
        className="open-folder"
        onClick={() => void openFolder()}
      >
        <FolderOpen size={16} /> 打开文件夹
      </Button>
      <Menu label="更多" title="更多：文件、查找、设置与帮助">
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
        <MenuSub label="打开最近的项目">
          {recentProjects.map((project) => (
            <MenuItem
              key={project.path}
              disabled={busy}
              onSelect={() =>
                void workspace.openFolderAt(project.path).catch(onError)
              }
            >
              <span title={project.path}>
                {project.name}
                {!project.available && "（路径不可用）"}
                <small className="recent-menu-path">{project.path}</small>
              </span>
            </MenuItem>
          ))}
          {!recentProjects.length && (
            <MenuItem disabled>
              {recentError ? "最近项目暂不可用" : "暂无最近项目"}
            </MenuItem>
          )}
        </MenuSub>
        <MenuItem
          disabled={!folder || busy}
          onSelect={() => void workspace.closeFolder()}
        >
          关闭文件夹
        </MenuItem>
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
          icon={<GraduationCap size={16} />}
          title={classroom.status || undefined}
          trailing={classroom.sharing ? "自动同步" : undefined}
          onSelect={classroom.show}
        >
          课堂管理…
        </MenuItem>
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
      {classroom.dialog}
    </>
  );
}
