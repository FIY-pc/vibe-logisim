// Ordering and arithmetic helpers with the semantics the layout engine was
// designed with: banker's rounding, floor division, code-point string order,
// lexicographic tuple order, first-wins min/max and stable sorts on tuple
// keys. Placement and routing decisions break ties through these, so a
// different tie rule gives a different drawing.

export type Point = readonly [number, number];

export function pyRound(value: number): number {
  const fraction = value % 1;
  const rounded =
    Math.abs(fraction) === 0.5 ? 2 * Math.round(value / 2) : Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

export function floorDiv(a: number, b: number): number {
  const q = Math.floor(a / b);
  return q === 0 ? 0 : q;
}

export function pyMod(a: number, b: number): number {
  const r = a % b;
  if (r === 0) return 0;
  return r < 0 !== b < 0 ? r + b : r;
}

export function ceilDiv(a: number, b: number): number {
  const q = Math.ceil(a / b);
  return q === 0 ? 0 : q;
}

function isSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdfff;
}

// Compares by code point, not by UTF-16 unit: an astral character sorts after
// every BMP character, as in a Python str comparison.
export function strCmp(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      const xs = isSurrogate(x);
      const ys = isSurrogate(y);
      if (xs !== ys) return xs ? 1 : -1;
      return x < y ? -1 : 1;
    }
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

