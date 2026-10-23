import { useEffect, useState } from "react";
import { Copy, Download } from "lucide-react";
import { command, desktop } from "../shared/transport";
import type { Document } from "../shared/types";
import "./ProjectInfo.css";
import { DialogClose, useModal } from "../shared/Dialog";
interface Info {
  documentId: string;
  revision: string;
  name: string;
  path: string | null;
  dirty: boolean;
  circuits: number;
  builtInLibraries: number;
  libraries: {
    name: string;
    kind: string;
    available: boolean;
    error?: string;
  }[];
  issues: string[];
  exportable: boolean;
  runtimeAvailable: boolean;
  runtimeVersion: string | null;
  sourceStatus: { state: string };
  entry: string;
}
export function ProjectInfo({
  doc,
  onClose,
}: {
  doc: Document;
  onClose: () => void;
}) {
  const dialog = useModal();
  const [info, setInfo] = useState<Info | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const [replacement, setReplacement] = useState<{
    path: string;
    revision: string;
  } | null>(null);
  useEffect(() => {
    let live = true;
    setInfo(null);
    setSaved(false);
    setReplacement(null);
    setError("");
    void command<Info>({
      op: "projectInfo",
      id: doc.id,
      revision: doc.revision,
    })
      .then((value) => {
        if (live) setInfo(value);
      })
      .catch((error) => {
        if (live) setError(String(error));
      });
    return () => {
      live = false;
    };
  }, [doc.id, doc.revision, doc.path]);
  const exportFile = async (path?: string, expected_revision?: string) => {
    if (!info) return;
    const result = await command<{ data?: string; name: string }>({
      op: "projectExport",
      id: info.documentId,
      revision: info.revision,
      path,
      expected_revision,
    });
    if (result.data) {
      const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = result.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    setReplacement(null);
    setSaved(true);
  };
  const download = async () => {
    if (!info || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      if (replacement) {
        await exportFile(replacement.path, replacement.revision);
        return;
      }
      if (!desktop()) {
        await exportFile();
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: info.name.replace(/\.circ$/i, "") + ".zip",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!path) return;
      const target = await command<{ revision: string | null }>({
        op: "projectExportTarget",
        path,
      });
      if (target.revision) {
        setReplacement({ path, revision: target.revision });
        return;
      }
      await exportFile(path);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setReplacement(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="text-prompt project-info"
      aria-label="文件信息"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>{doc.name}</h2>
        <DialogClose label="关闭文件信息" disabled={busy} onClick={onClose} />
      </header>
      {info && (
        <>
          <div className="project-source">
            <span>{info.path || "未命名文件"}</span>
            {info.path && (
              <button
                title="复制路径"
                aria-label="复制源文件路径"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(info.path!)
                    .catch((error) => setError(String(error)))
                }
              >
                <Copy size={15} />
              </button>
            )}
          </div>
          <dl>
            <dt>电路</dt>
            <dd>{info.circuits}</dd>
            <dt>Logisim 运行版本</dt>
            <dd>
              {info.runtimeVersion ||
                (info.runtimeAvailable ? "尚未载入" : "不可用")}
            </dd>
            <dt>内置组件库</dt>
            <dd>{info.builtInLibraries}</dd>
          </dl>
          {info.libraries.length > 0 && (
            <section aria-label="外部组件库">
              <h3>外部组件库</h3>
              <ul>
                {info.libraries.map((library, index) => (
                  <li key={index}>
                    <span>{library.name}</span>
                    <small className={library.available ? "" : "dialog-error"}>
                      {library.available
                        ? library.kind === "jar"
                          ? "JAR"
                          : "电路"
                        : library.error}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {info.sourceStatus.state === "modified" && (
            <p role="alert" className="project-warning">
              磁盘文件已改变，导出使用当前打开的版本。
            </p>
          )}
          {info.sourceStatus.state === "missing" && (
            <p role="alert" className="project-warning">
              源文件已移除，导出使用当前打开的版本。
            </p>
          )}
          {info.sourceStatus.state === "unreadable" && (
            <p role="alert" className="project-warning">
              源文件无法读取，导出使用当前打开的版本。
            </p>
          )}
          {info.dirty && <p className="muted">导出包含当前未保存的改动。</p>}
        </>
      )}
      {!info && !error && <p role="status">正在读取…</p>}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">工程包已导出。</p>}
      {replacement && <p>目标文件已存在，确认替换？</p>}
      <footer>
        {replacement && (
          <button disabled={busy} onClick={() => setReplacement(null)}>
            取消
          </button>
        )}
        <button
          className="primary"
          disabled={!info?.exportable || busy}
          onClick={() => void download()}
        >
          <Download size={15} />
          {busy ? "正在导出…" : replacement ? "替换文件" : "导出工程 ZIP"}
        </button>
      </footer>
    </dialog>
  );
}
