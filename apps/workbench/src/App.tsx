import { useEffect, useLayoutEffect } from "react";
import { UpdateNotice, useFeedback } from "./shell/Feedback";
import { useWorkspaceLayout } from "./shell/WorkspaceLayout";
import { usePlacement } from "./editor/usePlacement";
import { Breadcrumbs } from "./editor/Breadcrumbs";
import { CanvasRegion } from "./editor/CanvasRegion";
import { CircuitPrompts } from "./editor/CircuitPrompts";
import { EditorToolbarRegion } from "./editor/EditorToolbarRegion";
import { FindRegion } from "./editor/FindRegion";
import { InterfaceEditorRegion } from "./editor/InterfaceEditorRegion";
import { SourceDialog } from "./editor/SourceDialog";
import { Aside } from "./shell/Aside";
import { DecisionRegion } from "./shell/DecisionRegion";
import { ErrorBar, Notice } from "./shell/Notices";
import { Rail } from "./shell/Rail";
import { ShortcutSettingsRegion } from "./shell/ShortcutSettingsRegion";
import { Titlebar } from "./shell/Titlebar";
import { CaptureNotice } from "./simulation/CaptureNotice";
import { MemoryRegion } from "./simulation/MemoryRegion";
import { ObservationsRegion } from "./simulation/ObservationsRegion";
import { SimulationAlerts } from "./simulation/SimulationAlerts";
import { SimulationDock } from "./simulation/SimulationDock";
import { SimulationTransportRegion } from "./simulation/SimulationTransportRegion";
import { FeedbackDialogRegion } from "./shell/FeedbackDialogRegion";
import { FilePreviewRegion } from "./workspace/FilePreviewRegion";
import { FolderPrompt } from "./workspace/FolderPrompt";
import { NewFilePrompt } from "./workspace/NewFilePrompt";
import { ProjectInfoRegion } from "./workspace/ProjectInfoRegion";
import { SourceNotices } from "./workspace/SourceNotices";
import { UploadInput } from "./workspace/UploadInput";
import { Welcome } from "./workspace/Welcome";
import { Tooltips } from "./shared/Tooltips";
import { useEditor, useFiles, useView } from "./app/hooks";
import {
  useOwnWorkbench,
  useWorkbench,
  WorkbenchProvider,
} from "./app/provider";

export function App() {
  const workbench = useOwnWorkbench();
  useEffect(() => workbench.start(), [workbench]);
  useEffect(withoutPageMenu, []);
  return (
    <WorkbenchProvider value={workbench}>
      <Shell />
      <Tooltips />
    </WorkbenchProvider>
  );
}

/** Right-clicking where the app has no menu of its own shows nothing, as in
 * other desktop apps, rather than the web view's back/reload/inspect menu.
 * Text fields and selected text keep the platform's copy and paste menu. */
function withoutPageMenu() {
  const suppress = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "input, textarea, [contenteditable]:not([contenteditable='false'])",
      )
    )
      return;
    if (!window.getSelection()?.isCollapsed) return;
    event.preventDefault();
  };
  window.addEventListener("contextmenu", suppress);
  return () => window.removeEventListener("contextmenu", suppress);
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
      <NewFilePrompt />
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
