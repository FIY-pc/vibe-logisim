import { PanelLeft, PanelRight } from "lucide-react";
import { ClassroomEntry } from "../classroom/Classroom";
import type { FeedbackController } from "./Feedback";
import { useWorkspaceLayout } from "./WorkspaceLayout";
import { SimulationMenuRegion } from "../simulation/SimulationMenuRegion";
import { FileMenu } from "../workspace/FileMenu";
import { FileTitle } from "../workspace/FileTitle";
import { tip } from "../shared/Tooltips";
import { useSettings } from "../app/hooks";

/** The window's title bar: panel toggles, the file title and the menus. */
export function Titlebar({ feedback }: { feedback: FeedbackController }) {
  const { showExplorer, setShowExplorer, showRight, setShowRight } =
    useWorkspaceLayout();
  const shortcuts = useSettings((state) => state.labels);
  return (
    <header className="titlebar">
      <button
        className="icon-button project-toggle"
        {...tip("展开 / 收起项目栏", shortcuts.rail)}
        aria-label="展开 / 收起项目栏"
        aria-controls="workspace-projects"
        aria-expanded={showExplorer}
        onClick={() => setShowExplorer((shown) => !shown)}
      >
        <PanelLeft size={16} />
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
        <ClassroomEntry />
        <SimulationMenuRegion />
        <FileMenu feedback={feedback} />
        <button
          className="icon-button"
          {...tip("展开 / 收起工作栏", shortcuts.review)}
          aria-label="展开 / 收起工作栏"
          aria-controls="workspace-review"
          aria-expanded={showRight}
          onClick={() => setShowRight((shown) => !shown)}
        >
          <PanelRight size={16} />
        </button>
      </div>
    </header>
  );
}
