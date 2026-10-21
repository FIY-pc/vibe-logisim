import type { Readability } from "@vibe-logisim/arranger";
// Vite resolves this URL to a module worker, in development and in the build.
import workerUrl from "./arrange-worker.ts?worker&url";
export interface Arranged {
  xml: string;
  before: Readability;
  after: Readability;
}
/** Rearranges one definition off the interface thread; the canvas stays live. */
export function arrangeCircuit(
  request: { xml: string; circuit: string; focus: unknown },
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
    worker.onmessage = (event: MessageEvent) =>
      finish(() => {
        const result = event.data;
        if (!result.ok) return reject(new Error(result.message));
        resolve({
          xml: result.xml,
          before: result.before,
          after: result.after,
        });
      });
    worker.postMessage(request);
  });
}
