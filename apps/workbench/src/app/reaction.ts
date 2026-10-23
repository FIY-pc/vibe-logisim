import type { StoreApi } from "zustand/vanilla";

/**
 * Runs `run` now and again whenever `select` returns different values, the
 * way an effect follows its dependencies. Changes made together in one task
 * are seen together, because the comparison runs in a microtask. `run` may
 * return a cleanup, which runs before the next run and on stop.
 * Returns the stop.
 */
export function reaction<T extends readonly unknown[]>(
  stores: readonly StoreApi<any>[],
  select: () => T,
  run: (values: T) => (() => void) | void,
): () => void {
  let values = select();
  let cleanup = run(values);
  let scheduled = false;
  let stopped = false;
  const check = () => {
    scheduled = false;
    if (stopped) return;
    const next = select();
    if (
      next.length === values.length &&
      next.every((value, index) => Object.is(value, values[index]))
    )
      return;
    values = next;
    if (cleanup) cleanup();
    cleanup = run(next);
  };
  const unsubscribes = stores.map((store) =>
    store.subscribe(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(check);
    }),
  );
  return () => {
    stopped = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
    if (cleanup) cleanup();
  };
}
