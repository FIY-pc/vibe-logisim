import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { DialogClose } from "../shared/Dialog";
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
  const [recent, setRecent] = useState<{ scope: string; models: string[] }>({
    scope,
    models: [],
  });
  return (
    <>
      <button
        ref={trigger}
        className="ai-model-trigger"
        aria-label={`选择模型：${name || model || "选择模型"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{name || model || "选择模型"}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <ModelDialog
          key={scope}
          trigger={trigger.current}
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
    </>
  );
}
function ModelDialog({
  trigger,
  model,
  recent,
  busy,
  configurationError,
  load,
  select,
  onClose,
}: {
  trigger: HTMLButtonElement | null;
  model: string | null;
  recent: string[];
  busy: boolean;
  configurationError?: string;
  load: (refresh: boolean) => Promise<ModelListResult>;
  select: (model: ModelOption) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null),
    list = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<ModelOption[]>([]),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
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
    const node = dialog.current;
    const position = () => {
      if (!node || !trigger) return;
      const anchor = trigger.getBoundingClientRect();
      node.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - node.offsetWidth - 12))}px`;
      node.style.top = `${Math.max(12, Math.min(anchor.top - node.offsetHeight - 8, window.innerHeight - node.offsetHeight - 12))}px`;
    };
    node?.showModal();
    search.current?.focus();
    position();
    const observer = new ResizeObserver(position);
    if (node) observer.observe(node);
    window.addEventListener("resize", position);
    void reload(false);
    return () => {
      epoch.current++;
      observer.disconnect();
      window.removeEventListener("resize", position);
      node?.close();
      if (trigger?.isConnected) trigger.focus();
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
    <dialog
      ref={dialog}
      className="ai-model-dialog"
      aria-labelledby="ai-model-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || saving) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
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
      <header>
        <h2 id="ai-model-title">选择模型</h2>
        <DialogClose label="关闭模型设置" disabled={saving} onClick={onClose} />
      </header>
      <input
        ref={search}
        className="ai-model-search"
        type="search"
        aria-label="搜索模型"
        placeholder="搜索模型"
        autoComplete="off"
        value={query}
        disabled={saving}
        onChange={(event) => setQuery(event.target.value)}
      />
      {loading && <p role="status">正在更新…</p>}
      <div
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
            <button
              key={entry.model}
              className="ai-model-option"
              role="option"
              aria-selected={entry.model === chosen}
              disabled={busy || saving}
              onClick={() => void choose(entry)}
              title={[
                entry.model,
                info?.source ? `资料来源：${info.source}` : null,
                info?.toolCall === false ? "目录标记不支持工具调用" : null,
                info?.status ? "目录标记已弃用" : null,
              ]
                .filter(Boolean)
                .join("\n")}
            >
              <span>
                <strong>{entry.name || entry.label || entry.model}</strong>
                {description && <small>{description}</small>}
                {detail && <small>{detail}</small>}
              </span>
              {entry.model === chosen && <Check size={15} />}
            </button>
          );
        })}
        {!entries.length && !loading && (
          <p className="muted">没有找到这个模型</p>
        )}
      </div>
      {(configurationError ||
        (!loading &&
          models.length > 0 &&
          model &&
          !models.some((entry) => entry.model === model))) && (
        <p>{configurationError || "当前模型尚未出现在列表中。"}</p>
      )}
      {busy && <p>回答进行中，完成或停止后可以切换模型。</p>}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button
          disabled={loading || saving || busy}
          onClick={() => void reload(true)}
        >
          <RefreshCw size={13} />
          刷新列表
        </button>
      </footer>
    </dialog>
  );
}
