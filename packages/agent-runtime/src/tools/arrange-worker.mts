// Arranging runs in its own thread: the solver is synchronous and CPU-bound,
// and a definition that takes too long must not freeze model transport.
import { parentPort } from "node:worker_threads";
import { arrange } from "@vibe-logisim/arranger";
import type { Focus } from "@vibe-logisim/arranger";
parentPort?.on("message", (request: any) => {
  // The native observation nests the parts under `focus` beside its coverage.
  const parts: Focus = request.focus?.focus ?? request.focus;
  arrange({ ...request, focus: parts })
    .then((arrangement) =>
      parentPort!.postMessage({
        ok: true,
        xml: arrangement.xml,
        report: arrangement.report,
        placement: [...arrangement.placement],
        keptWires: arrangement.keptWires,
        panelBelowY: arrangement.panelBelowY,
        fixedComponentIds: [...arrangement.fixedComponentIds],
      }),
    )
    .catch((error: unknown) =>
      parentPort!.postMessage({
        ok: false,
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "ARRANGE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
});
