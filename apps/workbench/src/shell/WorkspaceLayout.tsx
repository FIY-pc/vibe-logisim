import { useRef, type ReactNode, type RefObject } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { Search } from "lucide-react";
import type { CatalogGroup, CatalogTool } from "../shared/types";
import { layoutLimits as limits, railSections as sections } from "./store";
import { useShell } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { fullText, tip } from "../shared/Tooltips";
/** The workspace frame's layout, read from the shell store. */
export function useWorkspaceLayout() {
  const {
    setLayout,
    setSide,
    closeDrawers,
    revealInspector,
    revealFiles,
    revealNavigator,
    workspaceRef,
  } = useWorkbench().stores.shell.getState();
  const layout = useShell((state) => state.layout);
  const narrow = useShell((state) => state.narrow);
  const visible = useShell((state) => state.visible);
  const drawer = useShell((state) => state.drawer);
  return {
    layout,
    setLayout,
    narrow,
    workspace: workspaceRef,
    showExplorer: narrow ? drawer === "rail" : visible.rail,
    showRight: narrow ? drawer === "review" : visible.review,
    setShowExplorer: (v: boolean | ((shown: boolean) => boolean)) =>
      setSide("rail", v),
    setShowRight: (v: boolean | ((shown: boolean) => boolean)) =>
      setSide("review", v),
    closeDrawers,
    revealInspector,
    revealFiles,
    revealNavigator,
  };
}
export type WorkspaceLayout = ReturnType<typeof useWorkspaceLayout>;
/** Panel geometry belongs to the resize library; the shell owns visibility and
 * the user's preferred pixel widths. Keep children mounted across drawer mode. */
