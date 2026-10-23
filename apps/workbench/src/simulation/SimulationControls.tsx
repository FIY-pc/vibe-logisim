import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Pause, Play, RotateCcw, StepForward } from "lucide-react";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from "../shared/Menu";
import type { Tool } from "../shared/types";
import type { RunAction } from "./actions";
import type { SimulationStatus } from "./store";
import "../editor/editor-controls.css";
import { DialogClose, useModal } from "../shared/Dialog";
import { tip } from "../shared/Tooltips";

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
  const trigger = useRef<HTMLButtonElement>(null);
  const active = status.current;
  const running = status.running;
  const automatic = status.automatic;
  const rootCircuit = status.circuit ?? null;
  useEffect(() => {
    setOpen(false);
    setSettings(false);
  }, [contextKey]);
  const action = (
    label: string,
    target: RunAction,
    shortcut?: string,
    unavailable = disabled,
  ) => (
    <MenuItem
      shortcut={shortcut}
      disabled={
        unavailable || status.viewBusy || (target === "stop" && !status.exists)
      }
      onSelect={() => run(target)}
    >
      {label}
    </MenuItem>
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
      <Menu
        label="仿真"
        className={
          running
            ? "simulation-menu-trigger running"
            : "simulation-menu-trigger"
        }
        align="start"
        triggerRef={trigger}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <>
            仿真 <ChevronDown size={14} aria-hidden="true" />
          </>
        }
      >
        <MenuLabel>
          <strong>{owner}</strong>
          <span>{state}</span>
        </MenuLabel>
        {onReturnToSimulation && (
          <MenuItem
            disabled={status.viewBusy || status.busy}
            onSelect={onReturnToSimulation}
          >
            返回运行电路
          </MenuItem>
        )}
        {!active && action("启动仿真", "start")}
        {action(
          running ? "暂停时钟" : "运行时钟",
          "toggle-clock",
          shortcuts.clock,
        )}
        {action(
          "时钟一步",
          "tick",
          shortcuts.tick,
          disabled || !active || running,
        )}
        <MenuSeparator />
        <MenuCheckboxItem
          checked={automatic}
          shortcut={shortcuts.propagation}
          disabled={disabled || status.viewBusy || !active}
          onCheckedChange={() => run("toggle-propagation")}
        >
          自动传播
        </MenuCheckboxItem>
        {action("传播一步", "step", shortcuts.step, disabled || !active)}
        {action("复位仿真", "reset", shortcuts.reset, disabled || !active)}
        <MenuSeparator />
        <MenuItem
          shortcut={shortcuts.capture}
          disabled={!active || disabled}
          onSelect={() => void capture().catch(onError)}
        >
          留存此刻
        </MenuItem>
        <MenuItem disabled={!circuitName} onSelect={onObservations}>
          留存观察…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={!circuitName || disabled}
          onSelect={() => setSettings(true)}
        >
          仿真设置…
        </MenuItem>
        <MenuItem
          disabled={!active || disabled || status.viewBusy || !status.exists}
          title="清除本次运行的输入和状态，电路设计与留存观察会保留"
          onSelect={() => run("stop")}
        >
          结束本次仿真
        </MenuItem>
      </Menu>
      {settings &&
        createPortal(
          <SimulationSettings
            frequency={status.frequency || frequency}
            onApply={onFrequencyChange}
            onClose={() => {
              setSettings(false);
              trigger.current?.focus();
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
  const dialog = useModal();
  const alive = useRef(true);
  const [value, setValue] = useState(String(frequency));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
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
        <DialogClose
          label="关闭仿真设置"
          disabled={pending}
          onClick={onClose}
        />
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
              data-autofocus
              type="number"
              min="0.25"
              max="4096"
              step="any"
              required
              disabled={pending}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
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
            {...tip(running ? "暂停时钟" : "运行时钟", shortcuts.clock)}
            disabled={disabled || status.viewBusy}
            onClick={() => dispatch("toggle-clock")}
          >
            {running ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button
            aria-label="时钟一步"
            {...(running
              ? tip("先暂停时钟，再逐步推进")
              : tip("时钟一步", shortcuts.tick))}
            disabled={disabled || running || status.viewBusy || !active}
            onClick={() => dispatch("tick")}
          >
            <StepForward size={15} />
          </button>
          <button
            aria-label="复位仿真"
            {...tip("复位仿真", shortcuts.reset)}
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
