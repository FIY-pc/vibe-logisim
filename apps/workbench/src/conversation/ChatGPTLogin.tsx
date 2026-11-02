import { useEffect, useRef, useState } from "react";
import { desktop } from "../shared/transport";
import type { ProviderConfiguration } from "./ProviderSettings";

const USAGE = "https://chatgpt.com/settings/usage";
export async function openChatGPTLink(url: string) {
  const parsed = new URL(url);
  if (!(
    (parsed.origin === "https://auth.openai.com" &&
      parsed.pathname === "/api/accounts/authorize") ||
    url === USAGE
  ))
    throw new Error("ChatGPT 链接无效");
  if (desktop()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
export function ChatGPTUsage() {
  return (
    <a
      href={USAGE}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (desktop()) {
          e.preventDefault();
          void openChatGPTLink(USAGE);
        }
      }}
    >
      管理用量
    </a>
  );
}
interface Login {
  attemptId: string;
  url: string;
}
export function ChatGPTLogin({
  services,
  busy,
  request,
  onSaved,
  providerId,
  canBind,
  onChoose,
}: {
  services: ProviderConfiguration[];
  busy: boolean;
  request: <T>(method: string, args?: unknown) => Promise<T>;
  onSaved: () => Promise<unknown>;
  providerId?: string;
  canBind?: boolean;
  onChoose?: (service: ProviderConfiguration) => void;
}) {
  const [login, setLogin] = useState<Login | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [welcome, setWelcome] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pending.current)
        void request("cancelChatGPTLogin", {
          attemptId: pending.current,
        }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!login) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request<{
          status: string;
          error?: string;
          serviceId?: string;
          welcome?: boolean;
        }>("chatGPTLoginStatus", { attemptId: login.attemptId });
        if (cancelled) return;
        if (result.status === "pending") {
          timer = setTimeout(() => void poll(), 800);
          return;
        }
        pending.current = null;
        setLogin(null);
        if (result.status === "complete") {
          if (result.welcome) setWelcome(result.serviceId!);
          else setMessage("已登录 ChatGPT");
          await onSaved();
        } else setMessage(result.error || "已取消登录");
      } catch (e) {
        if (cancelled) return;
        setMessage(e instanceof Error ? e.message : String(e));
        timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login]);
  const begin = async (id?: string, consent = false) => {
    setWorking(true);
    setMessage("");
    try {
      const result = await request<Login>("loginChatGPT", { id, consent });
      if (!mounted.current) {
        await request("cancelChatGPTLogin", { attemptId: result.attemptId });
        return;
      }
      pending.current = result.attemptId;
      setLogin(result);
      await openChatGPTLink(result.url);
    } catch (e) {
      if (mounted.current)
        setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setWorking(false);
    }
  };
  const cancel = async () => {
    if (!login) return;
    await request("cancelChatGPTLogin", { attemptId: login.attemptId });
    pending.current = null;
    setLogin(null);
    setMessage("已取消登录");
  };
  const logout = async (id: string) => {
    setWorking(true);
    setMessage("");
    try {
      const result = await request<{ warning?: string }>("logoutChatGPT", {
        id,
      });
      setMessage(result.warning || "已退出 ChatGPT 登录");
      await onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="ai-chatgpt" aria-label="ChatGPT 登录">
      <strong>使用 ChatGPT 订阅</strong>
      <p>登录 ChatGPT，用订阅额度完成电路工作。</p>
      {services
        .filter((s) => s.auth === "chatgpt")
        .map((s) => (
          <div className="ai-chatgpt-account" key={s.id}>
            <div>
              <strong>
                {s.name}
                {s.id === providerId && canBind && (
                  <span className="ai-settings-badge">此对话</span>
                )}
              </strong>
              <small>{s.model}</small>
              <small>
                {!s.account?.connected
                  ? "已退出登录"
                  : s.account.planEnabled
                    ? "使用 ChatGPT 订阅额度"
                    : "尚未授权使用订阅额度"}
              </small>
            </div>
            {(!s.account?.connected || !s.account.planEnabled) && (
              <button
                data-oai-siwc-button
                disabled={busy || working || Boolean(login)}
                onClick={() =>
                  void begin(
                    s.id,
                    Boolean(s.account?.connected && !s.account.planEnabled),
                  )
                }
              >
                Continue with ChatGPT
              </button>
            )}
            {s.id !== providerId &&
              s.account?.connected &&
              s.account.planEnabled &&
              onChoose && (
                <button
                  disabled={busy || working || !canBind}
                  onClick={() => onChoose(s)}
                >
                  用于此对话
                </button>
              )}
            {s.account?.connected && (
              <button
                disabled={busy || working || Boolean(login)}
                onClick={() => void logout(s.id!)}
              >
                退出登录
              </button>
            )}
          </div>
        ))}
      {login ? (
        <div className="ai-chatgpt-waiting" role="status">
          <p>请在浏览器中完成登录与授权。</p>
          <button
            onClick={() =>
              void openChatGPTLink(login.url).catch((e) =>
                setMessage(String(e)),
              )
            }
          >
            打开登录页面
          </button>
          <button
            onClick={() => void cancel().catch((e) => setMessage(String(e)))}
          >
            取消登录
          </button>
        </div>
      ) : (
        <button
          className="ai-chatgpt-signin"
          data-oai-siwc-button
          disabled={busy || working}
          onClick={() => void begin()}
        >
          Continue with ChatGPT
        </button>
      )}
      {welcome && (
        <div className="ai-chatgpt-welcome" role="status">
          <strong>正在使用你的 ChatGPT 订阅</strong>
          <p>
            选择这个账号后，AI 请求会使用它的 ChatGPT 额度。你可以在 ChatGPT
            设置中管理应用用量。
          </p>
          <button
            onClick={() =>
              void request("acknowledgeChatGPT", { id: welcome })
                .then(() => setWelcome(null))
                .catch((e) => setMessage(String(e)))
            }
          >
            知道了
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      <ChatGPTUsage />
    </section>
  );
}
