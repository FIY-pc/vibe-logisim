/**
 * The pictures of the kinds of components a document's canvas draws. The
 * host records each kind once from Logisim's own painting (`symbols`): its
 * bounds, ink, ports and drawing ops relative to the component's location.
 * A kind is its library, name and attributes; a subcircuit's picture also
 * follows its definition, so it is asked again when that circuit changed.
 * Pictures are kept per document until its palette changes; the canvas asks
 * once per revision for what it is missing, together with the wires of that
 * revision whose widths conflict (see docs/rendering.md).
 */
import { useEffect, useReducer, useRef } from "react";
import type { SymbolKey } from "../generated/SymbolKey";
import type {
  Bounds,
  Circuit,
  Component,
  Document,
  XmlNode,
} from "../shared/types";
import { HostError } from "../shared/host-error";
import { command } from "../shared/transport";

/** One recorded drawing op; `editor/paint.ts` replays it. */
export type Op = (string | number | number[])[];
export interface SymbolPort {
  index: number;
  x: number;
  y: number;
  width: number;
  direction: string;
}
export interface SymbolPicture {
  bounds: Bounds;
  ink: Bounds;
  ports: SymbolPort[];
  ops: Op[];
}
export interface SymbolEntry {
  /** Null when the runtime could not draw this kind; `error` says why. */
  picture: SymbolPicture | null;
  error: string;
  /** The circuit a subcircuit's picture was drawn from. */
  definition: Circuit | null;
}
interface Reply {
  symbols: ({ error: string } | SymbolPicture)[];
  widthErrors: [number, number][];
}

const keys = new WeakMap<object, string>();
/** The cache key of a component, or of a placement ghost's key. */
export function symbolId(item: SymbolKey | Component): string {
  let id = keys.get(item);
  if (id === undefined) {
    const attributes = Object.keys(item.attributes)
      .sort()
      .map((name) => [name, item.attributes[name]]);
    id = JSON.stringify([item.library || "", item.name, attributes]);
    keys.set(item, id);
  }
  return id;
}
export const componentKey = (component: Component): SymbolKey => ({
  library: component.library || undefined,
  name: component.name,
  attributes: component.attributes,
});
const templates = new WeakMap<XmlNode, SymbolKey | null>();
/** The kind a placement template places: the attributes of its `comp`, which
 * are the ones the placed component will have. */
export function templateKey(template: XmlNode | null): SymbolKey | null {
  if (!template) return null;
  let key = templates.get(template);
  if (key === undefined) {
    const comp = template.children.find((node) => node.tag === "comp");
    key = comp?.attributes.name
      ? {
          library: comp.attributes.lib || undefined,
          name: comp.attributes.name,
          attributes: Object.fromEntries(
            comp.children
              .filter((node) => node.tag === "a")
              .map((node) => [
                node.attributes.name,
                node.attributes.val ?? node.text ?? "",
              ]),
          ),
        }
      : null;
    templates.set(template, key);
  }
  return key;
}

class DocumentSymbols {
  readonly entries = new Map<string, SymbolEntry>();
  /** Kinds asked and not answered yet. */
  readonly pending = new Set<string>();
  /** Kinds whose last request failed as a whole, by the revision asked. */
  readonly failed = new Map<string, string>();
  /** The conflicting points ("x,y") of each circuit, from the latest request answered. */
  readonly widths = new Map<string, { request: number; points: Set<string> }>();
  /** The revision of each circuit last asked about. */
  readonly asked = new Map<string, string>();
  requests = 0;
  readonly listeners = new Set<() => void>();
  constructor(readonly palette: string) {}
  notify() {
    for (const listener of this.listeners) listener();
  }
}
const documents = new Map<string, DocumentSymbols>();
function documentSymbols(doc: Document) {
  let cache = documents.get(doc.id);
  if (!cache || cache.palette !== doc.paletteIdentity) {
    cache = new DocumentSymbols(doc.paletteIdentity);
    documents.set(doc.id, cache);
  }
  return cache;
}
/** Forgets the pictures of documents that are no longer open. */
export function keepSymbols(open: string[]) {
  for (const id of documents.keys())
    if (!open.includes(id)) documents.delete(id);
}

const definitionOf = (
  doc: Document,
  key: { library?: string | null; name: string },
) =>
  key.library ? null : (doc.circuits.find((c) => c.name === key.name) ?? null);

const none = new Set<string>();

