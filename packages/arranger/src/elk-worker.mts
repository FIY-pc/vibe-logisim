// ELK runs its layered core in an in-process "worker": a dispatcher that takes
// `{cmd, id, …}` messages and answers them on the worker's `postMessage`. Its
// npm entry has no usable exports under a bundler, so the core is imported for
// its side effect: where `self` exists without `document` it installs its reply
// path on `self.onmessage`. Outside a browser the worker scope has to be named
// explicitly, before the core's module body runs. This adapts that dispatcher
// into the worker interface the ELK API takes as its `workerFactory`.
// Evaluation order matters: the scope name has to exist before the core's
// module body checks for it.
import "./worker-scope.mts";
import "elkjs/lib/elk-worker.min.js";
import elkjs from "elkjs/lib/elk-api.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";

interface Reply {
  id?: number;
  data?: unknown;
  error?: unknown;
}
interface WorkerScope {
  onmessage?: (message: { data: unknown }) => unknown;
  postMessage?: (reply: Reply) => void;
}
export interface ElkWorker {
  onmessage: ((event: { data: Reply }) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

const install = (): ElkWorker => {
  const scope = globalThis as unknown as WorkerScope;
  const dispatch = scope.onmessage;
  if (typeof dispatch !== "function")
    throw new Error(
      "布局运行时未能加载：ELK 需要在一个 worker 作用域里初始化。",
    );
  return {
    onmessage: null,
    postMessage(message) {
      const reply = scope.postMessage;
      const answer = (value: Reply) => this.onmessage?.({ data: value });
      scope.postMessage = answer;
      try {
        dispatch({ data: message });
      } finally {
        scope.postMessage = reply;
      }
    },
    terminate() {},
  };
};

let shared: ElkWorker | null = null;

/** The `workerFactory` the ELK API takes: one dispatcher, reused per instance. */
export const elkWorkerFactory = (): ElkWorker => (shared ??= install());

// The API file is CommonJS: under NodeNext its class is the module's
// `default`, while a browser bundler hands the class itself. The worker is
// passed explicitly because the library's own choice resolves to undefined
// under a bundler.
interface ElkConstructor {
  new (options: { workerFactory: () => unknown }): {
    layout(graph: unknown): Promise<ElkNode>;
  };
}
const ELK = ((elkjs as unknown as { default?: ElkConstructor }).default ??
  elkjs) as unknown as ElkConstructor;

/** The one API instance. The dispatcher answers whichever instance set its
 * `onmessage` last, so a second instance would swallow the first's replies. */
export const elk = new ELK({ workerFactory: elkWorkerFactory });
