import type { StoreApi } from "zustand/vanilla";

/** A next value, or a function of the previous one, as React state setters accept. */
export type Update<T> = T | ((previous: T) => T);

/** A React-style setter for one field of a store. */
export function field<S, K extends keyof S>(
  set: StoreApi<S>["setState"],
  key: K,
): (update: Update<S[K]>) => void {
  return (update) =>
    set(
      (state) =>
        ({
          [key]:
            typeof update === "function"
              ? (update as (previous: S[K]) => S[K])(state[key])
              : update,
        }) as unknown as Partial<S>,
    );
}
