import { useState } from "react";
import { TextPrompt } from "../components/TextPrompt";
import type { ProjectFolder } from "../components/Files";
import { command, desktop } from "./transport";

/** Opens the folder at `path` as the project folder. */
export async function openFolderPath(
  path: string,
  onFolder: (folder: ProjectFolder) => void,
  onError: (error: unknown) => void,
) {
  const folder = await command<ProjectFolder>({ op: "folderOpen", path });
  onFolder(folder);
  if (folder.historyWarning)
    onError(`文件夹已打开；文件历史暂不可用：${folder.historyWarning}`);
}

/** Lets the user choose a folder: the system dialog in the desktop app,
 * otherwise `prompt` asks for a path. */
export async function chooseFolder(
  openPath: (path: string) => Promise<void>,
  prompt: () => void,
  onError: (error: unknown) => void,
) {
  if (!desktop()) {
    prompt();
    return;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true, multiple: false });
    if (typeof path === "string") await openPath(path);
  } catch (error) {
    onError(error);
  }
}

export function useFolderPicker(
  onFolder: (folder: ProjectFolder) => void,
  onError: (error: unknown) => void,
) {
  const [choosing, setChoosing] = useState(false);
  const openPath = (path: string) => openFolderPath(path, onFolder, onError);
  const openFolder = () =>
    chooseFolder(openPath, () => setChoosing(true), onError);
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
