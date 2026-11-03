import { ActionRow, Button, Text } from "../design/ui";
import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge, Card, Flex, Link } from "@radix-ui/themes";
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
function ChatGPTUsage() {
  return (
    <Link
      size="2"
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
    </Link>
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
        }>("chatGPTLoginStatus", { attemptId: login.attemptId });
        if (cancelled) return;
        if (result.status === "pending") {
          timer = setTimeout(() => void poll(), 800);
          return;
        }
        pending.current = null;
        setLogin(null);
        if (result.status === "complete") {
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
    <Flex asChild direction="column" gap="3">
      <section
        className="ai-chatgpt"
        aria-label="ChatGPT 登录"
        aria-busy={working}
      >
        <ActionRow
          variant="soft"
          color="gray"
          className="ai-service-option"
          data-oai-siwc-button
          disabled={busy || working || Boolean(login)}
          onClick={() => void begin()}
        >
          使用 ChatGPT 订阅
          <ChevronRight size={16} aria-hidden="true" />
        </ActionRow>
        {services
          .filter((s) => s.auth === "chatgpt")
          .map((s) => (
            <Card key={s.id}>
              <Flex gap="3" wrap="wrap" align="start">
                <Flex
                  direction="column"
                  gap="2"
                  flexGrow="1"
                  className="ai-service-details"
                >
                  <Flex gap="2" align="center" wrap="wrap">
                    <Text weight="medium">{s.name}</Text>
                    {s.id === providerId && canBind && (
                      <Badge size="2">此对话</Badge>
                    )}
                  </Flex>
                  <Text color="gray">{s.model}</Text>
                  {(!s.account?.connected || !s.account.planEnabled) && (
                    <Text color="gray">
                      {!s.account?.connected
                        ? "已退出登录"
                        : "尚未授权使用订阅额度"}
                    </Text>
                  )}
                </Flex>
                <Flex gap="2" wrap="wrap">
                  {(!s.account?.connected || !s.account.planEnabled) && (
                    <Button
                      variant="soft"
                      data-oai-siwc-button
                      disabled={busy || working || Boolean(login)}
                      onClick={() =>
                        void begin(
                          s.id,
                          Boolean(
                            s.account?.connected && !s.account.planEnabled,
                          ),
                        )
                      }
                    >
                      Continue with ChatGPT
                    </Button>
                  )}
                  {s.id !== providerId &&
                    s.account?.connected &&
                    s.account.planEnabled &&
                    onChoose && (
                      <Button
                        variant="soft"
                        disabled={busy || working || Boolean(login) || !canBind}
                        onClick={() => onChoose(s)}
                      >
                        用于此对话
                      </Button>
                    )}
                  {s.account?.connected && (
                    <Button
                      variant="soft"
                      color="gray"
                      disabled={busy || working || Boolean(login)}
                      onClick={() => void logout(s.id!)}
                    >
                      退出登录
                    </Button>
                  )}
                </Flex>
              </Flex>
            </Card>
          ))}
        {login && (
          <Card role="status">
            <Text as="p" mb="3">
              请在浏览器中完成登录与授权。
            </Text>
            <Flex gap="3" wrap="wrap">
              <Button
                variant="soft"
                onClick={() =>
                  void openChatGPTLink(login.url).catch((e) =>
                    setMessage(String(e)),
                  )
                }
              >
                打开登录页面
              </Button>
              <Button
                variant="soft"
                color="gray"
                onClick={() =>
                  void cancel().catch((e) => setMessage(String(e)))
                }
              >
                取消登录
              </Button>
            </Flex>
          </Card>
        )}
        {message && (
          <Text as="p" role="status">
            {message}
          </Text>
        )}
        {services.some((s) => s.auth === "chatgpt" && s.account?.connected) && (
          <ChatGPTUsage />
        )}
      </section>
    </Flex>
  );
}
