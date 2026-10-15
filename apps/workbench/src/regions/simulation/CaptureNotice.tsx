import { X } from "lucide-react";
import { useNotices, useSimulation } from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** Offers the last captured observation, unless another notice is shown. */
export function CaptureNotice() {
  const { stores } = useWorkbench();
  const lastCapture = useSimulation((state) => state.lastCapture);
  const notice = useNotices((state) => state.notice);
  if (!lastCapture || notice) return null;
  const { setObservations, setLastCapture } = stores.simulation.getState();
  return (
    <div className="capture-notice" role="status">
      <button
        onClick={() =>
          setObservations({
            documentId: lastCapture.documentId,
            initial: lastCapture.id,
          })
        }
      >
        已留存 · {lastCapture.title}
      </button>
      <button aria-label="关闭留存提示" onClick={() => setLastCapture(null)}>
        <X size={13} />
      </button>
    </div>
  );
}
