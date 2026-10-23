import { PanelResize, useWorkspaceLayout } from "./WorkspaceLayout";
import { useShell } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { ChangesRegion } from "../history/ChangesRegion";
import { ChatRegion } from "../conversation/ChatRegion";
import { ConnectionsPanel } from "../editor/ConnectionsPanel";

const tabs = [
  ["chat", "对话"],
  ["connections", "连接"],
  ["changes", "改动"],
] as const;

/** The review panel and its conversation, connections and changes tabs. */
export function Aside() {
  const { stores } = useWorkbench();
  const layout = useWorkspaceLayout();
  const right = useShell((state) => state.right);
  const { setRight } = stores.shell.getState();
  return (
    <aside
      id="workspace-review"
      className={"right-panel" + (layout.narrow ? " workspace-drawer" : "")}
      style={{
        width: layout.sizes.review,
        display: layout.showRight ? undefined : "none",
      }}
    >
      <div className="panel-tabs" role="tablist" aria-label="工作栏">
        {tabs.map(([id, label], index) => (
          <button
            key={id}
            role="tab"
            aria-selected={right === id}
            tabIndex={right === id ? 0 : -1}
            className={right === id ? "active" : ""}
            onClick={() => setRight(id)}
            onKeyDown={(event) => {
              const step =
                event.key === "ArrowRight"
                  ? 1
                  : event.key === "ArrowLeft"
                    ? -1
                    : 0;
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : step
                      ? (index + step + tabs.length) % tabs.length
                      : -1;
              if (next < 0) return;
              event.preventDefault();
              setRight(tabs[next][0]);
              (
                event.currentTarget.parentElement?.children[next] as
                  HTMLElement | undefined
              )?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <ConnectionsPanel />
      {!layout.narrow && <PanelResize side="review" layout={layout} />}
      <ChangesRegion />
      <ChatRegion />
    </aside>
  );
}
