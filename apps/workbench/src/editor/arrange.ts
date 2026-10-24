import type {
  Readability,
  ReadabilityComparison,
} from "@vibe-logisim/arranger";
// Vite resolves this URL to a module worker, in development and in the build.
import workerUrl from "./arrange-worker.ts?worker&url";
export interface Arranged {
  xml: string;
  before: Readability;
  after: Readability;
  // `clearer` decides whether the result is applied at all.
  comparison: ReadabilityComparison;
  // What each measure is called, for the notice.
  names: Record<ReadabilityComparison["worse"][number], string>;
}
/**
 * Rearranges one definition off the interface thread; the canvas stays live.
 * `observe` loads the arranged file natively without applying it (host
 * `observeXml`); the worker then verifies the netlist and scores both drawings.
 */
export function arrangeCircuit(
  request: { xml: string; circuit: string; focus: unknown },
  observe: (xml: string) => Promise<unknown>,
  timeout = 60_000,
): Promise<Arranged> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      action();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              "布局运行时未完成：这个电路超出了单次整理的时间上限，可以只整理选中的元件，或拆成子电路后再试。",
            ),
          ),
        ),
      timeout,
    );
    worker.onerror = (event) =>
      finish(() => reject(new Error(event.message || "布局运行时未完成")));
    worker.onmessage = (event: MessageEvent) => {
      const result = event.data;
      if (result.kind === "arranged") {
        observe(result.xml).then(
          (focus) => {
            if (!settled) worker.postMessage({ kind: "observed", focus });
          },
          (error: unknown) => finish(() => reject(error)),
        );
        return;
      }
      finish(() => {
        if (result.kind !== "verified")
          return reject(
            Object.assign(new Error(result.message), { code: result.code }),
          );
        resolve({
          xml: result.xml,
          before: result.before,
          after: result.after,
          comparison: result.comparison,
          names: result.names,
        });
      });
    };
    worker.postMessage({ kind: "arrange", ...request });
  });
}
