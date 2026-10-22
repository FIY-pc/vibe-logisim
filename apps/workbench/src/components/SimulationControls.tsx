import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Pause,
  Play,
  RotateCcw,
  StepForward,
  X,
} from "lucide-react";
import type { Tool } from "../lib/types";
import type { RunAction } from "../actions/simulation";
import type { SimulationStatus } from "../stores/simulation";
import "./editor-controls.css";

interface SimulationProps {
  /** What the controls show for the shown circuit, and whether each can act. */
  status: SimulationStatus;
  disabled: boolean;
  shortcuts: Record<string, string>;
  run: (action: RunAction) => void;
}
interface MenuProps extends SimulationProps {
  contextKey: string;
  circuitName: string | null;
  frequency: number;
  onFrequencyChange: (value: number) => Promise<void>;
  capture: () => Promise<void>;
  onObservations: () => void;
  onReturnToSimulation?: () => void;
  onError: (error: unknown) => void;
}
const hint = (label: string, binding?: string) =>
  binding ? `${label}（${binding}）` : label;
const pendingLabel = (action: string, active: boolean) => {
  if (action === "stop") return "结束中…";
  if (!active || action === "start") return "启动中…";
  if (action === "reset") return "复位中…";
  if (action === "tick") return "推进时钟…";
  if (action === "step") return "传播中…";
  if (action === "configure" || action === "toggle-propagation")
    return "更新设置…";
  return "更新时钟…";
};

export function SimulationMenu({
  contextKey,
  circuitName,
  status,
  disabled,
  shortcuts,
  run,
  capture,
  onObservations,
  onReturnToSimulation,
  onError,
  frequency,
  onFrequencyChange,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const menuId = useId();
  const active = status.current;
  const running = status.running;
  const automatic = status.automatic;
  const rootCircuit = status.circuit ?? null;
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  };
  const items = () =>
    Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) || [],
    );
  useEffect(() => {
    setOpen(false);
    setSettings(false);
  }, [contextKey]);
  useLayoutEffect(() => {
    if (!open) return;
    const positionPanel = () => {
      const anchor = button.current?.getBoundingClientRect();
      const rect = panel.current?.getBoundingClientRect();
      if (!anchor || !rect) return;
      setPosition({
        left: Math.max(
          8,
          Math.min(anchor.left, window.innerWidth - rect.width - 8),
        ),
        top: Math.max(
          8,
          Math.min(anchor.bottom + 6, window.innerHeight - rect.height - 8),
        ),
      });
    };
    positionPanel();
    const enabled = items();
    (focusLast.current ? enabled.at(-1) : enabled[0])?.focus();
    window.addEventListener("resize", positionPanel);
    return () => window.removeEventListener("resize", positionPanel);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !panel.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const dispatch = (action: RunAction) => {
    close();
    run(action);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items();
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const index = enabled.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? enabled.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) %
              enabled.length;
      enabled[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      close();
    }
  };
  const action = (
    label: string,
    target: RunAction,
    shortcut?: string,
    unavailable = disabled,
  ) => (
    <button
      role="menuitem"
      tabIndex={-1}
      disabled={unavailable || status.viewBusy || (target === "stop" && !status.exists)}
      onClick={() => dispatch(target)}
    >
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
  const state = status.busy
    ? pendingLabel(status.busyAction || "", active)
    : !active
      ? "尚未开始"
      : `${running ? "时钟运行" : "时钟暂停"}${automatic ? "" : " · 自动传播已暂停"} · ${status.ticks || 0} tick`;
  const owner = active
    ? rootCircuit || circuitName || "尚未打开电路"
    : circuitName || "尚未打开电路";
  return (
    <>
      <button
        ref={button}
        className="simulation-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-running={running}
        onClick={() => {
          focusLast.current = false;
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          focusLast.current = event.key === "ArrowUp";
          setOpen(true);
          if (open) {
            const enabled = items();
            (focusLast.current ? enabled.at(-1) : enabled[0])?.focus();
          }
        }}
      >
        仿真 <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={menuId}
            className="runtime-menu"
            role="menu"
            aria-label="仿真"
            style={position}
            onKeyDown={keyDown}
          >
            <div className="runtime-menu-heading" role="presentation">
              <strong>{owner}</strong>
              <span>{state}</span>
            </div>
            {onReturnToSimulation && (
              <button
                role="menuitem"
                tabIndex={-1}
                disabled={status.viewBusy || status.busy}
                onClick={() => {
                  close();
                  onReturnToSimulation();
                }}
              >
                返回运行电路
              </button>
            )}
            {!active && action("启动仿真", "start")}
            {action(
              running ? "暂停时钟" : "运行时钟",
              "toggle-clock",
              shortcuts.clock,
            )}
            {action("时钟一步", "tick", shortcuts.tick, disabled || !active || running)}
            <hr role="separator" />
            <button
              role="menuitemcheckbox"
              tabIndex={-1}
              aria-checked={automatic}
              disabled={disabled || status.viewBusy || !active}
              onClick={() => dispatch("toggle-propagation")}
            >
              <span>自动传播</span>
              {shortcuts.propagation && <kbd>{shortcuts.propagation}</kbd>}
            </button>
            {action("传播一步", "step", shortcuts.step, disabled || !active)}
            {action("复位仿真", "reset", shortcuts.reset, disabled || !active)}
            <hr role="separator" />
            <button
              role="menuitem"
              tabIndex={-1}
              disabled={!active || disabled}
              onClick={() => {
                close();
                void capture().catch(onError);
              }}
            >
              <span>留存此刻</span>
              {shortcuts.capture && <kbd>{shortcuts.capture}</kbd>}
            </button>
            <button
              role="menuitem"
              tabIndex={-1}
              disabled={!circuitName}
              onClick={() => {
                close();
                onObservations();
              }}
            >
              留存观察
            </button>
            <hr role="separator" />
            <button
              role="menuitem"
              tabIndex={-1}
              disabled={!circuitName || disabled}
              onClick={() => {
                close(false);
                setSettings(true);
              }}
            >
              仿真设置…
            </button>
            <button
              role="menuitem"
              tabIndex={-1}
              disabled={!active || disabled}
              title="清除本次运行的输入和状态，电路设计与留存观察会保留"
              onClick={() => dispatch("stop")}
            >
              结束本次仿真
            </button>
          </div>,
          document.body,
        )}
      {settings &&
        createPortal(
          <SimulationSettings
            frequency={status.frequency || frequency}
            onApply={onFrequencyChange}
            onClose={() => {
              setSettings(false);
              button.current?.focus();
            }}
          />,
          document.body,
        )}
    </>
  );
}

