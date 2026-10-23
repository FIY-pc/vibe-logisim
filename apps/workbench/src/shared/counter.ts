/** A request counter. A continuation compares the number it took with `current`
 * to learn whether a newer request has started. Not reactive. */
export interface Counter {
  readonly current: number;
  next(): number;
}

export function createCounter(): Counter {
  let value = 0;
  return {
    get current() {
      return value;
    },
    next: () => ++value,
  };
}
