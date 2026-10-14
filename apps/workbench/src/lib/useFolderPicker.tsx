import { useState } from "react";
import { TextPrompt } from "../components/TextPrompt";
import type { ProjectFolder } from "../components/Files";
import { command, desktop } from "./transport";

export function useFolderPicker(
  onFolder: (folder: ProjectFolder) => void,
  onError: (error: unknown) => void,
) {
  const [choosing, setChoosing] = useState(false);
  const openPath = async (path: string) => {
    const folder = await command<ProjectFolder>({ op: "folderOpen", path });
    onFolder(folder);
    if (folder.historyWarning)
      onError(`文件夹已打开；文件历史暂不可用：${folder.historyWarning}`);
  };
  const openFolder = async () => {
    if (!desktop()) {
      setChoosing(true);
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ directory: true, multiple: false });
      if (typeof path === "string") await openPath(path);
    } catch (error) {
      onError(error);
    }
  };
  return {
    openFolder,
    folderDialog: choosing ? (
      <TextPrompt
        title="打开文件夹"
        onClose={() => setChoosing(false)}
        onSubmit={openPath}
      />
    ) : null,
  };
}
