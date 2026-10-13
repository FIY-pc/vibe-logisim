import type { ReactNode } from "react";
import {
  MousePointer2,
  Waypoints,
  Hand,
  MousePointerClick,
  Undo2,
  Redo2,
  Trash2,
  Maximize,
  Play,
  Pause,
  StepForward,
  RotateCcw,
  Square,
  ChevronDown,
} from "lucide-react";
import type { CatalogTool, Simulation, Tool } from "../lib/types";
interface Props {
  tool: Tool;
  place: CatalogTool | null;
  shortcuts: Record<string, string>;
  pending: number;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  activeSim: Simulation | null;
  onTool: (tool: Tool) => void;
  onCancelPlace: () => void;
  onHistory: (op: "undo" | "redo") => void;
  onDelete: () => void;
  onFit: () => void;
  onObservations: () => void;
  simulate: (op: string, attributes?: Record<string, string>) => Promise<void>;
  capture: () => Promise<void>;
  onError: (e: unknown) => void;
}
const actionButton = (
  title: string,
  icon: ReactNode,
  action: () => void,
  disabled = false,
) => (
  <button
    className="icon-button"
    title={title}
    aria-label={title}
    onClick={action}
    disabled={disabled}
  >
    {icon}
  </button>
);
export function EditorToolbar({
  tool,
  place,
  shortcuts,
  pending,
  canUndo,
  canRedo,
  hasSelection,
  activeSim,
  onTool,
  onCancelPlace,
  onHistory,
  onDelete,
  onFit,
  onObservations,
  simulate,
  capture,
  onError,
}: Props) {
  return (
    <div className="editor-toolbar">
      <div className="tool-group">
        {(
          [
            ["select", "选择", MousePointer2],
            ["wire", "布线", Waypoints],
            ["poke", "交互", MousePointerClick],
            ["pan", "平移", Hand],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            title={`${label} (${shortcuts[id]})`}
            aria-label={label}
            aria-pressed={tool === id && !place}
            onClick={() => {
              onTool(id);
              onCancelPlace();
            }}
          >
            <Icon size={17} />
            <kbd>{shortcuts[id]}</kbd>
          </button>
        ))}
      </div>
      <div className="tool-group">
        {actionButton(
          `撤销 (${shortcuts.undo})`,
          <Undo2 size={17} />,
          () => onHistory("undo"),
          !canUndo || Boolean(pending),
        )}
        {actionButton(
          "重做 (Ctrl Shift Z)",
          <Redo2 size={17} />,
          () => onHistory("redo"),
          !canRedo || Boolean(pending),
        )}
        {actionButton(
          "删除",
          <Trash2 size={16} />,
          () => onDelete(),
          !hasSelection,
        )}
        {actionButton(
          `适应画布 (${shortcuts.fit})`,
          <Maximize size={16} />,
          () => onFit(),
        )}
      </div>
      <div className="simulation-controls">
        {pending > 0 && <span className="spinner" aria-label="操作进行中" />}
        <button
          className={activeSim ? "simulation active" : "simulation"}
          title={`运行 / 暂停时钟 (${shortcuts.clock})`}
          disabled={Boolean(pending)}
          onClick={() =>
            void simulate(
              activeSim?.frame.attributes.running === "true" ? "pause" : "play",
            ).catch(onError)
          }
        >
          {activeSim?.frame.attributes.running === "true" ? (
            <Pause size={15} />
          ) : (
            <Play size={15} />
          )}
          仿真
        </button>
        <details className="menu simulation-menu">
          <summary aria-label="仿真菜单">
            <ChevronDown size={13} />
          </summary>
          <div className="menu-content">
            <button
              disabled={Boolean(pending)}
              onClick={() => void simulate("start").catch(onError)}
            >
              启动仿真
            </button>
            <button
              disabled={Boolean(pending)}
              onClick={() => void simulate("step").catch(onError)}
            >
              传播一步
            </button>
            <button
              disabled={Boolean(pending)}
              role="menuitemcheckbox"
              aria-checked={activeSim?.frame.attributes.automatic !== "false"}
              onClick={() =>
                void simulate("configure", {
                  automatic:
                    activeSim?.frame.attributes.automatic === "false"
                      ? "true"
                      : "false",
                }).catch(onError)
              }
            >
              自动传播{" "}
              {activeSim?.frame.attributes.automatic !== "false" ? "✓" : ""}
            </button>
            <label className="frequency-setting">
              时钟频率{" "}
              <select
                aria-label="时钟频率"
                disabled={Boolean(pending)}
                value={activeSim?.frame.attributes.frequency || "2.0"}
                onChange={(e) =>
                  void simulate("configure", {
                    frequency: e.target.value,
                  }).catch(onError)
                }
              >
                {[
                  0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048,
                  4096,
                ].map((f) => (
                  <option key={f} value={String(f.toFixed(1))}>
                    {f} Hz
                  </option>
                ))}
              </select>
            </label>
            <hr />
            <button
              disabled={!activeSim || Boolean(pending)}
              onClick={() => void capture().catch(onError)}
            >
              留存此刻 <kbd>{shortcuts.capture}</kbd>
            </button>
            <button onClick={() => onObservations()}>留存观察</button>
          </div>
        </details>
        {actionButton(
          `时钟步进 (${shortcuts.tick})`,
          <StepForward size={17} />,
          () => void simulate("tick").catch(onError),
          Boolean(pending),
        )}
        {activeSim && (
          <>
            {actionButton(
              "重置仿真",
              <RotateCcw size={16} />,
              () => void simulate("reset").catch(onError),
              Boolean(pending),
            )}
            {actionButton(
              "停止仿真",
              <Square size={14} />,
              () => void simulate("stop").catch(onError),
              Boolean(pending),
            )}
          </>
        )}
      </div>
    </div>
  );
}
