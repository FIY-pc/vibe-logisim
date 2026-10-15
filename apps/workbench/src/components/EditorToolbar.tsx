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
  Minus,
  Plus,
  Grid2X2,
} from "lucide-react";
import type { CatalogTool, Tool } from "../lib/types";
import "./editor-controls.css";

interface Props {
  tool: Tool;
  place: CatalogTool | null;
  shortcuts: Record<string, string>;
  pending: number;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  zoom: number;
  showGrid: boolean;
  onTool: (tool: Tool) => void;
  onCancelPlace: () => void;
  onHistory: (op: "undo" | "redo") => void;
  onDelete: () => void;
  onFit: () => void;
  onZoom: (factor: number) => void;
  onToggleGrid: () => void;
}
const hint = (label: string, binding?: string) =>
  binding ? `${label}（${binding}）` : label;
const actionButton = (
  label: string,
  title: string,
  icon: ReactNode,
  action: () => void,
  disabled = false,
) => (
  <button title={title} aria-label={label} onClick={action} disabled={disabled}>
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
  zoom,
  showGrid,
  onTool,
  onCancelPlace,
  onHistory,
  onDelete,
  onFit,
  onZoom,
  onToggleGrid,
}: Props) {
  return (
    <div className="editor-toolbar canvas-tools" aria-label="画布工具">
      <div className="canvas-tool-modes" role="group" aria-label="画布操作方式">
        {(
          [
            ["select", "选择", MousePointer2, ""],
            [
              "wire",
              "布线",
              Waypoints,
              "；拖动松手落线；点击拐弯，Enter 完成，Esc 取消",
            ],
            ["poke", "操作输入", MousePointerClick, "；首次点击自动启动仿真"],
            ["pan", "平移", Hand, "；也可按住空格"],
          ] as const
        ).map(([id, label, Icon, detail]) => (
          <button
            key={id}
            title={hint(label, shortcuts[id]) + detail}
            aria-label={label}
            aria-pressed={tool === id && !place}
            onClick={() => {
              onTool(id);
              onCancelPlace();
            }}
          >
            <Icon size={15} aria-hidden="true" />
            <span>{label}</span>
            {shortcuts[id] && <kbd aria-hidden="true">{shortcuts[id]}</kbd>}
          </button>
        ))}
      </div>
      <div className="canvas-tool-actions" role="group" aria-label="电路编辑">
        {actionButton(
          "撤销",
          hint("撤销上一步改动", shortcuts.undo),
          <Undo2 size={15} />,
          () => onHistory("undo"),
          !canUndo || Boolean(pending),
        )}
        {actionButton(
          "重做",
          "重做（Ctrl Shift Z）",
          <Redo2 size={15} />,
          () => onHistory("redo"),
          !canRedo || Boolean(pending),
        )}
        {actionButton(
          "删除选中对象",
          "删除选中对象（Backspace / Delete）",
          <Trash2 size={15} />,
          onDelete,
          !hasSelection || Boolean(pending),
        )}
      </div>
      <div className="canvas-tool-actions" role="group" aria-label="画布视图">
        {actionButton(
          "缩小",
          "缩小",
          <Minus size={15} />,
          () => onZoom(1 / 1.2),
          zoom <= 0.05,
        )}
        <output className="canvas-zoom" aria-label="缩放比例">
          {Math.round(zoom * 100)}%
        </output>
        {actionButton(
          "放大",
          "放大",
          <Plus size={15} />,
          () => onZoom(1.2),
          zoom >= 8,
        )}
        <button title={hint("适合窗口", shortcuts.fit)} onClick={onFit}>
          <Maximize size={15} aria-hidden="true" />
          适合
        </button>
        <button
          aria-label="网格"
          aria-pressed={showGrid}
          title={hint(showGrid ? "隐藏网格" : "显示网格", shortcuts.grid)}
          onClick={onToggleGrid}
        >
          <Grid2X2 size={15} />
        </button>
      </div>
    </div>
  );
}
