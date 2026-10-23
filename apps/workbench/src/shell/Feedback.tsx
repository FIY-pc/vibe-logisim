import { useEffect, useRef, useState } from "react";
import { command, desktop } from "../shared/transport";
import type { JsonValue } from "../generated/serde_json/JsonValue";
import {
  Check,
  Download,
  ExternalLink,
  MessageSquare,
  RefreshCw,
  X,
} from "lucide-react";
import "./feedback.css";

const RELEASES = "https://github.com/FIY-pc/vibe-logisim/releases";
const ISSUES =
  "https://github.com/FIY-pc/vibe-logisim/issues/new?template=bug-report.yml";
interface UpdateStatus {
  enabled: boolean;
  forcedOff: boolean;
  current: string;
  development: boolean;
  latest: string | null;
  url: string | null;
  lastCheckedAt: number | null;
  newer: boolean;
  available: boolean;
  error: string | null;
}
interface DiagnosticReport {
  schema: number;
  appVersion: string;
  platform: string;
  architecture: string;
  nativeRuntimeAvailable: boolean;
  simulationActive: boolean;
  recoveryIssue: boolean;
}
export async function openFeedbackLink(url: string) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://github.com" ||
    !["/FIY-pc/vibe-logisim/releases", "/FIY-pc/vibe-logisim/issues/new"].some(
      (prefix) =>
        parsed.pathname === prefix || parsed.pathname.startsWith(prefix + "/"),
    )
  )
    throw new Error("链接不是项目的发布或反馈页面");
  if (desktop()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener,noreferrer");
}
export function useFeedback(
  onMessage: (message: string) => void,
  onError: (error: unknown) => void,
) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [closedVersion, setClosedVersion] = useState<string | null>(null);
  const callbacks = useRef({ onMessage, onError });
  callbacks.current = { onMessage, onError };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let canceled = false;
    const automatic = async () => {
      try {
        const previous = await command<UpdateStatus>({ op: "feedbackStatus" });
        if (canceled) return;
        setStatus(previous);
        if (!previous.enabled || previous.forcedOff) return;
        const next = await command<UpdateStatus>({
          op: "feedbackCheck",
          manual: false,
        });
        if (!canceled) setStatus(next);
      } catch {
        /* Automatic checks remain quiet; manual checks report failures. */
      }
    };
    void automatic();
    const timer = setInterval(() => void automatic(), 6 * 60 * 60 * 1000);
    return () => {
      canceled = true;
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  const checkNow = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const next = await command<UpdateStatus>({
        op: "feedbackCheck",
        manual: true,
      });
      if (!mounted.current) return;
      setStatus(next);
      setClosedVersion(null);
      if (next.error) throw new Error(next.error);
      if (next.forcedOff) callbacks.current.onMessage("此环境已关闭更新检查");
      else if (next.development)
        callbacks.current.onMessage(
          `当前 ${next.current}（开发版）；最新发布 ${next.latest ? "v" + next.latest : "未知"}`,
        );
      else if (!next.newer)
        callbacks.current.onMessage(`已是最新版本（${next.current}）`);
    } catch (error) {
      callbacks.current.onError(error);
    } finally {
      if (mounted.current) setChecking(false);
    }
  };
  const setAutomatic = async (enabled: boolean) => {
    try {
      setStatus(
        await command<UpdateStatus>({ op: "feedbackPreference", enabled }),
      );
    } catch (error) {
      callbacks.current.onError(error);
    }
  };
  const dismiss = async () => {
    if (!status?.latest) return;
    try {
      setStatus(
        await command<UpdateStatus>({
          op: "feedbackDismiss",
          version: status.latest,
        }),
      );
    } catch (error) {
      callbacks.current.onError(error);
    }
  };
  const openRelease = () =>
    openFeedbackLink(status?.url || RELEASES).catch(callbacks.current.onError);
  return {
    status,
    checking,
    dialogOpen,
    setDialogOpen,
    checkNow,
    setAutomatic,
    dismiss,
    openRelease,
    closeNotice: () => setClosedVersion(status?.latest || null),
    showNotice: Boolean(status?.available && status.latest !== closedVersion),
  };
}
export type FeedbackController = ReturnType<typeof useFeedback>;
export function FeedbackMenu({ feedback }: { feedback: FeedbackController }) {
  const { status } = feedback;
  return (
    <>
      <button onClick={() => feedback.setDialogOpen(true)}>
        <MessageSquare size={15} />
        反馈问题…
      </button>
      <button
        role="menuitemcheckbox"
        aria-checked={Boolean(status?.enabled && !status.forcedOff)}
        disabled={!status || status.forcedOff}
        onClick={() => void feedback.setAutomatic(!status?.enabled)}
      >
        <span className="feedback-menu-check">
          {status?.enabled && !status.forcedOff && <Check size={15} />}
        </span>
        自动检查更新
      </button>
      <button
        disabled={feedback.checking || status?.forcedOff}
        onClick={() => void feedback.checkNow()}
      >
        <RefreshCw size={15} />
        {feedback.checking ? "正在检查…" : "立即检查更新"}
      </button>
      <button onClick={() => void feedback.openRelease()}>
        关于 Vibe Logisim {status?.current || ""}
        <ExternalLink size={14} />
      </button>
    </>
  );
}
export function UpdateNotice({ feedback }: { feedback: FeedbackController }) {
  if (!feedback.showNotice) return null;
  return (
    <aside className="update-notice" aria-label="版本更新">
      <span>新版本 v{feedback.status?.latest} 可用</span>
      <button onClick={() => void feedback.openRelease()}>查看更新</button>
      <button onClick={() => void feedback.dismiss()}>忽略此版本</button>
      <button
        onClick={feedback.closeNotice}
        title="关闭"
        aria-label="关闭更新提示"
      >
        <X size={14} />
      </button>
    </aside>
  );
}
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [replacement, setReplacement] = useState<{
    path: string;
    revision: string;
  } | null>(null);
  useEffect(() => {
    let live = true;
    dialog.current?.showModal();
    void command<DiagnosticReport>({ op: "diagnostics" })
      .then((value) => {
        if (live) setReport(value);
      })
      .catch((error) => {
        if (live) setError(String(error));
      });
    return () => {
      live = false;
      dialog.current?.close();
    };
  }, []);
  const text = report ? JSON.stringify(report, null, 2) + "\n" : "";
  const finish = async (path: string, expected_revision?: string) => {
    if (!report) return;
    await command({
      op: "diagnosticsExport",
      path,
      report: report as unknown as JsonValue,
      expected_revision,
    });
    setSaved(true);
    setReplacement(null);
  };
  const save = async () => {
    if (!report || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!desktop()) {
        const url = URL.createObjectURL(
          new Blob([text], { type: "application/json" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "vibe-logisim-diagnostics.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setSaved(true);
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: "vibe-logisim-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const target = await command<{ revision: string | null }>({
        op: "saveTarget",
        path,
      });
      if (target.revision) {
        setReplacement({ path, revision: target.revision });
        return;
      }
      await finish(path);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const replace = async () => {
    if (!replacement || busy) return;
    setBusy(true);
    setError("");
    try {
      await finish(replacement.path, replacement.revision);
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
      className="text-prompt feedback-dialog"
      aria-label="反馈问题"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <strong>反馈问题</strong>
        <button disabled={busy} aria-label="关闭反馈" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <p>诊断文件只包含下方内容。</p>
      <textarea
        readOnly
        aria-label="诊断预览"
        value={report ? text : "正在生成预览…"}
      />
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      {replacement ? (
        <>
          <p>目标文件已存在。确认后将替换它。</p>
          <footer>
            <button disabled={busy} onClick={() => setReplacement(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void replace()}
            >
              替换文件
            </button>
          </footer>
        </>
      ) : (
        <footer>
          <button disabled={!report || busy} onClick={() => void save()}>
            <Download size={15} />
            {busy
              ? "正在保存…"
              : saved
                ? "再次保存诊断"
                : desktop()
                  ? "保存诊断…"
                  : "下载诊断"}
          </button>
          <button
            className="primary"
            disabled={!saved || busy}
            title={saved ? undefined : "先检查并保存诊断文件"}
            onClick={() =>
              void openFeedbackLink(ISSUES).catch((error) =>
                setError(String(error)),
              )
            }
          >
            前往反馈页
            <ExternalLink size={14} />
          </button>
        </footer>
      )}
    </dialog>
  );
}
