import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
export interface ProviderConfiguration {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyHint?: string;
  api: string;
  model: string;
  effort: string;
  contextWindow: number;
  vision: boolean;
}
interface ProbeResult {
  ok: boolean;
  message?: string;
  hint?: string;
  elapsedMs?: number;
  models?: string[] | null;
}
const empty = (runtime: string): ProviderConfiguration => ({
  name: "",
  baseUrl: "",
  apiKey: "",
  api: runtime === "codex" ? "openai-responses" : "openai-completions",
  model: "",
  effort: "none",
  contextWindow: 256000,
  vision: false,
});
export function ProviderSettings({
  runtime,
  services,
  provider,
  busy,
  canImport,
  request,
  onRuntime,
  onLogin,
  onImport,
  onSaved,
  onClose,
}: {
  runtime: "builtin" | "codex";
  services: ProviderConfiguration[];
  provider: Partial<ProviderConfiguration> | null;
  busy: boolean;
  canImport: boolean;
  request: <T>(method: string, args?: unknown) => Promise<T>;
  onRuntime: (runtime: string) => Promise<void>;
  onLogin: () => void;
  onImport: () => void;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [form, setForm] = useState(() => ({
    ...empty(runtime),
    ...provider,
    apiKey: "",
  }));
  const [working, setWorking] = useState<
    "discover" | "probe" | "save" | "runtime" | null
  >(null);
  const [models, setModels] = useState<string[]>([]);
  const [result, setResult] = useState<{
    error: boolean;
    message: string;
  } | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const update = (values: Partial<ProviderConfiguration>) => {
    generation.current++;
    setForm((previous) => ({ ...previous, ...values }));
    setResult(null);
    if (
      values.baseUrl !== undefined ||
      values.api !== undefined ||
      values.apiKey !== undefined
    )
      setModels([]);
  };
  const probe = async (method: "discover" | "probe") => {
    const token = ++generation.current;
    setWorking(method);
    setResult(null);
    try {
      const response = await request<ProbeResult>(method, form);
      if (token !== generation.current) return;
      if (!response.ok)
        throw new Error(
          [response.message || "连接失败", response.hint]
            .filter(Boolean)
            .join("。"),
        );
      if (method === "discover") {
        setModels(response.models || []);
        setResult({
          error: false,
          message: response.models?.length
            ? `已读取 ${response.models.length} 个模型`
            : "接口没有提供模型列表，可以手动填写模型名。",
        });
      } else
        setResult({
          error: false,
          message: `基本响应正常${response.elapsedMs ? ` · ${response.elapsedMs} ms` : ""}`,
        });
    } catch (e) {
      if (token === generation.current)
        setResult({
          error: true,
          message: e instanceof Error ? e.message : String(e),
        });
    } finally {
      if (token === generation.current) setWorking(null);
    }
  };
  const locked = busy || Boolean(working);
  return (
    <form
      className="provider-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (locked) return;
        setWorking("save");
        setResult(null);
        void request("configure", form)
          .then(onSaved)
          .then(onClose)
          .catch((e) =>
            setResult({
              error: true,
              message: e instanceof Error ? e.message : String(e),
            }),
          )
          .finally(() => setWorking(null));
      }}
    >
      <label>
        运行时
        <select
          aria-label="运行时"
          value={runtime}
          disabled={locked}
          onChange={(e) => {
            setWorking("runtime");
            void onRuntime(e.target.value).finally(() => setWorking(null));
          }}
        >
          <option value="builtin">内置</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      {runtime === "codex" && (
        <button type="button" disabled={locked} onClick={onLogin}>
          使用 ChatGPT 登录
        </button>
      )}
      <button type="button" disabled={!canImport || locked} onClick={onImport}>
        导入旧版对话…
      </button>
      {runtime === "builtin" && services.length > 0 && (
        <label>
          服务
          <select
            aria-label="编辑模型服务"
            value={form.id || ""}
            disabled={locked}
            onChange={(e) => {
              generation.current++;
              const service = services.find((s) => s.id === e.target.value);
              setForm({ ...empty(runtime), ...service, apiKey: "" });
              setModels([]);
              setResult(null);
            }}
          >
            <option value="">添加服务…</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.baseUrl}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        名称
        <input
          disabled={locked}
          value={form.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="模型服务"
        />
      </label>
      <label>
        接口地址
        <input
          required
          disabled={locked}
          value={form.baseUrl}
          onChange={(e) => update({ baseUrl: e.target.value })}
          placeholder="https://…/v1"
        />
      </label>
      <label>
        协议
        <select
          disabled={locked || runtime === "codex"}
          value={form.api}
          onChange={(e) => update({ api: e.target.value })}
        >
          <option value="openai-completions">Chat Completions</option>
          <option value="openai-responses">Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
      </label>
      <label>
        API 密钥
        <input
          type="password"
          disabled={locked}
          value={form.apiKey}
          onChange={(e) => update({ apiKey: e.target.value })}
          autoComplete="off"
          placeholder={form.apiKeyHint ? "留空保留现有密钥" : ""}
        />
      </label>
      <label>
        模型
        <input
          required
          disabled={locked}
          list="provider-discovered-models"
          value={form.model}
          onChange={(e) => update({ model: e.target.value })}
        />
        <datalist id="provider-discovered-models">
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </label>
      <div className="provider-actions">
        <button
          type="button"
          disabled={locked || !form.baseUrl.trim()}
          onClick={() => void probe("discover")}
        >
          <RefreshCw size={13} />
          {working === "discover" ? "正在读取…" : "读取模型列表"}
        </button>
        <button
          type="button"
          disabled={locked || !form.baseUrl.trim() || !form.model.trim()}
          onClick={() => void probe("probe")}
        >
          {working === "probe" ? "正在检测…" : "检测连接"}
        </button>
      </div>
      {result && (
        <p
          className={result.error ? "dialog-error" : "muted"}
          role={result.error ? "alert" : "status"}
        >
          {result.message}
        </p>
      )}
      <details className="provider-advanced">
        <summary>高级设置</summary>
        <label>
          上下文窗口
          <input
            aria-label="上下文窗口"
            type="number"
            min={32000}
            max={2000000}
            step={1}
            required
            disabled={locked}
            value={form.contextWindow}
            onChange={(e) => update({ contextWindow: Number(e.target.value) })}
          />
        </label>
        {runtime === "builtin" && (
          <label className="provider-check">
            <input
              type="checkbox"
              disabled={locked}
              checked={form.vision}
              onChange={(e) => update({ vision: e.target.checked })}
            />
            图片输入
          </label>
        )}
        <label>
          默认思考深度
          <select
            aria-label="服务默认思考深度"
            disabled={locked}
            value={form.effort}
            onChange={(e) => update({ effort: e.target.value })}
          >
            {[
              ["none", "默认"],
              ["low", "轻度"],
              ["medium", "中"],
              ["high", "高"],
              ["xhigh", "极高"],
              ["max", "最高"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </details>
      <button type="submit" disabled={locked}>
        <Check size={14} />
        {working === "save" ? "正在保存…" : "保存"}
      </button>
      <button type="button" disabled={working === "save"} onClick={onClose}>
        取消
      </button>
    </form>
  );
}
