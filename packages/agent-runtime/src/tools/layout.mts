// One arrangement request, run off the transport thread until done or cancelled.
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
export interface ArrangeOutcome {
  xml: string;
  report: Record<string, unknown>;
  placement: [string, [number, number]][];
  keptWires: unknown[];
  panelBelowY: number | null;
  fixedComponentIds: string[];
}
export function arrangeInWorker(
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ArrangeOutcome> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    // The bundle ships arrange-worker.mjs beside worker.mjs; development runs
    // the TypeScript source directly (Node 24 loads .mts natively).
    const bundled = new URL("./arrange-worker.mjs", import.meta.url);
    const worker = new Worker(
      existsSync(bundled)
        ? bundled
        : new URL("./arrange-worker.mts", import.meta.url),
    );
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      void worker.terminate().then(action, reject);
    };
    const abort = () => finish(() => reject(signal!.reason));
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) =>
      finish(() =>
        reject(new Error(`布局运行时未完成：整理线程以状态 ${code} 结束。`)),
      ),
    );
    worker.once("message", (result: any) =>
      finish(() => {
        if (result.ok) return resolve(result as ArrangeOutcome);
        reject(Object.assign(new Error(result.message), { code: result.code }));
      }),
    );
    try {
      if (signal?.aborted) abort();
      else worker.postMessage(request);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
