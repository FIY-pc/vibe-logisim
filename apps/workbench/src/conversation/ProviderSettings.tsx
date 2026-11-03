import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  DataList,
  Dialog,
  Flex,
  Heading,
  IconButton,
  Popover,
  Select,
  Separator,
  Text,
  TextField,
} from "@radix-ui/themes";
import { Command } from "cmdk";
import { CommandSearch, preventComposingDismiss } from "../shared/command";
import "../shared/command.css";
import "./ai-settings.css";
import { ChatGPTLogin } from "./ChatGPTLogin";
import { publicText } from "../../../../packages/agent-runtime/src/models/public-fields.mts";
export interface ProviderConfiguration {
  id?: string;
  auth?: "chatgpt";
  account?: { email: string; connected: boolean; planEnabled: boolean };
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyHint?: string;
  api: string;
  model: string;
  effort: string;
  contextWindow: number;
  maxOutput?: number;
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
  container,
  busy,
  request,
  onSaved,
  onClose,
  onWorking,
}: {
  provider: Partial<ProviderConfiguration> | null;
  container?: HTMLElement;
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
    <Flex asChild direction="column" gap="4">
      <form
        className="ai-provider-form"
        aria-busy={Boolean(working)}
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
        <Flex direction="column" gap="2">
          <Text size="3" weight="medium">
            服务
          </Text>
          <Select.Root
            size="3"
            value={preset}
            disabled={locked}
            onValueChange={(value) => {
              const key = value as keyof typeof presets;
              setPreset(key);
              const selected = presets[key];
              update({
                ...(key === "custom" ? {} : selected),
                api: selected.api,
              });
            }}
          >
            <Select.Trigger aria-label="服务类型" placeholder="选择服务" />
            <Select.Content container={container}>
              {Object.entries(presets).map(([key, value]) => (
                <Select.Item key={key} value={key}>
                  {value.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Flex>
        {preset && (
          <>
            <Text as="label" size="3" className="ai-settings-field">
              接口地址
              <TextField.Root
                size="3"
                required
                disabled={locked}
                value={form.baseUrl}
                onChange={(e) => update({ baseUrl: e.target.value })}
                placeholder="https://…/v1"
              />
            </Text>
            <Flex direction="column" gap="2">
              <Text size="3" weight="medium">
                协议
              </Text>
              <Select.Root
                size="3"
                disabled={locked}
                value={form.api}
                onValueChange={(api) => update({ api })}
              >
                <Select.Trigger aria-label="协议" />
                <Select.Content container={container}>
                  <Select.Item value="openai-completions">
                    Chat Completions
                  </Select.Item>
                  <Select.Item value="openai-responses">Responses</Select.Item>
                  <Select.Item value="anthropic-messages">
                    Anthropic Messages
                  </Select.Item>
                </Select.Content>
              </Select.Root>
            </Flex>
            <Text as="label" size="3" className="ai-settings-field">
              API 密钥
              <TextField.Root
                size="3"
                type="password"
                disabled={locked}
                value={form.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
                autoComplete="off"
                placeholder={
                  form.apiKeyHint &&
                  form.api === provider?.api &&
                  form.baseUrl.replace(/\/+$/, "") ===
                    provider?.baseUrl?.replace(/\/+$/, "")
                    ? "留空保留现有密钥"
                    : ""
                }
              />
            </Text>
            <Box>
              <Text as="div" size="3" weight="medium" mb="2">
                模型
              </Text>
              <ProviderModelInput
                value={form.model}
                disabled={locked}
                models={models}
                onChange={(model) => update({ model })}
              />
            </Box>
            <Flex gap="3" wrap="wrap">
              <Button
                type="button"
                variant="soft"
                size="3"
                loading={working === "discover"}
                disabled={locked || !form.baseUrl.trim()}
                onClick={() => void probe("discover")}
              >
                <RefreshCw size={16} />
                {working === "discover" ? "正在读取…" : "读取模型列表"}
              </Button>
              <Button
                type="button"
                variant="soft"
                size="3"
                loading={working === "probe"}
                disabled={locked || !form.baseUrl.trim() || !form.model.trim()}
                onClick={() => void probe("probe")}
              >
                {working === "probe" ? "正在检测…" : "检测连接"}
              </Button>
            </Flex>
            {result && (
              <Callout.Root
                color={result.error ? "red" : "green"}
                role={result.error ? "alert" : "status"}
                size="2"
              >
                <Callout.Text>{result.message}</Callout.Text>
              </Callout.Root>
            )}
            <Card asChild>
              <details>
                <Text asChild size="3" weight="medium">
                  <summary>高级设置</summary>
                </Text>
                <Flex direction="column" gap="4" mt="4">
                  <Text as="label" size="3" className="ai-settings-field">
                    名称
                    <TextField.Root
                      size="3"
                      disabled={locked}
                      value={form.name}
                      onChange={(e) => update({ name: e.target.value })}
                      placeholder="可选，用于区分服务"
                    />
                  </Text>
                  <Text as="label" size="3" className="ai-settings-field">
                    上下文窗口
                    <TextField.Root
                      size="3"
                      aria-label="上下文窗口"
                      type="number"
                      min={1}
                      step={1}
                      required
                      disabled={locked}
                      value={form.contextWindow}
                      onChange={(e) =>
                        update({ contextWindow: Number(e.target.value) })
                      }
                    />
                  </Text>
                  <Text as="label" size="3" className="ai-settings-field">
                    最大输出 token
                    <TextField.Root
                      size="3"
                      aria-label="最大输出 token"
                      type="number"
                      min={1}
                      step={1}
                      disabled={locked}
                      value={form.maxOutput ?? ""}
                      placeholder="自动"
                      onChange={(e) =>
                        update({
                          maxOutput:
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                        })
                      }
                    />
                  </Text>
                  <Text as="label" size="3">
                    <Flex as="span" gap="2" align="center">
                      <Checkbox
                        size="3"
                        disabled={locked}
                        checked={form.vision}
                        onCheckedChange={(vision) =>
                          update({ vision: vision === true })
                        }
                      />
                      图片输入
                    </Flex>
                  </Text>
                  <Flex direction="column" gap="2">
                    <Text size="3" weight="medium">
                      默认思考深度
                    </Text>
                    <Select.Root
                      size="3"
                      disabled={locked}
                      value={form.effort}
                      onValueChange={(effort) => update({ effort })}
                    >
                      <Select.Trigger aria-label="服务默认思考深度" />
                      <Select.Content container={container}>
                        {[
                          ["none", "默认"],
                          ["low", "轻度"],
                          ["medium", "中"],
                          ["high", "高"],
                          ["xhigh", "极高"],
                          ["max", "最高"],
                        ].map(([value, label]) => (
                          <Select.Item key={value} value={value}>
                            {label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Flex>
                </Flex>
              </details>
            </Card>
          </>
        )}
        <Flex gap="3" justify="end" wrap="wrap">
          <Button
            type="button"
            size="3"
            variant="soft"
            color="gray"
            disabled={working === "save"}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="submit"
            size="3"
            loading={working === "save"}
            disabled={locked || !preset}
          >
            <Check size={16} />
            {working === "save" ? "正在保存…" : "保存"}
          </Button>
        </Flex>
      </form>
    </Flex>
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
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const origin = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<HTMLElement | undefined | null>(
    null,
  );
  useLayoutEffect(() => {
    setContainer(
      origin.current?.closest<HTMLDialogElement>("dialog[open]") ?? undefined,
    );
  }, []);
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
  const back = () => navigate("services");
  return (
    <>
      <span ref={origin} hidden />
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open && !working && !formWorking) onClose();
        }}
      >
        {container !== null && (
          <Dialog.Content
            container={container}
            className="ai-settings-panel"
            aria-modal="true"
            maxWidth="760px"
            align="start"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              heading.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (opener?.isConnected) opener.focus();
            }}
            onEscapeKeyDown={(event) => {
              if (working || formWorking) event.preventDefault();
              else if (page !== "services") {
                event.preventDefault();
                back();
              }
            }}
            onInteractOutside={(event) => event.preventDefault()}
          >
            <Flex justify="between" align="center" gap="3" mb="4">
              <Dialog.Title as="h2" mb="0">
                AI 设置
              </Dialog.Title>
              <Dialog.Close>
                <IconButton
                  aria-label="关闭 AI 设置"
                  variant="ghost"
                  color="gray"
                  disabled={working || formWorking}
                >
                  <X size={20} />
                </IconButton>
              </Dialog.Close>
            </Flex>
            <Flex className="ai-settings-content" direction="column" gap="4">
              <Flex align="center" gap="3">
                {page !== "services" && (
                  <IconButton
                    aria-label="返回模型服务"
                    variant="soft"
                    color="gray"
                    disabled={working || formWorking}
                    onClick={back}
                  >
                    <ArrowLeft size={18} />
                  </IconButton>
                )}
                <Heading as="h3" size="4" ref={heading} tabIndex={-1}>
                  {title}
                </Heading>
              </Flex>
              {page === "services" && (
                <>
                  <Flex
                    asChild
                    direction="column"
                    gap="3"
                    className="ai-service-options"
                  >
                    <ul aria-label="模型服务">
                      <li>
                        <ChatGPTLogin
                          services={services}
                          busy={locked}
                          request={request}
                          onSaved={onSaved}
                          providerId={provider?.id}
                          canBind={Boolean(props.conversationId)}
                          onChoose={choose}
                        />
                      </li>
                      {services
                        .filter((service) => service.auth !== "chatgpt")
                        .map((service) => (
                          <li key={service.id || service.baseUrl}>
                            <Card>
                              <Flex
                                gap="4"
                                justify="between"
                                align="start"
                                wrap="wrap"
                              >
                                <Flex
                                  direction="column"
                                  gap="2"
                                  className="ai-service-details"
                                  flexGrow="1"
                                >
                                  <Flex gap="2" align="center" wrap="wrap">
                                    <Text size="3" weight="medium">
                                      {publicText(
                                        service.name || service.baseUrl,
                                      )}
                                    </Text>
                                    {props.conversationId &&
                                      service.id === provider?.id && (
                                        <Badge size="2">此对话</Badge>
                                      )}
                                  </Flex>
                                  {!service.baseUrl.includes(
                                    "/api/classrooms/",
                                  ) && (
                                    <Text size="3" color="gray">
                                      {publicText(service.baseUrl)}
                                    </Text>
                                  )}
                                  <Text size="3" color="gray">
                                    {publicText(service.model)}
                                  </Text>
                                  {service.baseUrl.includes(
                                    "/api/classrooms/",
                                  ) && (
                                    <Text size="3" color="gray">
                                      课堂提供 · 配置由教师管理
                                    </Text>
                                  )}
                                </Flex>
                                <Flex gap="2" wrap="wrap">
                                  {service.baseUrl.includes(
                                    "/api/classrooms/",
                                  ) ? (
                                    <Button
                                      variant="soft"
                                      color="red"
                                      disabled={locked}
                                      onClick={() => {
                                        setConfirmation({
                                          kind: "remove",
                                          service,
                                        });
                                        navigate("confirm");
                                      }}
                                    >
                                      移除
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="soft"
                                      color="gray"
                                      disabled={locked}
                                      onClick={() => edit(service)}
                                      aria-label={`编辑 ${service.name || service.baseUrl}`}
                                    >
                                      编辑
                                    </Button>
                                  )}
                                  {(service.id !== provider?.id ||
                                    props.configurationError) && (
                                    <Button
                                      variant="soft"
                                      disabled={locked || !props.conversationId}
                                      onClick={() => choose(service)}
                                    >
                                      用于此对话
                                    </Button>
                                  )}
                                </Flex>
                              </Flex>
                            </Card>
                          </li>
                        ))}
                      <li>
                        <Button
                          className="ai-service-option"
                          variant="soft"
                          color="gray"
                          size="3"
                          disabled={locked}
                          onClick={() => edit(null)}
                        >
                          添加自定义 API
                          <ChevronRight size={18} aria-hidden="true" />
                        </Button>
                      </li>
                    </ul>
                  </Flex>
                  {props.configurationError && (
                    <Callout.Root color="red" role="alert">
                      <Callout.Text>{props.configurationError}</Callout.Text>
                    </Callout.Root>
                  )}
                  {services.length > 0 && (
                    <>
                      <Separator size="4" />
                      <Flex direction="column" gap="2">
                        <Text size="3" weight="medium">
                          新对话默认服务
                        </Text>
                        <Select.Root
                          size="3"
                          disabled={locked}
                          value={props.defaultServiceId || ""}
                          onValueChange={(id) =>
                            void action(() =>
                              request("defaultProvider", { id }),
                            )
                          }
                        >
                          <Select.Trigger
                            aria-label="新对话默认服务"
                            placeholder="选择服务"
                          />
                          <Select.Content container={container}>
                            {[...services]
                              .sort(
                                (a, b) =>
                                  Number(b.auth === "chatgpt") -
                                  Number(a.auth === "chatgpt"),
                              )
                              .filter((service) => service.id)
                              .map((service) => (
                                <Select.Item
                                  key={service.id}
                                  value={service.id!}
                                >
                                  {publicText(service.name || service.baseUrl)}
                                </Select.Item>
                              ))}
                          </Select.Content>
                        </Select.Root>
                      </Flex>
                    </>
                  )}
                </>
              )}
              {page === "edit" && (
                <ProviderForm
                  container={container}
                  key={editing?.id || editing?.baseUrl || "new"}
                  provider={editing}
                  busy={props.busy}
                  request={request}
                  onSaved={onSaved}
                  onWorking={setFormWorking}
                  onClose={back}
                />
              )}
              {page === "edit" && editing && (
                <Button
                  variant="soft"
                  color="red"
                  disabled={locked}
                  onClick={() => {
                    setConfirmation({ kind: "remove", service: editing });
                    navigate("confirm");
                  }}
                  style={{ alignSelf: "start" }}
                >
                  移除服务…
                </Button>
              )}
              {page === "confirm" && confirmation && (
                <>
                  <DataList.Root size="3" className="ai-service-details">
                    {confirmation.kind === "bind" && (
                      <DataList.Item>
                        <DataList.Label>当前</DataList.Label>
                        <DataList.Value>
                          <Flex direction="column" gap="1">
                            <Text weight="medium">
                              {publicText(
                                provider?.name || provider?.model || "未绑定",
                              )}
                            </Text>
                            <Text color="gray">
                              {publicText(provider?.baseUrl || "")}
                            </Text>
                          </Flex>
                        </DataList.Value>
                      </DataList.Item>
                    )}
                    <DataList.Item>
                      <DataList.Label>
                        {confirmation.kind === "bind" ? "更换为" : "移除"}
                      </DataList.Label>
                      <DataList.Value>
                        <Flex direction="column" gap="1">
                          <Text weight="medium">
                            {publicText(
                              confirmation.service.name ||
                                confirmation.service.model ||
                                "",
                            )}
                          </Text>
                          <Text color="gray">
                            {publicText(confirmation.service.baseUrl || "")}
                          </Text>
                        </Flex>
                      </DataList.Value>
                    </DataList.Item>
                  </DataList.Root>
                  <Text as="p" size="3">
                    {confirmation.kind === "bind"
                      ? "已有历史将随下一次提问发送给这个服务。"
                      : "使用它的对话仍会保留，继续提问前需要重新选择服务。"}
                  </Text>
                  <Flex gap="3" justify="end" wrap="wrap">
                    <Button
                      size="3"
                      variant="soft"
                      color="gray"
                      disabled={working || formWorking}
                      onClick={back}
                    >
                      取消
                    </Button>
                    <Button
                      size="3"
                      color={confirmation.kind === "remove" ? "red" : undefined}
                      loading={working}
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
                    </Button>
                  </Flex>
                </>
              )}
              {error && (
                <Callout.Root color="red" role="alert">
                  <Callout.Text>{error}</Callout.Text>
                </Callout.Root>
              )}
            </Flex>
          </Dialog.Content>
        )}
      </Dialog.Root>
    </>
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <TextField.Root
        size="3"
        required
        aria-label="模型"
        disabled={disabled}
        value={value}
        placeholder="选择或输入模型名称"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      >
        <TextField.Slot side="right">
          <Popover.Trigger>
            <IconButton
              ref={trigger}
              type="button"
              variant="ghost"
              aria-label="展开接口模型"
              disabled={disabled || !models.length}
            >
              <ChevronDown size={18} />
            </IconButton>
          </Popover.Trigger>
        </TextField.Slot>
      </TextField.Root>
      <Popover.Content
        container={
          trigger.current?.closest<HTMLDialogElement>("dialog[open]") ??
          undefined
        }
        className="ai-provider-model-popover"
        width="360px"
        aria-labelledby={titleId}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          search.current?.focus();
        }}
        onEscapeKeyDown={preventComposingDismiss}
      >
        <Flex direction="column" gap="3">
          <Heading as="h3" id={titleId} size="3">
            接口提供的模型
          </Heading>
          <Command
            label="接口提供的模型"
            loop
            filter={(model, query) =>
              model.toLowerCase().includes(query.toLowerCase()) ? 1 : 0
            }
          >
            <CommandSearch
              value={query}
              onValueChange={setQuery}
              inputRef={search}
              size="3"
              aria-label="搜索接口模型"
              placeholder="搜索模型"
            >
              <TextField.Slot>
                <Search size={16} />
              </TextField.Slot>
            </CommandSearch>
            <Command.List
              className="command-list ai-provider-model-options"
              label="接口提供的模型"
            >
              {models.map((model) => (
                <Command.Item
                  asChild
                  key={model}
                  value={model}
                  disabled={disabled}
                  onSelect={() => {
                    onChange(model);
                    setOpen(false);
                  }}
                >
                  <Button
                    className="ai-model-option"
                    variant={model === value ? "soft" : "ghost"}
                    color={model === value ? undefined : "gray"}
                    type="button"
                    aria-current={model === value ? "true" : undefined}
                    disabled={disabled}
                  >
                    {model}
                  </Button>
                </Command.Item>
              ))}
              <Command.Empty>
                <Text size="3" color="gray">
                  没有匹配的模型，可直接输入名称。
                </Text>
              </Command.Empty>
            </Command.List>
          </Command>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}
