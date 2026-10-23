import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, RefreshCw, X } from "lucide-react";
import "./ai-settings.css";
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
const empty = (): ProviderConfiguration => ({
  name: "",
  baseUrl: "",
  apiKey: "",
  api: "openai-completions",
  model: "",
  effort: "none",
  contextWindow: 256000,
  vision: false,
});
function ProviderForm({
  provider,
  busy,
  request,
  onSaved,
  onClose,
  onWorking,
}: {
  provider: Partial<ProviderConfiguration> | null;
  busy: boolean;
  request: <T>(method: string, args?: unknown) => Promise<T>;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
  onWorking: (working: boolean) => void;
}) {
  const [form, setForm] = useState(() => ({
    ...empty(),
    ...provider,
    apiKey: "",
  }));
  const [working, setWorking] = useState<"discover" | "probe" | "save" | null>(
    null,
  );
  const presets = {
    custom: { name: "自定义接口", baseUrl: "", api: "openai-completions" },
    openai: {
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
    },
    deepseek: {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      api: "openai-completions",
    },
    anthropic: {
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
    },
    openrouter: {
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      api: "openai-completions",
    },
  };
  const [preset, setPreset] = useState(
    provider
      ? Object.entries(presets).find(
          ([, value]) => value.baseUrl === provider.baseUrl,
        )?.[0] || "custom"
      : "",
  );
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    onWorking(Boolean(working));
    return () => onWorking(false);
  }, [working, onWorking]);
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
        服务
        <select
          aria-label="服务类型"
          value={preset}
          disabled={locked}
          onChange={(event) => {
            const key = event.target.value as keyof typeof presets;
            setPreset(key);
            const selected = presets[key];
            update({
              ...(key === "custom" ? {} : selected),
              api: selected.api,
            });
          }}
        >
          <option value="" disabled>
            选择服务
          </option>
          {Object.entries(presets).map(([key, value]) => (
            <option key={key} value={key}>
              {value.name}
            </option>
          ))}
        </select>
      </label>
      <div hidden={!preset}>
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
            disabled={locked}
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
            placeholder={
              form.apiKeyHint &&
              form.baseUrl.replace(/\/+$/, "") ===
                provider?.baseUrl?.replace(/\/+$/, "")
                ? "留空保留现有密钥"
                : ""
            }
          />
        </label>
        <label>
          模型
          <ProviderModelInput
            value={form.model}
            disabled={locked}
            models={models}
            onChange={(model) => update({ model })}
          />
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
            名称
            <input
              disabled={locked}
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="可选，用于区分服务"
            />
          </label>
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
              onChange={(e) =>
                update({ contextWindow: Number(e.target.value) })
              }
            />
          </label>
          <label className="provider-check">
            <input
              type="checkbox"
              disabled={locked}
              checked={form.vision}
              onChange={(e) => update({ vision: e.target.checked })}
            />
            图片输入
          </label>
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
      </div>
      <button type="submit" disabled={locked || !preset}>
        <Check size={14} />
        {working === "save" ? "正在保存…" : "保存"}
      </button>
      <button type="button" disabled={working === "save"} onClick={onClose}>
        取消
      </button>
    </form>
  );
}

interface SettingsProps {
  services: ProviderConfiguration[];
  provider: Partial<ProviderConfiguration> | null;
  defaultServiceId?: string | null;
  conversationId?: string | null;
  hasHistory?: boolean;
  configurationError?: string;
  busy: boolean;
  request: <T>(method: string, args?: unknown) => Promise<T>;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}

/** The model services: which one this conversation and new conversations
 * use, and adding, editing or removing one. */
