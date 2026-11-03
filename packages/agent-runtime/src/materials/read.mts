import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import path from "node:path";

export interface MaterialRequest {
  path: string;
  page?: number;
  query?: string;
  startPage?: number;
  render?: boolean;
  offset?: number;
}
export interface MaterialPage {
  path: string;
  revision: string;
  pages: number;
  page?: number;
  text?: string;
  nextOffset?: number;
  nextPage?: number;
  image?: string;
  outline?: unknown[];
  matches?: { page: number; excerpt: string }[];
  scanned?: boolean;
}

/** Reading never depends on the UI. A cancelled read terminates its worker. */
export function readMaterial(
  file: string,
  request: MaterialRequest,
  signal?: AbortSignal,
): Promise<MaterialPage> {
  signal?.throwIfAborted();
  const bundled = path.join(import.meta.dirname, "material-worker.mjs");
  const worker = new Worker(
    existsSync(bundled) ? bundled : new URL("./worker.mts", import.meta.url),
    { workerData: { file, request } },
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: MaterialPage) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(new Error("资料读取已停止"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.once("message", (result) =>
      finish(result.error ? new Error(result.error) : undefined, result.value),
    );
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`资料读取进程退出 (${code})`));
    });
  });
}
