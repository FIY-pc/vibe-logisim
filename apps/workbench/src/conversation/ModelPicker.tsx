import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw, Search, X } from "lucide-react";
import {
  Button,
  Callout,
  Flex,
  Heading,
  IconButton,
  Popover,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import "./ai-settings.css";

export interface ModelOption {
  model: string;
  name?: string;
  label?: string;
  description?: string;
  defaultEffort?: string | null;
  efforts?: { value: string; description?: string }[];
  metadata?: {
    contextWindow?: number;
    vision?: boolean;
    source?: string;
    toolCall?: boolean;
    status?: string;
  };
}
export interface ModelListResult {
  models: ModelOption[];
  warning?: string | null;
}
const descriptions: Record<string, string> = {
  "Our most capable model for complex, demanding work.":
    "适合复杂、要求较高的任务。",
  "Reliable agentic workhorse for everyday tasks.": "适合日常构建与持续协作。",
  "Balanced agentic coding model for everyday work.":
    "兼顾日常任务的能力与效率。",
  "Fast and affordable agentic coding model.": "适合希望较快完成的日常任务。",
  "Proven previous-generation model for coding and general work.":
    "适用于构建与通用任务的上一代模型。",
};
export function ModelPicker({
  scope,
  model,
  name,
  disabled,
  busy,
  configurationError,
  load,
  select,
}: {
  scope: string;
  model: string | null;
  name?: string;
  disabled: boolean;
  busy: boolean;
  configurationError?: string;
  load: (refresh: boolean) => Promise<ModelListResult>;
  select: (model: ModelOption) => Promise<void>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<{ scope: string; models: string[] }>({
    scope,
    models: [],
  });
  return (
    <Popover.Root
      modal
      open={open}
      onOpenChange={(next) => {
        if (!saving) setOpen(next);
      }}
    >
      <Popover.Trigger>
        <Button
          ref={trigger}
          size="2"
          variant="soft"
          color="gray"
          className="ai-model-trigger"
          aria-label={`选择模型：${name || model || "选择模型"}`}
          disabled={disabled || saving}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span>{name || model || "选择模型"}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      {open && (
        <ModelDialog
          key={scope}
          container={
            trigger.current?.closest<HTMLDialogElement>("dialog[open]") ??
            undefined
          }
          saving={saving}
          setSaving={setSaving}
          model={model}
          recent={recent.scope === scope ? recent.models : []}
          busy={busy}
          configurationError={configurationError}
          load={load}
          select={async (choice) => {
            await select(choice);
            setRecent((previous) => ({
              scope,
              models: [
                choice.model,
                ...(previous.scope === scope ? previous.models : []).filter(
                  (id) => id !== choice.model,
                ),
              ].slice(0, 5),
            }));
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </Popover.Root>
  );
}
function ModelDialog({
  container,
  saving,
  setSaving,
  model,
  recent,
  busy,
  configurationError,
  load,
  select,
  onClose,
}: {
  container?: HTMLElement;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  model: string | null;
  recent: string[];
  busy: boolean;
  configurationError?: string;
  load: (refresh: boolean) => Promise<ModelListResult>;
  select: (model: ModelOption) => Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const search = useRef<HTMLInputElement>(null),
    list = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<ModelOption[]>([]),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0);
  const reload = async (refresh: boolean) => {
    const current = ++epoch.current;
    setLoading(true);
    setError("");
    try {
      const result = await load(refresh);
      if (current !== epoch.current) return;
      setModels(result.models);
      setError(
        result.warning ||
          (result.models.length ? "" : "当前连接没有返回模型。"),
      );
    } catch (e) {
      if (current === epoch.current)
        setError(`无法读取模型：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (current === epoch.current) setLoading(false);
    }
  };
  useEffect(() => {
    void reload(false);
    return () => {
      epoch.current++;
    };
  }, []);
  const chosen = model;
  const rank = (entry: ModelOption) =>
    entry.model === chosen
      ? -2
      : recent.includes(entry.model)
        ? recent.indexOf(entry.model)
        : 100;
  const available = models.length ? models : model ? [{ model }] : [];
  const entries = [...available]
    .sort((a, b) => rank(a) - rank(b))
    .filter((entry) =>
      `${entry.model} ${entry.name || entry.label || ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    );
  const choose = async (entry: ModelOption) => {
    if (saving || busy) return;
    setSaving(true);
    setError("");
    try {
      await select(entry);
      onClose();
    } catch (e) {
      setError(`未能更改：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Popover.Content
      container={container}
      className="ai-model-popover"
      side="top"
      width="400px"
      aria-labelledby={titleId}
      aria-busy={saving}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        search.current?.focus();
      }}
      onEscapeKeyDown={(event) => {
        if (saving) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (saving) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (
          !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
          (["Home", "End"].includes(event.key) &&
            event.target === search.current)
        )
          return;
        const options = Array.from(
          list.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) || [],
        );
        if (!options.length) return;
        event.preventDefault();
        const index = options.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : options.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : options.length - 1)) %
                  options.length;
        options[next].focus();
        options[next].scrollIntoView({ block: "nearest" });
      }}
    >
      <Flex direction="column" gap="3" className="ai-model-content">
        <Flex align="center" justify="between" gap="3">
          <Heading as="h2" id={titleId} size="4">
            选择模型
          </Heading>
          <Popover.Close>
            <IconButton
              aria-label="关闭模型设置"
              variant="ghost"
              color="gray"
              disabled={saving}
            >
              <X size={18} />
            </IconButton>
          </Popover.Close>
        </Flex>
        <TextField.Root
          size="3"
          ref={search}
          type="search"
          aria-label="搜索模型"
          placeholder="搜索模型"
          autoComplete="off"
          value={query}
          disabled={saving}
          onChange={(event) => setQuery(event.target.value)}
        >
          <TextField.Slot>
            <Search size={18} />
          </TextField.Slot>
        </TextField.Root>
        {loading && (
          <Text size="3" role="status" color="gray">
            正在更新…
          </Text>
        )}
        <Flex
          direction="column"
          gap="1"
          ref={list}
          className="ai-model-list"
          role="listbox"
          aria-label="当前服务的模型"
        >
          {entries.map((entry) => {
            const info = entry.metadata;
            const detail = [
              info?.contextWindow
                ? `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(info.contextWindow)} 上下文`
                : null,
              info?.vision ? "图片输入" : null,
            ]
              .filter(Boolean)
              .join(" · ");
            const description = info
              ? ""
              : entry.description
                ? descriptions[entry.description] || entry.description
                : entry.model !== entry.name && entry.name
                  ? entry.model
                  : "";
            return (
              <Tooltip
                container={container}
                key={entry.model}
                content={[
                  entry.model,
                  info?.source ? `资料来源：${info.source}` : null,
                  info?.toolCall === false ? "目录标记不支持工具调用" : null,
                  info?.status ? "目录标记已弃用" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <Button
                  size="3"
                  variant={entry.model === chosen ? "soft" : "ghost"}
                  color={entry.model === chosen ? undefined : "gray"}
                  className="ai-model-option"
                  role="option"
                  aria-selected={entry.model === chosen}
                  disabled={busy || saving}
                  onClick={() => void choose(entry)}
                >
                  <Flex as="span" direction="column" gap="1" minWidth="0">
                    <Text size="3" weight="medium">
                      {entry.name || entry.label || entry.model}
                    </Text>
                    {description && (
                      <Text size="3" color="gray">
                        {description}
                      </Text>
                    )}
                    {detail && (
                      <Text size="3" color="gray">
                        {detail}
                      </Text>
                    )}
                  </Flex>
                  {entry.model === chosen && <Check size={18} />}
                </Button>
              </Tooltip>
            );
          })}
          {!entries.length && !loading && (
            <Text size="3" color="gray">
              没有找到这个模型
            </Text>
          )}
        </Flex>
        {(configurationError ||
          (!loading &&
            models.length > 0 &&
            model &&
            !models.some((entry) => entry.model === model))) && (
          <Text as="p" size="3">
            {configurationError || "当前模型尚未出现在列表中。"}
          </Text>
        )}
        {busy && (
          <Text as="p" size="3">
            回答进行中，完成或停止后可以切换模型。
          </Text>
        )}
        {error && (
          <Callout.Root color="red" role="alert">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        <Flex justify="start">
          <Button
            variant="soft"
            color="gray"
            loading={loading}
            disabled={loading || saving || busy}
            onClick={() => void reload(true)}
          >
            <RefreshCw size={16} />
            刷新列表
          </Button>
        </Flex>
      </Flex>
    </Popover.Content>
  );
}
