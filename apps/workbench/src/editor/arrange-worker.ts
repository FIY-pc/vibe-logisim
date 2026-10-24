/// <reference lib="webworker" />
// Arranging and verifying are synchronous and CPU-bound; they run in their own
// thread so the canvas keeps responding while a large definition is laid out.
// One worker serves one request: it arranges, asks the page for the native
// observation of the result (host `observeXml`), then proves the netlist
// unchanged and compares readability before anything is applied.
import {
  arrange,
  compareReadability,
  READABILITY_NAMES,
  verifyArrangement,
  type Arrangement,
  type Focus,
} from "@vibe-logisim/arranger";
type Request =
  | { kind: "arrange"; xml: string; circuit: string; focus: unknown }
  | { kind: "observed"; focus: unknown };
// The native observation nests the parts under `focus` beside its coverage.
const partsOf = (focus: unknown) =>
  ((focus as { focus?: unknown }).focus ?? focus) as Focus;
const fail = (error: unknown) =>
  self.postMessage({
    kind: "failed",
    code:
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "ARRANGE_FAILED",
    message: error instanceof Error ? error.message : String(error),
  });
let arranged: Arrangement | null = null;
self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.kind === "arrange") {
    const { xml, circuit, focus } = request;
    arrange({ xml, circuit, focus: partsOf(focus) })
      .then((arrangement) => {
        arranged = arrangement;
        self.postMessage({ kind: "arranged", xml: arrangement.xml });
      })
      .catch(fail);
    return;
  }
  try {
    if (!arranged) throw new Error("布局运行时未完成：没有待核对的整理结果。");
    const checks = verifyArrangement(arranged, partsOf(request.focus));
    self.postMessage({
      kind: "verified",
      xml: arranged.xml,
      before: checks.readabilityBefore,
      after: checks.readabilityAfter,
      comparison: compareReadability(
        checks.readabilityBefore,
        checks.readabilityAfter,
      ),
      names: READABILITY_NAMES,
    });
  } catch (error) {
    fail(error);
  }
};