export function ProviderSettings(props: SettingsProps) {
  const { services, provider, request, onSaved, onClose } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [page, setPage] = useState<"services" | "edit" | "confirm">("services");
  const [editing, setEditing] = useState<Partial<ProviderConfiguration> | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState<{
    kind: "bind" | "remove";
    service: Partial<ProviderConfiguration>;
    conversationId?: string | null;
  } | null>(null);
  const [working, setWorking] = useState(false);
  const [formWorking, setFormWorking] = useState(false);
  const [error, setError] = useState("");
  const locked = props.busy || working || formWorking;
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    node?.showModal();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [page]);
  const navigate = (next: typeof page) => {
    setError("");
    setPage(next);
  };
  const action = async (work: () => Promise<unknown>, next?: typeof page) => {
    if (locked) return;
    setWorking(true);
    setError("");
    try {
      await work();
      await onSaved();
      if (next) setPage(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  const bind = (
    service: Partial<ProviderConfiguration>,
    conversationId = props.conversationId,
  ) =>
    request("bindProvider", {
      id: service.id,
      baseUrl: service.baseUrl,
      api: service.api,
      conversationId,
    });
  const choose = (service: ProviderConfiguration) => {
    if (props.hasHistory) {
      setConfirmation({
        kind: "bind",
        service,
        conversationId: props.conversationId,
      });
      navigate("confirm");
    } else void action(() => bind(service));
  };
  const edit = (service: Partial<ProviderConfiguration> | null) => {
    setEditing(service);
    navigate("edit");
  };
  const title =
    page === "edit"
      ? editing
        ? "编辑模型服务"
        : "添加模型服务"
      : page === "confirm"
        ? confirmation?.kind === "remove"
          ? "移除模型服务"
          : "更换此对话的模型服务"
        : "模型服务";
  return (
    <dialog
      ref={dialog}
      className="ai-settings-dialog"
      aria-labelledby="ai-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!working && !formWorking) onClose();
      }}
    >
      <header>
        <h2 id="ai-settings-title">AI 设置</h2>
        <button
          aria-label="关闭 AI 设置"
          disabled={working || formWorking}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="ai-settings-content">
        <div className="ai-settings-heading">
          {page !== "services" && (
            <button
              aria-label="返回模型服务"
              disabled={working || formWorking}
              onClick={() => navigate("services")}
            >
              <ArrowLeft size={17} />
            </button>
          )}
          <h3 ref={heading} tabIndex={-1}>
            {title}
          </h3>
          {page === "services" && (
            <button disabled={locked} onClick={() => edit(null)}>
              添加服务
            </button>
          )}
        </div>
        {page === "services" && (
          <>
            {props.configurationError && (
              <p className="dialog-error" role="alert">
                {props.configurationError}
              </p>
            )}
            {services.map((service) => (
              <div
                className="ai-service-row"
                key={service.id || service.baseUrl}
              >
                <div>
                  <strong>
                    {service.name || service.baseUrl}
                    {props.conversationId && service.id === provider?.id && (
                      <span className="ai-settings-badge">此对话</span>
                    )}
                  </strong>
                  <p>{service.baseUrl}</p>
                  <p>{service.model}</p>
                </div>
                <div className="ai-service-actions">
                  <button
                    disabled={locked}
                    onClick={() => edit(service)}
                    aria-label={`编辑 ${service.name || service.baseUrl}`}
                  >
                    编辑
                  </button>
                  {(service.id !== provider?.id ||
                    props.configurationError) && (
                    <button
                      disabled={locked || !props.conversationId}
                      onClick={() => choose(service)}
                    >
                      用于此对话
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!services.length && (
              <p>添加一个模型服务（API 地址、密钥和模型名）后即可对话。</p>
            )}
            {services.length > 0 && (
              <label className="ai-settings-field">
                新对话默认服务
                <select
                  aria-label="新对话默认服务"
                  disabled={locked}
                  value={props.defaultServiceId || ""}
                  onChange={(event) =>
                    void action(() =>
                      request("defaultProvider", { id: event.target.value }),
                    )
                  }
                >
                  {!props.defaultServiceId && (
                    <option value="" disabled>
                      选择服务
                    </option>
                  )}
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name || service.baseUrl}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {page === "edit" && (
          <ProviderForm
            key={editing?.id || editing?.baseUrl || "new"}
            provider={editing}
            busy={props.busy}
            request={request}
            onSaved={onSaved}
            onWorking={setFormWorking}
            onClose={() => navigate("services")}
          />
        )}
        {page === "edit" && editing && (
          <button
            className="ai-remove-service"
            disabled={locked}
            onClick={() => {
              setConfirmation({ kind: "remove", service: editing });
              navigate("confirm");
            }}
          >
            移除服务…
          </button>
        )}
        {page === "confirm" && confirmation && (
          <>
            {confirmation.kind === "bind" && (
              <div className="ai-service-destination">
                <span>当前</span>
                <strong>{provider?.name || provider?.model || "未绑定"}</strong>
                <small>{provider?.baseUrl}</small>
              </div>
            )}
            <div className="ai-service-destination">
              <span>{confirmation.kind === "bind" ? "更换为" : "移除"}</span>
              <strong>
                {confirmation.service.name || confirmation.service.model}
              </strong>
              <small>{confirmation.service.baseUrl}</small>
            </div>
            <p>
              {confirmation.kind === "bind"
                ? "已有历史将随下一次提问发送给这个服务。"
                : "使用它的对话仍会保留，继续提问前需要重新选择服务。"}
            </p>
            <div className="ai-settings-actions">
              <button
                disabled={working || formWorking}
                onClick={() => navigate("services")}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={locked}
                onClick={() =>
                  void action(
                    () =>
                      confirmation.kind === "bind"
                        ? bind(
                            confirmation.service,
                            confirmation.conversationId,
                          )
                        : request("removeProvider", {
                            id: confirmation.service.id,
                          }),
                    "services",
                  )
                }
              >
                {confirmation.kind === "bind" ? "更换服务" : "移除服务"}
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}

function ProviderModelInput({
  value,
  disabled,
  models,
  onChange,
}: {
  value: string;
  disabled: boolean;
  models: string[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const shown = models.filter((model) =>
    model.toLowerCase().includes(value.toLowerCase()),
  );
  return (
    <span
      className="ai-provider-model"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <span className="ai-provider-model-input">
        <input
          ref={input}
          required
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="ai-provider-model-options"
          aria-activedescendant={
            open && active >= 0 ? `ai-provider-model-${active}` : undefined
          }
          disabled={disabled}
          value={value}
          placeholder="选择或输入模型名称"
          autoComplete="off"
          spellCheck={false}
          onFocus={() => setOpen(models.length > 0)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
              setActive((previous) =>
                shown.length
                  ? (previous +
                      (event.key === "ArrowDown" ? 1 : shown.length - 1)) %
                    shown.length
                  : -1,
              );
            }
            if (event.key === "Enter" && open && active >= 0 && shown[active]) {
              event.preventDefault();
              onChange(shown[active]);
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          aria-label="展开接口模型"
          disabled={disabled || !models.length}
          onClick={() => {
            setOpen(!open);
            input.current?.focus();
          }}
        >
          <ChevronDown size={14} />
        </button>
      </span>
      {open && (
        <span
          className="ai-provider-model-options"
          id="ai-provider-model-options"
          role="listbox"
          aria-label="接口提供的模型"
        >
          {shown.map((model, index) => (
            <button
              type="button"
              key={model}
              id={`ai-provider-model-${index}`}
              role="option"
              aria-selected={index === active || model === value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(model);
                setOpen(false);
                input.current?.focus();
              }}
            >
              {model}
            </button>
          ))}
          {!shown.length && <span>没有匹配的模型，可直接输入名称。</span>}
        </span>
      )}
    </span>
  );
}
