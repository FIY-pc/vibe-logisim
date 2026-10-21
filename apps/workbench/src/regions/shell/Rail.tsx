import {
  useWorkspaceLayout,
  WorkspaceRail,
} from "../../components/WorkspaceLayout";
import type { PlacementState } from "../../lib/usePlacement";
import { useFiles, useShell, useView } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";
import { CircuitSearch } from "../editor/CircuitSearch";
import { InspectorActions, InspectorRegion } from "../editor/InspectorRegion";
import { PaletteRegion } from "../editor/PaletteRegion";
import { DocumentList } from "../workspace/DocumentList";
import { FilesRegion } from "../workspace/FilesRegion";
import { NavigatorActions } from "../workspace/NavigatorActions";

/** The project rail: files and components, the open documents and circuits,
 * and the inspector. */
export function Rail({ placement }: { placement: PlacementState }) {
  const { stores } = useWorkbench();
  const layout = useWorkspaceLayout();
  const { doc } = useView();
  const folder = useFiles((state) => state.folder);
  const resourceTab = useShell((state) => state.resourceTab);
  return (
    <WorkspaceRail
      layout={layout}
      hasCircuit={Boolean(doc)}
      title={folder?.name || "文件"}
      resourceTab={resourceTab}
      onResourceTab={stores.shell.getState().setResourceTab}
      files={<FilesRegion />}
      palette={<PaletteRegion />}
      navigation={
        <>
          <CircuitSearch /> <DocumentList />
        </>
      }
      navigatorActions={<NavigatorActions />}
      inspectorActions={<InspectorActions />}
      inspector={<InspectorRegion placement={placement} />}
    />
  );
}
