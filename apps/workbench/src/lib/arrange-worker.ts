/// <reference lib="webworker" />
// Arranging is synchronous and CPU-bound; it runs in its own thread so the
// canvas keeps responding while a large definition is laid out.
import { arrange, readability } from "@vibe-logisim/arranger";
interface Request {
  xml: string;
  circuit: string;
  focus: unknown;
}
self.onmessage = (event: MessageEvent<Request>) => {
  const { xml, circuit, focus } = event.data;
  // The native observation nests the parts under `focus` beside its coverage.
  const parts = (focus as { focus?: unknown }).focus ?? focus;
  arrange({ xml: xml, circuit, focus: parts as never })
    .then((arrangement) =>
      self.postMessage({
        ok: true,
        xml: arrangement.xml,
        before: readability(xml, circuit),
        after: readability(arrangement.xml, circuit),
      }),
    )
    .catch((error: unknown) =>
      self.postMessage({
        ok: false,
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "ARRANGE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
};
