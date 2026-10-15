import { useEffect, useLayoutEffect } from "react";
import { UpdateNotice, useFeedback } from "./components/Feedback";
import { useWorkspaceLayout } from "./components/WorkspaceLayout";
import { usePlacement } from "./lib/usePlacement";
import { Breadcrumbs } from "./regions/editor/Breadcrumbs";
import { CanvasRegion } from "./regions/editor/CanvasRegion";
import { CircuitPrompts } from "./regions/editor/CircuitPrompts";
import { EditorToolbarRegion } from "./regions/editor/EditorToolbarRegion";
import { FindRegion } from "./regions/editor/FindRegion";
import { InterfaceEditorRegion } from "./regions/editor/InterfaceEditorRegion";
import { SourceDialog } from "./regions/editor/SourceDialog";
import { Aside } from "./regions/shell/Aside";
import { DecisionRegion } from "./regions/shell/DecisionRegion";
import { ErrorBar, Notice } from "./regions/shell/Notices";
import { Rail } from "./regions/shell/Rail";
import { ShortcutSettingsRegion } from "./regions/shell/ShortcutSettingsRegion";
import { Titlebar } from "./regions/shell/Titlebar";
import { CaptureNotice } from "./regions/simulation/CaptureNotice";
import { MemoryRegion } from "./regions/simulation/MemoryRegion";
import { ObservationsRegion } from "./regions/simulation/ObservationsRegion";
import { SimulationAlerts } from "./regions/simulation/SimulationAlerts";
import { SimulationDock } from "./regions/simulation/SimulationDock";
import { SimulationTransportRegion } from "./regions/simulation/SimulationTransportRegion";
import { FeedbackDialogRegion } from "./regions/workspace/FeedbackDialogRegion";
import { FilePreviewRegion } from "./regions/workspace/FilePreviewRegion";
import { FolderPrompt } from "./regions/workspace/FolderPrompt";
import { ProjectInfoRegion } from "./regions/workspace/ProjectInfoRegion";
import { SourceNotices } from "./regions/workspace/SourceNotices";
import { UploadInput } from "./regions/workspace/UploadInput";
import { Welcome } from "./regions/workspace/Welcome";
import { useEditor, useFiles, useView } from "./workbench/hooks";
import {
  useOwnWorkbench,
  useWorkbench,
  WorkbenchProvider,
} from "./workbench/provider";

export function App() {
  const workbench = useOwnWorkbench();
  useEffect(() => workbench.start(), [workbench]);
  return (
    <WorkbenchProvider value={workbench}>
      <Shell />
    </WorkbenchProvider>
  );
}

/** The workbench frame and its regions, in document order. The placement
 * preview and the update check live here because several regions use them;
 * their effects run after every region's effects and before `start`. */
function Shell() {
  const { stores } = useWorkbench();
  const { doc, circuit } = useView();
  const folder = useFiles((state) => state.folder);
  const place = useEditor((state) => state.place);
  const placement = usePlacement(doc, circuit, place);
  useLayoutEffect(() => {
    stores.editor.getState().placement.current = placement;
  });
  const { setNotice, onError } = stores.notices.getState();
  const feedback = useFeedback(setNotice, onError);
  const layout = useWorkspaceLayout();
  return (
    <div
      className="app"
      data-workspace={doc ? "circuit" : folder ? "folder" : "empty"}
    >
      <FolderPrompt />
      <UploadInput />
      <Titlebar feedback={feedback} />
      <UpdateNotice feedback={feedback} />
      <div className="workspace" ref={layout.workspace}>
        {layout.narrow && (layout.showExplorer || layout.showRight) && (
          <button
            className="workspace-shade"
            aria-label="关闭侧栏"
            onClick={layout.closeDrawers}
          />
        )}
        <Rail placement={placement} />
        <main className="editor">
          {doc && circuit ? (
            <>
              <SourceNotices />
              <Breadcrumbs placement={placement} />
              <div className="canvas-surface">
                <EditorToolbarRegion />
                <SimulationTransportRegion />
                <CanvasRegion placement={placement} />
              </div>
              <SimulationAlerts />
              <SimulationDock />
              <MemoryRegion />
            </>
          ) : (
            <Welcome />
          )}
        </main>
        <Aside />
      </div>
      <Notice />
      <CaptureNotice />
      <ErrorBar />
      <FeedbackDialogRegion feedback={feedback} />
      <DecisionRegion />
      <ObservationsRegion />
      <InterfaceEditorRegion />
      <CircuitPrompts />
      <FilePreviewRegion />
      <SourceDialog />
      <FindRegion />
      <ProjectInfoRegion />
      <ShortcutSettingsRegion />
    </div>
  );
}
