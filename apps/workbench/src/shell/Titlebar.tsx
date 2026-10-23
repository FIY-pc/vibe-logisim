import { PanelLeft, PanelRight } from "lucide-react";
import type { FeedbackController } from "./Feedback";
import { useWorkspaceLayout } from "./WorkspaceLayout";
import { SimulationMenuRegion } from "../simulation/SimulationMenuRegion";
import { FileMenu } from "../workspace/FileMenu";
import { FileTitle } from "../workspace/FileTitle";

/** The window's title bar: panel toggles, the file title and the menus. */
export function Titlebar({ feedback }: { feedback: FeedbackController }) {
  const { showExplorer, setShowExplorer, showRight, setShowRight } =
    useWorkspaceLayout();
  return (
    <header className="titlebar">
      <button
        className="icon-button project-toggle"
        title="展开 / 收起项目栏"
        aria-label="展开 / 收起项目栏"
        aria-controls="workspace-projects"
        aria-expanded={showExplorer}
        onClick={() => setShowExplorer((shown) => !shown)}
      >
        <PanelLeft size={18} />
      </button>
      <div className="brand">
        <svg aria-hidden="true" viewBox="0 0 38 38">
          <path d="M4 10h10v9h10v9h10" />
          <circle cx="4" cy="10" r="2.3" />
          <circle cx="14" cy="19" r="2.3" />
          <circle cx="24" cy="28" r="2.3" />
          <circle cx="34" cy="28" r="2.3" />
        </svg>
        <span>Vibe Logisim</span>
      </div>
      <FileTitle />
      <div className="title-actions">
        <SimulationMenuRegion />
        <FileMenu feedback={feedback} />
        <button
          className="icon-button"
          title="展开 / 收起工作栏"
          aria-label="展开 / 收起工作栏"
          aria-controls="workspace-review"
          aria-expanded={showRight}
          onClick={() => setShowRight((shown) => !shown)}
        >
          <PanelRight size={18} />
        </button>
      </div>
    </header>
  );
}
