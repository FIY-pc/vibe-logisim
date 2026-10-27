import { useEffect, useRef, useState } from "react";
import type { ConnectionPoint } from "../generated/ConnectionPoint";
import { HostError } from "../shared/host-error";
import { command } from "../shared/transport";
import type { Circuit, Document } from "../shared/types";
import { mergeFocus, type ConnectionFocus } from "./connectivity";

/** What the canvas shows connections for: selected components and wires
 * (document ids), and a traced click. */
export interface ConnectionSeeds {
  components: string[];
  wires: string[];
  point: ConnectionPoint | null;
}

export interface Connections {
  /** The document, revision and circuit read. */
  scope: string;
  /** Everything read for this revision so far; null before the first answer. */
  focus: ConnectionFocus | null;
  /** Whether every seed has been answered. */
  ready: boolean;
  /** Why reading a seed failed. */
  error: string;
}

interface Known {
  scope: string;
  focus: ConnectionFocus | null;
  /** The seeds answered, as `c:<id>`, `w:<id>` and `p:<x>,<y>,<radius>`. */
  answered: Set<string>;
  /** The seeds whose read failed, with why. */
  failed: Map<string, string>;
}
const empty = (scope: string): Known => ({
  scope,
  focus: null,
  answered: new Set(),
  failed: new Map(),
});
const pointToken = (point: ConnectionPoint) =>
  `p:${point.x},${point.y},${point.radius}`;

/**
 * The connections of the shown revision that the seeds need, read with the
 * host's `connections`: the bit nets the seeds are on, every component end
 * on them, and the wire bundles and wires they pass through. Answers of one
 * revision add up, so a seed is read once per revision and only the seeds
 * not read yet are asked. The picture never waits for it. A read the host
 * refuses because the document moved on calls `onStale` instead of
 * reporting an error.
 */
export function useConnections(
  doc: Document,
  circuit: Circuit,
  seeds: ConnectionSeeds,
  onError: (error: unknown) => void,
  onStale: () => void,
): Connections {
  const scope = `${doc.id}:${doc.revision}:${circuit.name}`;
  const [state, setState] = useState<Known>(() => empty(""));
  const known = state.scope === scope ? state : empty(scope);
  const shown = useRef(scope);
  shown.current = scope;
  /** The seeds asked and not answered yet. */
  const pending = useRef({ scope: "", tokens: new Set<string>() });
  const callbacks = useRef({ onError, onStale });
  callbacks.current = { onError, onStale };
  const wanted = [
    ...seeds.components.map((id) => `c:${id}`),
    ...seeds.wires.map((id) => `w:${id}`),
    ...(seeds.point ? [pointToken(seeds.point)] : []),
  ];
  const missing = wanted.filter(
    (token) => !known.answered.has(token) && !known.failed.has(token),
  );
  useEffect(() => {
    if (pending.current.scope !== scope)
      pending.current = { scope, tokens: new Set() };
    const asked = new Set(
      missing.filter((token) => !pending.current.tokens.has(token)),
    );
    if (!asked.size) return;
    for (const token of asked) pending.current.tokens.add(token);
    const point =
      seeds.point && asked.has(pointToken(seeds.point)) ? seeds.point : null;
    command<{ focus?: Partial<ConnectionFocus> }>({
      op: "connections",
      id: doc.id,
      revision: doc.revision,
      circuit: circuit.name,
      components: seeds.components.filter((id) => asked.has(`c:${id}`)),
      wires: seeds.wires.filter((id) => asked.has(`w:${id}`)),
      ...(point ? { point } : {}),
    })
      .then((data) => {
        // An answer for a revision the canvas left would replace the current one's.
        if (shown.current !== scope) return;
        setState((previous) => {
          const base = previous.scope === scope ? previous : empty(scope);
          return {
            ...base,
            focus: mergeFocus(base.focus, data?.focus),
            answered: new Set([...base.answered, ...asked]),
          };
        });
      })
      .catch((error) => {
        if (shown.current !== scope) return;
        if (HostError.from(error).code === "STALE_REVISION") {
          callbacks.current.onStale();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => {
          const base = previous.scope === scope ? previous : empty(scope);
          const failed = new Map(base.failed);
          for (const token of asked) failed.set(token, message);
          return { ...base, failed };
        });
        callbacks.current.onError(error);
      })
      .finally(() => {
        if (pending.current.scope === scope)
          for (const token of asked) pending.current.tokens.delete(token);
      });
    // `missing` is what changes the request.
  }, [scope, missing.join("\n")]);
  return {
    scope,
    focus: known.focus,
    ready: wanted.every((token) => known.answered.has(token)),
    error: wanted.map((token) => known.failed.get(token)).find(Boolean) ?? "",
  };
}
