import type { Component, NetBit } from "./types.mts";

export type Point = readonly [number, number];

// An attribute as observed: the value written in the file, else the default.
export function attr(component: Component, name: string): string | null {
  for (const a of component.attributes)
    if (a.name === name)
      return ((Object.prototype.hasOwnProperty.call(a, "value")
        ? a.value
        : a.standard) ?? null) as string | null;
  return null;
}

// Identity of a port's net: the ordered (bit, thread) vector. Two ports are
// the same net only if bit i is the same thread for every i; the same threads
// in another order (a splitter recombining fields) are another net.
export function netKey(bits: readonly NetBit[]): string {
  return JSON.stringify(
    [...bits].sort((a, b) => a.bit - b.bit).map((b) => [b.bit, b.netId]),
  );
}
