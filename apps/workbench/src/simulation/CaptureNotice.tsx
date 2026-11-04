import { Button, IconButton } from "../design/ui";
import { X } from "lucide-react";
import { useNotices, useSimulation } from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** Offers the last captured observation, unless another notice is shown. */
export function CaptureNotice() {
  const { stores } = useWorkbench();
  const lastCapture = useSimulation((state) => state.lastCapture);
  const notice = useNotices((state) => state.notice);
  if (!lastCapture || notice) return null;
  const { setObservations, setLastCapture } = stores.simulation.getState();
  return (
    <div className="capture-notice" role="status">
      <Button
        variant="ghost"
        color="gray"
        onClick={() =>
          setObservations({
            documentId: lastCapture.documentId,
            initial: lastCapture.id,
          })
        }
      >
        已留存 · {lastCapture.title}
      </Button>
      <IconButton
        aria-label="关闭留存提示"
        onClick={() => setLastCapture(null)}
      >
        <X size={13} />
      </IconButton>
    </div>
  );
}
