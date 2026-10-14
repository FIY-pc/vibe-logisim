import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Search } from "lucide-react";
import type { CatalogGroup, CatalogTool } from "../lib/types";
import "./WorkspaceLayout.css";
const defaults = {
  rail: 260,
  review: 400,
  fileShare: 0.32,
  navigatorShare: 0.3,
  filesCollapsed: false,
  navigatorCollapsed: false,
  inspectorCollapsed: false,
};
type Layout = typeof defaults;
type Side = "rail" | "review";
const limits = { rail: [224, 420], review: [320, 820] };
const sections = [
  "filesCollapsed",
  "navigatorCollapsed",
  "inspectorCollapsed",
] as const;
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(n, max));
function savedLayout(): Layout {
  try {
    const saved = JSON.parse(
      localStorage.getItem("vibe.workspace.layout") || "null",
    );
    if (!saved) return { ...defaults };
    return {
      ...defaults,
      rail: clamp(Number(saved.rail) || 260, 224, 420),
      review: clamp(Number(saved.review) || 400, 320, 820),
      fileShare: clamp(Number(saved.fileShare) || 0.32, 0.1, 0.8),
      navigatorShare: clamp(Number(saved.navigatorShare) || 0.3, 0.1, 0.8),
      filesCollapsed: saved.filesCollapsed === true,
      navigatorCollapsed: saved.navigatorCollapsed === true,
      inspectorCollapsed:
        saved.inspectorCollapsed === true &&
        !(saved.filesCollapsed && saved.navigatorCollapsed),
    };
  } catch {
    return { ...defaults };
  }
}
export function useWorkspaceLayout() {
  const [layout, setLayout] = useState(savedLayout);
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 820);
  const [visible, setVisible] = useState({ rail: true, review: true });
  const [drawer, setDrawer] = useState<Side | null>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem("vibe.workspace.layout", JSON.stringify(layout));
    } catch {}
  }, [layout]);
  useEffect(() => {
    const resize = () => {
      setNarrow(window.innerWidth <= 820);
      setWidth(workspace.current?.clientWidth || window.innerWidth);
    };
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(resize);
    if (workspace.current) observer.observe(workspace.current);
    resize();
    return () => {
      window.removeEventListener("resize", resize);
      observer.disconnect();
    };
  }, []);
  useEffect(() => setDrawer(null), [narrow]);
  const showExplorer = narrow ? drawer === "rail" : visible.rail;
  const showRight = narrow ? drawer === "review" : visible.review;
  const setSide = (
    side: Side,
    next: boolean | ((shown: boolean) => boolean),
  ) => {
    const open = side === "rail" ? showExplorer : showRight;
    const value = typeof next === "function" ? next(open) : next;
    if (narrow) setDrawer(value ? side : null);
    else setVisible((v) => ({ ...v, [side]: value }));
  };
  const extra = Math.max(
    0,
    width - 440 - (visible.rail ? 224 : 0) - (visible.review ? 320 : 0),
  );
  const requested =
    (visible.rail ? layout.rail - 224 : 0) +
    (visible.review ? layout.review - 320 : 0);
  const ratio = requested > extra ? extra / requested : 1;
  const sizes = {
    rail: 224 + (layout.rail - 224) * ratio,
    review: 320 + (layout.review - 320) * ratio,
  };
  const changeWidth = (side: Side, value: number) =>
    setLayout((old) => ({
      ...old,
      [side]: clamp(value, limits[side][0], limits[side][1]),
    }));
  return {
    layout,
    setLayout,
    narrow,
    workspace,
    showExplorer,
    showRight,
    setShowExplorer: (v: boolean | ((shown: boolean) => boolean)) =>
      setSide("rail", v),
    setShowRight: (v: boolean | ((shown: boolean) => boolean)) =>
      setSide("review", v),
    closeDrawers: () => setDrawer(null),
    sizes,
    changeWidth,
    revealInspector: () => {
      setLayout((v) => ({ ...v, inspectorCollapsed: false }));
      setSide("rail", true);
    },
    revealFiles: () => {
      setLayout((v) => ({ ...v, filesCollapsed: false }));
      setSide("rail", true);
    },
    revealNavigator: () => {
      setLayout((v) => ({ ...v, navigatorCollapsed: false }));
      setSide("rail", true);
    },
  };
}
export type WorkspaceLayout = ReturnType<typeof useWorkspaceLayout>;
export function PanelResize({
  side,
  layout,
}: {
  side: Side;
  layout: WorkspaceLayout;
}) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      className={`panel-resizer ${side}-resizer`}
      role="separator"
      tabIndex={0}
      aria-label={side === "rail" ? "调整项目栏宽度" : "调整工作栏宽度"}
      aria-orientation="vertical"
      aria-valuemin={limits[side][0]}
      aria-valuemax={limits[side][1]}
      aria-valuenow={Math.round(layout.sizes[side])}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        drag.current = {
          id: e.pointerId,
          x: e.clientX,
          width: layout.sizes[side],
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d?.id === e.pointerId)
          layout.changeWidth(
            side,
            d.width + (e.clientX - d.x) * (side === "rail" ? 1 : -1),
          );
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onDoubleClick={() => layout.changeWidth(side, defaults[side])}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        layout.changeWidth(
          side,
          e.key === "Home"
            ? defaults[side]
            : layout.sizes[side] +
                (e.key === "ArrowRight" ? 1 : -1) *
                  (side === "rail" ? 1 : -1) *
                  (e.shiftKey ? 40 : 16),
        );
      }}
    />
  );
}
export function WorkspaceRail({
  layout,
  hasCircuit,
  title,
  resourceTab,
  onResourceTab,
  files,
  palette,
  navigation,
  inspector,
  navigatorActions,
  inspectorActions,
}: {
  layout: WorkspaceLayout;
  hasCircuit: boolean;
  title: string;
  resourceTab: "files" | "components";
  onResourceTab: (tab: "files" | "components") => void;
  files: ReactNode;
  palette: ReactNode;
  navigation: ReactNode;
  inspector: ReactNode;
  navigatorActions: ReactNode;
  inspectorActions: ReactNode;
}) {
  const rail = useRef<HTMLElement>(null);
  const rowDrag = useRef<{ id: number; index: number; y: number } | null>(null);
  const weights = [
    layout.layout.fileShare,
    layout.layout.navigatorShare,
    Math.max(0.1, 1 - layout.layout.fileShare - layout.layout.navigatorShare),
  ];
  const toggle = (i: number) =>
    layout.setLayout((old) => {
      const next = { ...old, [sections[i]]: !old[sections[i]] };
      if (sections.every((key) => next[key]))
        next[sections[(i + 1) % 3]] = false;
      return next;
    });
  const adjust = (index: number, delta: number) => {
    const heights = Array.from(
      rail.current?.querySelectorAll<HTMLElement>(":scope > .rail-section") ||
        [],
    ).map((e) => e.getBoundingClientRect().height);
    if (heights.length !== 3) return;
    const total = heights.reduce((a, b) => a + b, 0) || 600;
    const change = clamp(
      delta,
      Math.min(90, heights[index]) - heights[index],
      heights[index + 1] - Math.min(90, heights[index + 1]),
    );
    heights[index] += change;
    heights[index + 1] -= change;
    layout.setLayout((old) => ({
      ...old,
      fileShare: heights[0] / total,
      navigatorShare: heights[1] / total,
    }));
  };
  const splitter = (index: number) => {
    const disabled =
      layout.layout[sections[index]] || layout.layout[sections[index + 1]];
    return (
      <div
        className="row-resizer"
        role="separator"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-orientation="horizontal"
        aria-label={index === 0 ? "调整文件区高度" : "调整当前电路与属性的高度"}
        aria-valuemin={10}
        aria-valuemax={80}
        aria-valuenow={Math.round(weights[index] * 100)}
        onPointerDown={(e) => {
          if (e.button !== 0 || disabled) return;
          e.preventDefault();
          e.currentTarget.focus();
          rowDrag.current = { id: e.pointerId, index, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = rowDrag.current;
          if (d?.id === e.pointerId) {
            adjust(index, e.clientY - d.y);
            d.y = e.clientY;
          }
        }}
        onPointerUp={(e) => {
          rowDrag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          rowDrag.current = null;
        }}
        onLostPointerCapture={() => {
          rowDrag.current = null;
        }}
        onKeyDown={(e) => {
          if (disabled || !["ArrowUp", "ArrowDown", "Home"].includes(e.key))
            return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Home")
            layout.setLayout((v) => ({
              ...v,
              fileShare: defaults.fileShare,
              navigatorShare: defaults.navigatorShare,
            }));
          else
            adjust(
              index,
              (e.key === "ArrowDown" ? 1 : -1) * (e.shiftKey ? 40 : 16),
            );
        }}
      />
    );
  };
  const sectionStyle = (i: number): CSSProperties =>
    layout.layout[sections[i]] && hasCircuit
      ? { flex: "0 0 42px" }
      : { flex: `${weights[i]} 1 0` };
  return (
    <aside
      id="workspace-projects"
      ref={rail}
      className={`explorer workspace-rail${layout.narrow ? " workspace-drawer" : ""}`}
      style={{
        width: layout.sizes.rail,
        display: layout.showExplorer ? undefined : "none",
      }}
      aria-label="项目栏"
    >
      <section
        className="rail-section rail-files"
        style={hasCircuit ? sectionStyle(0) : { flex: 1 }}
      >
        <header>
          <button
            className="section-toggle"
            aria-expanded={!hasCircuit || !layout.layout.filesCollapsed}
            onClick={() => hasCircuit && toggle(0)}
          >
            {title}
          </button>
        </header>
        <div
          className="rail-section-content"
          hidden={hasCircuit && layout.layout.filesCollapsed}
        >
          {hasCircuit && (
            <div className="resource-tabs" role="tablist" aria-label="项目资源">
              {(
                [
                  ["files", "文件"],
                  ["components", "元件"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={resourceTab === id}
                  onClick={() => onResourceTab(id)}
                  onKeyDown={(e) => {
                    if (
                      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        e.key,
                      )
                    )
                      return;
                    e.preventDefault();
                    const next =
                      e.key === "Home"
                        ? "files"
                        : e.key === "End"
                          ? "components"
                          : id === "files"
                            ? "components"
                            : "files";
                    onResourceTab(next);
                    e.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>("button")
                      [next === "files" ? 0 : 1]?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div
            className="resource-pane"
            hidden={hasCircuit && resourceTab !== "files"}
          >
            {files}
          </div>
          {hasCircuit && (
            <div
              className="resource-pane"
              hidden={resourceTab !== "components"}
            >
              {palette}
            </div>
          )}
        </div>
      </section>
      {hasCircuit && (
        <>
          {splitter(0)}
          <section
            className="rail-section rail-navigation"
            style={sectionStyle(1)}
          >
            <header>
              <button
                className="section-toggle"
                aria-expanded={!layout.layout.navigatorCollapsed}
                onClick={() => toggle(1)}
              >
                当前电路
              </button>
              <div>{navigatorActions}</div>
            </header>
            <div
              className="rail-section-content"
              hidden={layout.layout.navigatorCollapsed}
            >
              {navigation}
            </div>
          </section>
          {splitter(1)}
          <section
            className="rail-section rail-inspector"
            style={sectionStyle(2)}
          >
            <header>
              <button
                className="section-toggle"
                aria-expanded={!layout.layout.inspectorCollapsed}
                onClick={() => toggle(2)}
              >
                属性与接口
              </button>
              {inspectorActions}
            </header>
            <div
              className="rail-section-content"
              hidden={layout.layout.inspectorCollapsed}
            >
              {inspector}
            </div>
          </section>
        </>
      )}
      {!layout.narrow && <PanelResize side="rail" layout={layout} />}
    </aside>
  );
}
export function ComponentPalette({
  catalog,
  search,
  onSearch,
  inputRef,
  shortcut,
  place,
  onSelect,
}: {
  catalog: CatalogGroup[];
  search: string;
  onSearch: (s: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  shortcut: string;
  place: CatalogTool | null;
  onSelect: (t: CatalogTool) => void;
}) {
  return (
    <>
      <div className="palette-search">
        <Search size={15} />
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="搜索元件"
          aria-label="搜索元件"
        />
        <kbd>{shortcut}</kbd>
      </div>
      <div className="palette">
        {catalog.map((group) => {
          const tools = group.tools.filter((t) =>
            (t.name + " " + t.label)
              .toLowerCase()
              .includes(search.toLowerCase()),
          );
          return tools.length ? (
            <details key={group.id} open>
              <summary>{group.label}</summary>
              {tools.map((t) => (
                <button
                  key={t.name}
                  disabled={Boolean(t.disabled)}
                  title={t.disabled || t.label}
                  aria-label={t.label}
                  className={
                    place?.name === t.name && place.library === t.library
                      ? "selected"
                      : ""
                  }
                  onClick={() => onSelect(t)}
                >
                  {t.icon && <img src={t.icon} alt="" />}
                  <span>{t.label}</span>
                </button>
              ))}
            </details>
          ) : null;
        })}
      </div>
    </>
  );
}
