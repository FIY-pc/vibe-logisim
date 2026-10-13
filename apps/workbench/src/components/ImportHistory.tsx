import { useEffect, useRef, useState } from "react";
import { desktop } from "../lib/transport";
type Preview = {
  file: string;
  revision: string;
  workspaces: { key: string; count: number; titles: string[] }[];
};
export function ImportHistory({
  workspaceKey,
  request,
  onClose,
  onDone,
}: {
  workspaceKey: string;
  request: <T>(method: string, args: unknown) => Promise<T>;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function inspect(path: string) {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const next = await request<Preview>("previewHistory", { file: path });
      setPreview(next);
      setSourceKey(
        next.workspaces.find((w) => w.key === workspaceKey)?.key ||
          next.workspaces[0]?.key ||
          "",
      );
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="text-prompt decision-dialog"
      aria-label="导入旧版对话"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>导入旧版对话</header>
      <p>选择旧版的 sessions.json，将记录合并到当前工作区。</p>
      {desktop() ? (
        <button
          disabled={busy}
          onClick={async () => {
            const { open } = await import("@tauri-apps/plugin-dialog");
            const path = await open({
              multiple: false,
              filters: [{ name: "对话记录", extensions: ["json"] }],
            });
            if (typeof path === "string") {
              setFile(path);
              await inspect(path);
            }
          }}
        >
          选择记录文件
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void inspect(file);
          }}
        >
          <label>
            记录文件路径
            <input
              autoFocus
              required
              value={file}
              onChange={(e) => {
                setFile(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <button disabled={busy}>读取</button>
        </form>
      )}
      {preview && (
        <label>
          要导入的记录
          <select
            value={sourceKey}
            onChange={(e) => setSourceKey(e.target.value)}
            disabled={busy}
          >
            {preview.workspaces.map((w) => (
              <option key={w.key} value={w.key}>
                {w.titles.join("、") || "空白对话"} · {w.count} 条
              </option>
            ))}
          </select>
        </label>
      )}
      {preview && (
        <p>
          已有对话和原文件保留。Codex
          继续时使用新的会话，并携带文字记录；登录信息需重新设置。
        </p>
      )}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy || !preview || !sourceKey}
          onClick={async () => {
            if (!preview) return;
            setBusy(true);
            setError("");
            try {
              const result = await request<{
                imported: number;
                skipped: number;
              }>("importHistory", {
                file: preview.file,
                revision: preview.revision,
                sourceKey,
              });
              onDone(
                `已导入 ${result.imported} 条${result.skipped ? `，跳过 ${result.skipped} 条已有记录` : ""}`,
              );
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "正在处理…" : "导入"}
        </button>
      </footer>
    </dialog>
  );
}