export function WorkspacePanels({
  layout,
  rail,
  children,
  review,
}: {
  layout: WorkspaceLayout;
  rail: ReactNode;
  children: ReactNode;
  review: ReactNode;
}) {
  const initial = useRef(layout.layout).current;
  const group = useRef<HTMLDivElement>(null);
  const groupApi = useGroupRef();
  const previousFrame = useRef("");
  const railOpen = !layout.narrow && layout.showExplorer;
  const reviewOpen = !layout.narrow && layout.showRight;
  return (
    <div className="workspace" ref={layout.workspace}>
      {layout.narrow && (layout.showExplorer || layout.showRight) && (
        <button
          className="workspace-shade"
          aria-label="关闭侧栏"
          onClick={layout.closeDrawers}
        />
      )}
      <Group
        id="workspace-columns"
        elementRef={group}
        groupRef={groupApi}
        className="workspace-columns"
        style={{ overflow: "visible" }}
        disabled={layout.narrow}
        onLayoutChanged={(sizes, { isUserInteraction, requestedLayout }) => {
          const element = group.current;
          if (!element) return;
          const separators = Array.from(element.children).filter((child) =>
            child.hasAttribute("data-separator"),
          );
          const available =
            element.clientWidth -
            separators.reduce(
              (sum, child) => sum + (child as HTMLElement).offsetWidth,
              0,
            );
          if (!available) return;
          const frame = `${available}:${railOpen}:${reviewOpen}`;
          if (!isUserInteraction && previousFrame.current !== frame) {
            previousFrame.current = frame;
            // Restore the requested pixels when the drawer/visibility context
            // changes; the library applies all current constraints.
            const rail = railOpen ? (layout.layout.rail / available) * 100 : 0;
            const review = reviewOpen
              ? (layout.layout.review / available) * 100
              : 0;
            // Wait for Panel registration to publish the new constraints.
            queueMicrotask(() => {
              if (previousFrame.current === frame)
                groupApi.current?.setLayout({
                  rail,
                  editor: 100 - rail - review,
                  review,
                });
            });
            return;
          }
          previousFrame.current = frame;
          if (!isUserInteraction || layout.narrow) return;
          const pixelsPerPercent = available / 100;
          const requested = requestedLayout ?? sizes;
          layout.setLayout((old) => ({
            ...old,
            ...(railOpen ? { rail: requested.rail * pixelsPerPercent } : {}),
            ...(reviewOpen
              ? { review: requested.review * pixelsPerPercent }
              : {}),
          }));
        }}
      >
        <Panel
          id="rail"
          className="workspace-side"
          style={{ overflow: "visible" }}
          defaultSize={initial.rail}
          minSize={railOpen ? limits.rail[0] : 0}
          maxSize={railOpen ? limits.rail[1] : 0}
          groupResizeBehavior="preserve-pixel-size"
        >
          {rail}
        </Panel>
        <Separator
          className="panel-resizer"
          aria-label="调整项目栏宽度"
          disabled={!railOpen}
          style={{ display: railOpen ? undefined : "none" }}
        />
        <Panel
          id="editor"
          className="workspace-center"
          minSize={layout.narrow ? 0 : 440}
        >
          {children}
        </Panel>
        <Separator
          className="panel-resizer"
          aria-label="调整工作栏宽度"
          disabled={!reviewOpen}
          style={{ display: reviewOpen ? undefined : "none" }}
        />
        <Panel
          id="review"
          className="workspace-side"
          style={{ overflow: "visible" }}
          defaultSize={initial.review}
          minSize={reviewOpen ? limits.review[0] : 0}
          maxSize={reviewOpen ? limits.review[1] : 0}
          groupResizeBehavior="preserve-pixel-size"
        >
          {review}
        </Panel>
      </Group>
    </div>
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
  const initial = useRef(layout.layout).current;
  const weights = [
    initial.fileShare,
    initial.navigatorShare,
    1 - initial.fileShare - initial.navigatorShare,
  ];
  const ids = ["files", "navigation", "inspector"];
  const groupApi = useGroupRef();
  const previousSections = useRef("");
  const toggle = (i: number) =>
    layout.setLayout((old) => {
      const next = { ...old, [sections[i]]: !old[sections[i]] };
      if (sections.every((key) => next[key]))
        next[sections[(i + 1) % 3]] = false;
      return next;
    });
  const panelProps = (i: number) => ({
    id: ids[i],
    defaultSize: `${weights[i] * 100}%`,
    minSize: layout.layout[sections[i]] ? 42 : 90,
    maxSize: layout.layout[sections[i]] ? 42 : undefined,
    className: "rail-section-panel",
  });
  const splitter = (index: number) => (
    <Separator
      className="row-resizer"
      disabled={
        layout.layout[sections[index]] || layout.layout[sections[index + 1]]
      }
      aria-label={
        index === 0 ? "调整资源与电路区域高度" : "调整电路与属性区域高度"
      }
    />
  );
  return (
    <aside
      id="workspace-projects"
      className={`explorer workspace-rail${layout.narrow ? " workspace-drawer" : ""}`}
      style={{
        display: layout.showExplorer ? undefined : "none",
      }}
      aria-label="项目栏"
    >
      <Group
        id="workspace-sections"
        groupRef={groupApi}
        orientation="vertical"
        onLayoutChanged={(sizes, { isUserInteraction, requestedLayout }) => {
          const sectionState = `${hasCircuit}:${sections.map((key) => layout.layout[key]).join(":")}`;
          if (!isUserInteraction && previousSections.current !== sectionState) {
            previousSections.current = sectionState;
            if (hasCircuit)
              queueMicrotask(() => {
                if (previousSections.current === sectionState)
                  groupApi.current?.setLayout({
                    files: layout.layout.fileShare * 100,
                    navigation: layout.layout.navigatorShare * 100,
                    inspector:
                      (1 -
                        layout.layout.fileShare -
                        layout.layout.navigatorShare) *
                      100,
                  });
              });
            return;
          }
          previousSections.current = sectionState;
          if (!isUserInteraction || !hasCircuit) return;
          const requested = requestedLayout ?? sizes;
          // Collapsed headers do not replace the expanded section's preferred share.
          layout.setLayout((old) => {
            const shares = [
              old.fileShare,
              old.navigatorShare,
              1 - old.fileShare - old.navigatorShare,
            ];
            const open = ids.map((_, i) => i).filter((i) => !old[sections[i]]);
            const weight = open.reduce((sum, i) => sum + shares[i], 0);
            const total = open.reduce((sum, i) => sum + requested[ids[i]], 0);
            for (const i of open)
              shares[i] = (requested[ids[i]] / total) * weight;
            return { ...old, fileShare: shares[0], navigatorShare: shares[1] };
          });
        }}
      >
        <Panel
          {...(hasCircuit
            ? panelProps(0)
            : { id: "files", className: "rail-section-panel" })}
        >
          <section className="rail-section rail-files">
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
              {/* Always shown, so opening the first circuit does not shift the file list under the pointer. */}
              <div
                className="resource-tabs"
                role="tablist"
                aria-label="项目资源"
              >
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
              <div className="resource-pane" hidden={resourceTab !== "files"}>
                {files}
              </div>
              <div
                className="resource-pane"
                hidden={resourceTab !== "components"}
              >
                {hasCircuit ? (
                  palette
                ) : (
                  <div className="quiet-empty">打开电路后可以放置元件</div>
                )}
              </div>
            </div>
          </section>
        </Panel>
        {hasCircuit && (
          <>
            {splitter(0)}
            <Panel {...panelProps(1)}>
              <section className="rail-section rail-navigation">
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
            </Panel>
            {splitter(1)}
            <Panel {...panelProps(2)}>
              <section className="rail-section rail-inspector">
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
            </Panel>
          </>
        )}
      </Group>
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
          // Parts match by their label, native name or the runtime's name.
          const tools = group.tools.filter((t) =>
            [t.name, t.label, t.nativeLabel]
              .join(" ")
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
                  {...(t.disabled ? tip(t.disabled) : fullText(t.label))}
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
