import { useFiles } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The hidden file input that opens a circuit file outside the desktop app. */
export function UploadInput() {
  const { actions } = useWorkbench();
  const upload = useFiles((state) => state.uploadInput);
  return (
    <input
      hidden
      ref={upload}
      type="file"
      accept=".circ"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) actions.workspace.importFile(file);
        e.target.value = "";
      }}
    />
  );
}
