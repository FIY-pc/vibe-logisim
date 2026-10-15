import {
  PanelResize,
  useWorkspaceLayout,
} from "../../components/WorkspaceLayout";
import { useShell } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";
import { ChangesRegion } from "../changes/ChangesRegion";
import { ChatRegion } from "../conversation/ChatRegion";
import { ConnectionsPanel } from "../editor/ConnectionsPanel";

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
      <div className="panel-tabs">
        <button
          className={right === "chat" ? "active" : ""}
          onClick={() => setRight("chat")}
        >
          对话
        </button>
        <button
          className={right === "connections" ? "active" : ""}
          onClick={() => setRight("connections")}
        >
          连接
        </button>
        <button
          className={right === "changes" ? "active" : ""}
          onClick={() => setRight("changes")}
        >
          改动
        </button>
      </div>
      <ConnectionsPanel />
      {!layout.narrow && <PanelResize side="review" layout={layout} />}
      <ChangesRegion />
      <ChatRegion />
    </aside>
  );
}