export interface Symbols {
  /** The picture of a kind, when it is known and current. */
  get(key: SymbolKey | Component): SymbolEntry | undefined;
  /** The last picture of a kind, also when its subcircuit changed since. */
  latest(key: SymbolKey | Component): SymbolEntry | undefined;
  /** Whether every kind the circuit uses has been answered at least once. */
  ready: boolean;
  /** The points of wires whose widths conflict, as last answered. */
  widthErrors: Set<string>;
  /** Changes whenever an answer arrives. */
  version: number;
}

/**
 * The pictures for `circuit` and for `extra` kinds (placement ghosts),
 * asking the host for the missing ones in one request per revision. A
 * request the host refuses because the document moved on calls `onStale`
 * when the window still shows that revision.
 */
export function useSymbols(
  doc: Document,
  circuit: Circuit,
  extra: SymbolKey[],
  onError: (error: unknown) => void,
  onStale: () => void,
): Symbols {
  const cache = documentSymbols(doc);
  const [version, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    cache.listeners.add(refresh);
    return () => void cache.listeners.delete(refresh);
  }, [cache]);
  const shown = useRef(doc);
  shown.current = doc;
  const callbacks = useRef({ onError, onStale });
  callbacks.current = { onError, onStale };
  const get = (key: SymbolKey | Component) => {
    const entry = cache.entries.get(symbolId(key));
    if (!entry) return undefined;
    // A subcircuit's picture follows its definition.
    if (!key.library && entry.definition !== definitionOf(doc, key))
      return undefined;
    return entry;
  };
  const extraIds = extra.map(symbolId).join("\n");
  useEffect(() => {
    const wanted = new Map<string, SymbolKey>();
    const want = (item: SymbolKey | Component) => {
      const id = symbolId(item);
      if (
        !wanted.has(id) &&
        !get(item) &&
        !cache.pending.has(id) &&
        cache.failed.get(id) !== doc.revision
      )
        wanted.set(id, "id" in item ? componentKey(item) : item);
    };
    circuit.components.forEach(want);
    extra.forEach(want);
    // Every revision is asked once, for its wire widths, even with nothing missing.
    if (!wanted.size && cache.asked.get(circuit.name) === doc.revision) return;
    cache.asked.set(circuit.name, doc.revision);
    const asked = [...wanted];
    for (const [id] of asked) cache.pending.add(id);
    const revision = doc.revision;
    const request = ++cache.requests;
    const definitions = asked.map(([, key]) => definitionOf(doc, key));
    command<Reply>({
      op: "symbols",
      id: doc.id,
      revision,
      circuit: circuit.name,
      symbols: asked.map(([, key]) => key),
    })
      .then((reply) => {
        const answers = Array.isArray(reply?.symbols) ? reply.symbols : [];
        asked.forEach(([id], i) => {
          const answer = answers[i];
          cache.entries.set(
            id,
            answer && "ops" in answer
              ? { picture: answer, error: "", definition: definitions[i] }
              : {
                  picture: null,
                  error: answer?.error || "无法绘制此元件",
                  definition: definitions[i],
                },
          );
        });
        const known = cache.widths.get(circuit.name);
        if (!known || known.request < request)
          cache.widths.set(circuit.name, {
            request,
            points: new Set(
              (reply?.widthErrors ?? []).map(([x, y]) => `${x},${y}`),
            ),
          });
      })
      .catch((error) => {
        for (const [id] of asked) cache.failed.set(id, revision);
        const current = shown.current;
        // Answers for a revision the window already left are of no use.
        if (current.id !== doc.id || current.revision !== revision) return;
        if (HostError.from(error).code === "STALE_REVISION")
          callbacks.current.onStale();
        else callbacks.current.onError(error);
      })
      .finally(() => {
        for (const [id] of asked) cache.pending.delete(id);
        cache.notify();
      });
    // `extraIds` stands for `extra`; answers re-run this through `version`.
  }, [cache, doc, circuit, extraIds, version]);
  const ready = circuit.components.every((component) => {
    const id = symbolId(component);
    return (
      Boolean(get(component)) ||
      (!cache.pending.has(id) && cache.failed.get(id) === doc.revision)
    );
  });
  return {
    get,
    latest: (key) => cache.entries.get(symbolId(key)),
    ready,
    widthErrors: cache.widths.get(circuit.name)?.points ?? none,
    version,
  };
}
