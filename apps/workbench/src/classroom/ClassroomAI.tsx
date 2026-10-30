import { useState } from "react";
import { Select } from "../shared/Select";
import { Checkbox } from "../shared/Checkbox";
import { command } from "../shared/transport";
import {
  ProviderSettings,
  type ProviderConfiguration,
} from "../conversation/ProviderSettings";
import { serverAddress, type ClassroomSession } from "./client";
import type { ClassroomProvider } from "../../../../packages/classroom/src/types";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Run = (work: () => Promise<void>) => Promise<void>;
const agent = <T,>(method: string, args: unknown = {}) =>
  command<T>({ op: "agent", method, args: args as any });

export function ClassroomAI({
  classroomId,
  provider,
  session,
  busy,
  api,
  run,
  refresh,
  notify,
}: {
  classroomId: string;
  provider?: ClassroomProvider | null;
  session: ClassroomSession;
  busy: boolean;
  api: Api;
  run: Run;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const teacher = session.user.role === "teacher";
  const [protocol, setProtocol] = useState(
      provider?.api || "openai-completions",
    ),
    [enabled, setEnabled] = useState(provider?.enabled || false),
    [vision, setVision] = useState(provider?.vision || false);
  const [state, setState] = useState<any>(null),
    [settings, setSettings] = useState(false),
    [personal, setPersonal] = useState("");
  const proxy =
    serverAddress(session.server) + `/api/classrooms/${classroomId}/ai/v1`;
  const current = async () => {
    const status = await command<any>({ op: "status", summary: true });
    if (!status.folder) throw new Error("请先打开工作文件夹，再选择 AI 服务");
    const next = await agent<any>("history");
    if (next.busy) throw new Error("请先等待当前 AI 回合结束");
    if (next.workspaceKey !== status.folder.id || !next.conversationId)
      throw new Error("请先打开右侧对话栏，等待对话绑定当前文件夹");
    setState(next);
    return next;
  };
  const bind = async (
    service: ProviderConfiguration,
    conversationId: string,
  ) => {
    const result = await agent<any>("bindProvider", {
      id: service.id,
      baseUrl: service.baseUrl,
      api: service.api,
      conversationId,
    });
    setState(result);
  };
  const useTeacher = () =>
    void run(async () => {
      const before = await current();
      const access = await api<{ config: ClassroomProvider; apiKey: string }>(
        `/classrooms/${classroomId}/ai/access`,
        "POST",
        {},
      );
      const old = before.services.find(
        (s: ProviderConfiguration) =>
          s.baseUrl === proxy && s.api === access.config.api,
      );
      const next = await agent<any>("configure", {
        ...access.config,
        id: old?.id,
        name: `课堂 · ${access.config.name}`.slice(0, 40),
        baseUrl: proxy,
        apiKey: access.apiKey,
      });
      const service = next.services.find(
        (s: ProviderConfiguration) =>
          s.baseUrl === proxy && s.api === access.config.api,
      );
      if (!service) throw new Error("课堂 AI 配置未保存，请重试");
      await bind(service, before.conversationId);
      notify("当前对话已使用教师提供的 AI 服务，个人配置仍保留。");
    });
  return (
    <section className="classroom-analysis">
      <h4>{teacher ? "分发课堂 AI 配置" : "AI 服务来源"}</h4>
      {teacher ? (
        <form
          className="classroom-provider-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const body = Object.fromEntries(new FormData(form));
            void run(async () => {
              await api(`/classrooms/${classroomId}/ai`, "POST", {
                ...body,
                api: protocol,
                enabled,
                vision,
                contextWindow: Number(body.contextWindow),
                effort: body.effort || "none",
              });
              (form.elements.namedItem("apiKey") as HTMLInputElement).value =
                "";
              await refresh();
              notify("课堂 AI 配置已保存，学生可选择启用。");
            });
          }}
        >
          <label>
            服务名称
            <input
              name="name"
              defaultValue={provider?.name || "教师提供的 AI"}
              maxLength={40}
              required
            />
          </label>
          <label>
            接口地址
            <input
              name="baseUrl"
              defaultValue={provider?.baseUrl || ""}
              type="url"
              placeholder="https://provider.example/v1"
              required
            />
          </label>
          <label>
            协议
            <Select
              label="课堂 AI 协议"
              value={protocol}
              onChange={setProtocol}
              options={[
                { value: "openai-completions", label: "Chat Completions" },
                { value: "openai-responses", label: "Responses" },
                { value: "anthropic-messages", label: "Anthropic Messages" },
              ]}
            />
          </label>
          <label>
            API Key
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              maxLength={512}
              placeholder={provider ? "留空保留原密钥" : "填写教师的 API Key"}
            />
          </label>
          <label>
            模型
            <input
              name="model"
              defaultValue={provider?.model || ""}
              maxLength={128}
              required
            />
          </label>
          <label>
            上下文窗口
            <input
              name="contextWindow"
              type="number"
              min={32000}
              max={2000000}
              defaultValue={provider?.contextWindow || 256000}
              required
            />
          </label>
          <label>
            思考深度
            <input
              name="effort"
              defaultValue={provider?.effort || "none"}
              placeholder="none / low / medium / high / xhigh / max"
            />
          </label>
          <label className="classroom-check">
            <Checkbox checked={vision} onCheckedChange={setVision} />
            模型支持图片
          </label>
          <label className="classroom-check">
            <Checkbox checked={enabled} onCheckedChange={setEnabled} />
            允许本课堂学生使用
          </label>
          <p className="muted">
            真实密钥加密保存在服务器。学生通过独立凭据使用服务，费用计入教师配置的账号。关闭课堂或取消开放可停止后续请求。
          </p>
          <div className="classroom-actions">
            <button className="primary" disabled={busy}>
              保存课堂 AI 配置
            </button>
            <button
              type="button"
              disabled={busy || !provider}
              onClick={() =>
                void run(async () => {
                  await api(`/classrooms/${classroomId}/ai/revoke`, "POST", {});
                  notify("已撤销学生访问凭据。学生需重新启用教师配置。");
                })
              }
            >
              撤销全部学生凭据
            </button>
          </div>
        </form>
      ) : (
        <>
          <p>
            {provider?.enabled
              ? `${provider.name} · ${provider.model} · ${provider.api}`
              : "教师尚未开放课堂 AI 配置"}
          </p>
          <button
            className="primary"
            disabled={busy || !provider?.enabled}
            onClick={useTeacher}
          >
            使用教师提供的 AI
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await current();
                setSettings(true);
              })
            }
          >
            管理自己的 AI 配置
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await current();
              })
            }
          >
            刷新可选服务
          </button>
          {state && (
            <>
              <p>当前对话使用：{state.customProvider?.name || "尚未选择"}</p>
              <Select
                label="个人 AI 服务"
                value={personal}
                onChange={setPersonal}
                placeholder="选择自己的模型服务"
                options={(state.services || [])
                  .filter(
                    (s: ProviderConfiguration) => !s.baseUrl.includes("/ai/v1"),
                  )
                  .map((s: ProviderConfiguration) => ({
                    value: s.id!,
                    label: s.name,
                  }))}
              />
              <button
                disabled={busy || !personal}
                onClick={() =>
                  void run(async () => {
                    const latest = await current();
                    const selected = latest.services.find(
                      (s: ProviderConfiguration) => s.id === personal,
                    );
                    if (!selected) throw new Error("个人服务已变化，请刷新");
                    await bind(selected, latest.conversationId);
                    notify("当前对话已切换到个人 AI 配置。");
                  })
                }
              >
                使用自己的 AI
              </button>
            </>
          )}
          <p className="muted">
            选择只影响当前对话。个人密钥保存在本机，不上传教师端。教师修改模型或协议后，请重新启用教师配置。
          </p>
          {settings && state && (
            <ProviderSettings
              services={state.services || []}
              provider={state.customProvider}
              defaultServiceId={state.defaultServiceId}
              conversationId={state.conversationId}
              hasHistory={true}
              busy={busy}
              request={agent}
              onSaved={async () => {
                await current();
              }}
              onClose={() => setSettings(false)}
            />
          )}
        </>
      )}
    </section>
  );
}
