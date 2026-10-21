// ELK's core decides where to install itself by checking for a browser worker
// scope. Node's worker threads expose the same hooks on `parentPort` and have
// no `self`, so the name is defined before any solver module is evaluated.
const scope = globalThis as unknown as { self?: unknown };
scope.self ??= scope;
export {};