// Python ordering of numbers, booleans, strings and (nested) tuples.
export function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" || typeof a === "boolean") {
    const x = Number(a);
    const y = Number(b as number);
    if (typeof b !== "number" && typeof b !== "boolean")
      throw new TypeError(`cannot order ${typeof a} and ${typeof b}`);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "string") {
    if (typeof b !== "string")
      throw new TypeError(`cannot order string and ${typeof b}`);
    return strCmp(a, b);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b))
      throw new TypeError(`cannot order tuple and ${typeof b}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (pyEq(a[i], b[i])) continue;
      return cmp(a[i], b[i]);
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  throw new TypeError(`cannot order ${a === null ? "None" : typeof a}`);
}

// Python == on JSON-like values: numbers and booleans by value, arrays
// element-wise, plain objects key-wise regardless of key order.
export function pyEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (
      (typeof a === "number" || typeof a === "boolean") &&
      (typeof b === "number" || typeof b === "boolean")
    )
      return Number(a) === Number(b);
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!pyEq(a[i], b[i])) return false;
    return true;
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object"
  ) {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (
        !pyEq(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        )
      )
        return false;
    }
    return true;
  }
  return false;
}

// sorted(items, key=key, reverse=reverse): stable in both directions.
export function sortBy<T>(
  items: Iterable<T>,
  key: (item: T) => unknown,
  reverse = false,
): T[] {
  const decorated = Array.from(items, (item, index) => ({
    item,
    key: key(item),
    index,
  }));
  decorated.sort((x, y) => {
    const c = cmp(x.key, y.key);
    if (c !== 0) return reverse ? -c : c;
    return x.index - y.index;
  });
  return decorated.map((d) => d.item);
}

export function sorted<T>(items: Iterable<T>, reverse = false): T[] {
  return sortBy(items, (x) => x, reverse);
}

// min(items, key=key): the first of the smallest.
export function minBy<T>(items: Iterable<T>, key: (item: T) => unknown): T {
  let best: T | undefined;
  let bestKey: unknown;
  let any = false;
  for (const item of items) {
    const k = key(item);
    if (!any || cmp(k, bestKey) < 0) {
      best = item;
      bestKey = k;
      any = true;
    }
  }
  if (!any) throw new PyValueError("min() iterable argument is empty");
  return best as T;
}

// max(items, key=key): the first of the largest.
export function maxBy<T>(items: Iterable<T>, key: (item: T) => unknown): T {
  let best: T | undefined;
  let bestKey: unknown;
  let any = false;
  for (const item of items) {
    const k = key(item);
    if (!any || cmp(k, bestKey) > 0) {
      best = item;
      bestKey = k;
      any = true;
    }
  }
  if (!any) throw new PyValueError("max() iterable argument is empty");
  return best as T;
}

export function minOf(items: Iterable<number>, fallback?: number): number {
  let best = Infinity;
  let any = false;
  for (const v of items) {
    if (!any || v < best) best = v;
    any = true;
  }
  if (!any) {
    if (fallback === undefined)
      throw new PyValueError("min() iterable argument is empty");
    return fallback;
  }
  return best;
}

export function maxOf(items: Iterable<number>, fallback?: number): number {
  let best = -Infinity;
  let any = false;
  for (const v of items) {
    if (!any || v > best) best = v;
    any = true;
  }
  if (!any) {
    if (fallback === undefined)
      throw new PyValueError("max() iterable argument is empty");
    return fallback;
  }
  return best;
}

export function sum(items: Iterable<number>): number {
  let total = 0;
  for (const v of items) total += v;
  return total;
}

export function count<T>(
  items: Iterable<T>,
  test: (item: T) => unknown,
): number {
  let n = 0;
  for (const item of items) if (test(item)) n++;
  return n;
}

// range(start, stop, step) including negative steps.
export function* range(
  start: number,
  stop?: number,
  step = 1,
): Generator<number> {
  if (stop === undefined) {
    stop = start;
    start = 0;
  }
  if (step > 0) for (let i = start; i < stop; i += step) yield i;
  else for (let i = start; i > stop; i += step) yield i;
}

// The base of every ValueError raised by the engine; CircuitToolError is one too.
export class PyValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class PyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

// next(iterator) on an exhausted iterator without a default.
export class StopIteration extends Error {
  constructor() {
    super();
    this.name = "StopIteration";
  }
}

// mapping[key]: a missing key raises KeyError(repr(key)).
export function item<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined && !map.has(key)) throw new PyKeyError(pyRepr(key));
  return value as V;
}

// int(text) for base-10 literals: surrounding whitespace, a sign, digits and
// single underscores between digits.
export function pyInt(text: string): number {
  const body = strip(text);
  if (!/^[+-]?[0-9]+(?:_[0-9]+)*$/.test(body))
    throw new PyValueError(
      `invalid literal for int() with base 10: ${pyRepr(text)}`,
    );
  const value = Number(body.replaceAll("_", ""));
  return value === 0 ? 0 : value;
}

// bool(value) of a JSON value.
export function truthy(value: unknown): boolean {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === ""
  )
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// int(value) of a JSON value.
export function toInt(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") {
    if (Number.isNaN(value))
      throw new PyValueError("cannot convert float NaN to integer");
    if (!Number.isFinite(value))
      throw new RangeError("cannot convert float infinity to integer");
    return Math.trunc(value) + 0;
  }
  if (typeof value === "string") return pyInt(value);
  const type =
    value === null
      ? "NoneType"
      : Array.isArray(value)
        ? "list"
        : typeof value === "object"
          ? "dict"
          : typeof value;
  throw new TypeError(
    `int() argument must be a string, a bytes-like object or a real number, not '${type}'`,
  );
}

export const PY_WHITESPACE =
  " \t\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

export function isSpace(ch: string): boolean {
  return PY_WHITESPACE.includes(ch);
}

// str.strip() / str.strip(chars)
export function strip(text: string, chars?: string): string {
  const set = chars ?? PY_WHITESPACE;
  let start = 0;
  let end = text.length;
  while (start < end && set.includes(text[start])) start++;
  while (end > start && set.includes(text[end - 1])) end--;
  return text.slice(start, end);
}

export function codePoints(text: string): string[] {
  return Array.from(text);
}

// text[start:end] on code points.
export function cpSlice(text: string, start: number, end?: number): string {
  const points = Array.from(text);
  return points.slice(start, end).join("");
}

function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0))
      out += "\\x" + code.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

// repr() of the values the engine formats: str, int, bool, None and tuples.
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return pyNumber(value);
  if (typeof value === "string") return reprString(value);
  if (Array.isArray(value)) {
    if (value.length === 1) return `(${pyRepr(value[0])},)`;
    return `(${value.map(pyRepr).join(", ")})`;
  }
  throw new TypeError("no repr for " + typeof value);
}

// str(): a string as it is, anything else as its repr.
export function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

export function pyNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (Number.isNaN(value)) return "nan";
  return String(value);
}

// A stable string identity for tuple-like keys used in Map/Set lookups.
export function keyOf(value: unknown): string {
  return JSON.stringify(value);
}

// collections.defaultdict for Map: get-or-create.
export function getOr<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

// A set of ints that iterates in the order CPython's set does: open
// addressing with linear probes and perturbation, the same growth rule and
// the same table sizes. Code that iterates a set of ints and keeps the first
// of equal candidates depends on that order.
export class IntSet {
  private table: (number | undefined)[] = new Array(8).fill(undefined);
  private mask = 7;
  private fill = 0;
  private used = 0;

  private static hash(v: number): number {
    return v === -1 ? -2 : v;
  }

  private probe(
    table: (number | undefined)[],
    mask: number,
    v: number,
    h: number,
  ): number {
    let i = h & mask;
    let perturb = BigInt.asUintN(64, BigInt(h));
    for (;;) {
      const probes = i + 9 <= mask ? 9 : 0;
      for (let j = i; j <= i + probes; j++) {
        const entry = table[j];
        if (entry === undefined || entry === v) return j;
      }
      perturb >>= 5n;
      i = (i * 5 + 1 + Number(perturb & BigInt(mask))) & mask;
    }
  }

  get size(): number {
    return this.used;
  }

  has(v: number): boolean {
    return (
      this.table[this.probe(this.table, this.mask, v, IntSet.hash(v))] === v
    );
  }

  add(v: number): void {
    const h = IntSet.hash(v);
    const slot = this.probe(this.table, this.mask, v, h);
    if (this.table[slot] === v) return;
    this.table[slot] = v;
    this.fill++;
    this.used++;
    if (this.fill * 5 >= this.mask * 3)
      this.resize(this.used > 50000 ? this.used * 2 : this.used * 4);
  }

  private resize(minused: number): void {
    let size = 8;
    while (size <= minused) size <<= 1;
    const old = this.table;
    this.table = new Array(size).fill(undefined);
    this.mask = size - 1;
    for (const v of old)
      if (v !== undefined)
        this.table[this.probe(this.table, this.mask, v, IntSet.hash(v))] = v;
  }

  *[Symbol.iterator](): Generator<number> {
    for (const v of this.table) if (v !== undefined) yield v;
  }
}

// copy.deepcopy of plain data, Maps, Sets, arrays and class instances (their
// prototype kept); functions are shared and shared references stay shared.
export function deepCopy<T>(value: T, memo = new Map<unknown, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const known = memo.get(value);
  if (known !== undefined) return known as T;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    memo.set(value, out);
    for (const v of value) out.push(deepCopy(v, memo));
    return out as T;
  }
  if (value instanceof Map) {
    const out = new Map();
    memo.set(value, out);
    for (const [k, v] of value) out.set(deepCopy(k, memo), deepCopy(v, memo));
    return out as T;
  }
  if (value instanceof Set) {
    const out = new Set();
    memo.set(value, out);
    for (const v of value) out.add(deepCopy(v, memo));
    return out as T;
  }
  const out = Object.create(Object.getPrototypeOf(value)) as Record<
    string,
    unknown
  >;
  memo.set(value, out);
  for (const k of Object.keys(value))
    out[k] = deepCopy((value as Record<string, unknown>)[k], memo);
  return out as T;
}

// A dict or set keyed by tuples: equal tuples are one key, insertion order
// is kept, and setting a known key keeps both its place and its first tuple.
export class KeyMap<K, V> implements Iterable<[K, V]> {
  private readonly map = new Map<string, [K, V]>();
  private readonly id: (key: K) => string;

  constructor(
    id: (key: K) => string = JSON.stringify,
    entries?: Iterable<readonly [K, V]>,
  ) {
    this.id = id;
    if (entries) for (const [k, v] of entries) this.set(k, v);
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(this.id(key));
  }

  get(key: K): V | undefined {
    return this.map.get(this.id(key))?.[1];
  }

  set(key: K, value: V): this {
    const id = this.id(key);
    const known = this.map.get(id);
    if (known) known[1] = value;
    else this.map.set(id, [key, value]);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(this.id(key));
  }

  clear(): void {
    this.map.clear();
  }

  *keys(): Generator<K> {
    for (const [k] of this.map.values()) yield k;
  }

  *values(): Generator<V> {
    for (const [, v] of this.map.values()) yield v;
  }

  *entries(): Generator<[K, V]> {
    for (const [k, v] of this.map.values()) yield [k, v];
  }

  [Symbol.iterator](): Generator<[K, V]> {
    return this.entries();
  }
}

export class KeySet<K> implements Iterable<K> {
  private readonly map = new Map<string, K>();
  private readonly id: (key: K) => string;

  constructor(id: (key: K) => string = JSON.stringify, items?: Iterable<K>) {
    this.id = id;
    if (items) for (const k of items) this.add(k);
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(this.id(key));
  }

  add(key: K): this {
    const id = this.id(key);
    if (!this.map.has(id)) this.map.set(id, key);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(this.id(key));
  }

  *[Symbol.iterator](): Generator<K> {
    yield* this.map.values();
  }
}

// list.sort(key=key, reverse=reverse): the same list, stably sorted.
export function sortInPlace<T>(
  items: T[],
  key: (item: T) => unknown,
  reverse = false,
): T[] {
  const ordered = sortBy(items, key, reverse);
  for (let i = 0; i < ordered.length; i++) items[i] = ordered[i];
  return items;
}
