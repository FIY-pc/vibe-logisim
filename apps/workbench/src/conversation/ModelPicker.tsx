import { Button, IconButton, TextField, Text, Heading } from "../design/ui";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw, Search, X } from "lucide-react";
import { Callout, Flex, Popover, Tooltip } from "@radix-ui/themes";
import { Command } from "cmdk";
import {
  CommandButton,
  CommandSearch,
  preventComposingDismiss,
} from "../shared/command";

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
interface ModelPickerProps {
  scope: string;
  model: string | null;
  name?: string;
  disabled: boolean;
  busy: boolean;
  configurationError?: string;
  allowCustom?: boolean;
  load: (refresh: boolean) => Promise<ModelListResult>;
  select: (model: ModelOption) => Promise<void>;
}

export function ModelPicker(props: ModelPickerProps) {
  // A service/conversation change also resets pending selection and recent models.
  return <ScopedModelPicker key={props.scope} {...props} />;
}

function ScopedModelPicker({
  model,
  name,
  disabled,
  busy,
  configurationError,
  allowCustom = false,
  load,
  select,
}: ModelPickerProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
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
          variant="ghost"
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
          container={
            trigger.current?.closest<HTMLDialogElement>("dialog[open]") ??
            undefined
          }
          saving={saving}
          setSaving={setSaving}
          model={model}
          recent={recent}
          busy={busy}
          configurationError={configurationError}
          allowCustom={allowCustom}
          load={load}
          select={async (choice) => {
            await select(choice);
            setRecent((previous) =>
              [
                choice.model,
                ...previous.filter((id) => id !== choice.model),
              ].slice(0, 5),
            );
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
  allowCustom,
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
  allowCustom: boolean;
  load: (refresh: boolean) => Promise<ModelListResult>;
  select: (model: ModelOption) => Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const search = useRef<HTMLInputElement>(null);
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
  const available =
    model && !models.some((entry) => entry.model === model)
      ? [{ model }, ...models]
      : models;
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
        preventComposingDismiss(event);
        if (saving) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (saving) event.preventDefault();
      }}
    >
      <Flex direction="column" gap="3" className="ai-model-content">
        <Flex align="center" justify="between" gap="3">
          <Heading as="h2" kind="section" id={titleId}>
            选择模型
          </Heading>
          <Popover.Close>
            <IconButton
              aria-label="关闭模型设置"
              variant="ghost"
              color="gray"
              disabled={saving}
            >
              <X size={16} />
            </IconButton>
          </Popover.Close>
        </Flex>
        <Command label="选择模型" loop shouldFilter={false}>
          <CommandSearch
            value={query}
            onValueChange={setQuery}
            inputRef={search}
            aria-label="搜索模型"
            placeholder="搜索或输入模型 ID"
            autoComplete="off"
            disabled={saving}
          >
            <TextField.Slot>
              <Search size={16} />
            </TextField.Slot>
          </CommandSearch>
          {loading && (
            <Text role="status" color="gray">
              正在更新…
            </Text>
          )}
          <Command.List
            className="command-list ai-model-list"
            label="当前服务的模型"
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
                  <Command.Item
                    asChild
                    value={entry.model}
                    disabled={busy || saving}
                    onSelect={() => void choose(entry)}
                  >
                    <CommandButton
                      variant={entry.model === chosen ? "soft" : "ghost"}
                      color={entry.model === chosen ? undefined : "gray"}
                      className="ai-model-option"
                      aria-current={entry.model === chosen ? "true" : undefined}
                      disabled={busy || saving}
                    >
                      <Flex as="span" direction="column" gap="1" minWidth="0">
                        <Text weight="medium">
                          {entry.name || entry.label || entry.model}
                        </Text>
                        {description && (
                          <Text kind="meta" color="gray">
                            {description}
                          </Text>
                        )}
                        {detail && (
                          <Text kind="meta" color="gray">
                            {detail}
                          </Text>
                        )}
                      </Flex>
                      {entry.model === chosen && <Check size={16} />}
                    </CommandButton>
                  </Command.Item>
                </Tooltip>
              );
            })}
            {!entries.length && query.trim() && allowCustom && (
              <Command.Item
                asChild
                value={query.trim()}
                disabled={busy || saving}
                onSelect={() => void choose({ model: query.trim() })}
              >
                <CommandButton
                  variant="ghost"
                  color="gray"
                  disabled={busy || saving}
                >
                  使用模型 ID：{query.trim()}
                </CommandButton>
              </Command.Item>
            )}
            {!entries.length && !loading && !(allowCustom && query.trim()) && (
              <Text color="gray">没有找到这个模型</Text>
            )}
          </Command.List>
        </Command>
        {(configurationError ||
          (!loading &&
            models.length > 0 &&
            model &&
            !models.some((entry) => entry.model === model))) && (
          <Text as="p">
            {configurationError || "当前模型尚未出现在列表中。"}
          </Text>
        )}
        {busy && <Text as="p">回答进行中，完成或停止后可以切换模型。</Text>}
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
