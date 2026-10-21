// One arrangement request, run off the transport thread with a deadline.
import { Worker } from "node:worker_threads";
export interface ArrangeOutcome {
  xml: string;
  report: Record<string, unknown>;
  placement: [string, [number, number]][];
  keptWires: unknown[];
  panelBelowY: number | null;
  fixedComponentIds: string[];
  readabilityBefore: Record<string, unknown>;
  readabilityAfter: Record<string, unknown>;
}
export function arrangeInWorker(
  request: Record<string, unknown>,
  timeout: number,
): Promise<ArrangeOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./arrange-worker.mjs", import.meta.url));
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              "布局运行时未完成：这个电路超出了单次整理的时间上限，可以只整理选中的元件，或把电路拆成子电路后再试。",
            ),
          ),
        ),
      timeout,
    );
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
    worker.postMessage(request);
  });
}