function SimulationSettings({
  frequency,
  onApply,
  onClose,
}: {
  frequency: number;
  onApply: (value: number) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const [value, setValue] = useState(String(frequency));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    const node = dialog.current;
    node?.showModal();
    input.current?.focus();
    return () => {
      alive.current = false;
      node?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="simulation-settings"
      aria-label="仿真设置"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <header>
        <h2>仿真设置</h2>
        <button aria-label="关闭仿真设置" disabled={pending} onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          setPending(true);
          setError("");
          void onApply(Number(value))
            .then(() => {
              if (alive.current) onClose();
            })
            .catch((reason: unknown) => {
              if (alive.current)
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
            })
            .finally(() => {
              if (alive.current) setPending(false);
            });
        }}
      >
        <label className="simulation-frequency">
          时钟频率{" "}
          <span>
            <input
              ref={input}
              type="number"
              min="0.25"
              max="4096"
              step="any"
              required
              disabled={pending}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />{" "}
            tick/s
          </span>
        </label>
        <p>高、低电平各 1 tick 时，2 tick/s 为每秒一个完整周期。</p>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={pending} onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={pending}>
            {pending ? "应用中…" : "应用"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function SimulationTransport({
  status,
  disabled,
  shortcuts,
  run,
  tool,
}: SimulationProps & { tool: Tool }) {
  const active = status.current;
  if (!active && !status.busy && !status.stale && tool !== "poke") return null;
  const running = status.running;
  const automatic = status.automatic;
  const text = status.busy
    ? pendingLabel(status.busyAction || "", active)
    : status.stale
      ? "电路已改动"
      : !active
        ? "未仿真"
        : !automatic
          ? "传播已暂停"
          : running
            ? "时钟运行"
            : "交互中";
  const dispatch = (action: RunAction) => run(action);
  return (
    <div
      className="runtime-transport"
      role="toolbar"
      aria-label="仿真控制"
      aria-busy={status.busy}
      data-running={running}
    >
      {status.busy && <span className="spinner" aria-hidden="true" />}
      <output role="status" aria-live="polite">
        {text}
      </output>
      {status.stale ? (
        <button
          className="runtime-restart"
          disabled={disabled || status.viewBusy}
          onClick={() => dispatch("start")}
        >
          重新仿真
        </button>
      ) : (
        <>
          <button
            aria-label={running ? "暂停时钟" : "运行时钟"}
            title={hint(running ? "暂停时钟" : "运行时钟", shortcuts.clock)}
            disabled={disabled || status.viewBusy}
            onClick={() => dispatch("toggle-clock")}
          >
            {running ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button
            aria-label="时钟一步"
            title={
              running
                ? "先暂停时钟，再逐步推进"
                : hint("时钟一步", shortcuts.tick)
            }
            disabled={disabled || running || status.viewBusy || !active}
            onClick={() => dispatch("tick")}
          >
            <StepForward size={15} />
          </button>
          <button
            aria-label="复位仿真"
            title={hint("复位仿真", shortcuts.reset)}
            disabled={disabled || !active || status.viewBusy}
            onClick={() => dispatch("reset")}
          >
            <RotateCcw size={15} />
          </button>
        </>
      )}
    </div>
  );
}
