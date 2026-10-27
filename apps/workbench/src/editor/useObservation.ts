import { useEffect, useRef, useState } from "react";
import { HostError } from "../shared/host-error";
import { command } from "../shared/transport";
import type { Circuit, Document } from "../shared/types";
import type { ConnectionFocus } from "./connectivity";

export interface Observation {
  /** The document, revision and circuit observed. */
  scope: string;
  focus: ConnectionFocus | null;
  error: string;
}

/**
 * The runtime's connectivity of the shown revision, read only while
 * something shows it (the selection's connections, a traced signal). The
 * picture never waits for it. A read the host refuses because the document
 * moved on calls `onStale` instead of reporting an error.
 */
export function useObservation(
  doc: Document,
  circuit: Circuit,
  needed: boolean,
  onError: (error: unknown) => void,
  onStale: () => void,
): Observation {
  const scope = `${doc.id}:${doc.revision}:${circuit.name}`;
  const [state, setState] = useState<Observation>({
    scope: "",
    focus: null,
    error: "",
  });
  const callbacks = useRef({ onError, onStale });
  callbacks.current = { onError, onStale };
  const known = state.scope === scope;
  useEffect(() => {
    if (!needed || known) return;
    let live = true;
    command<{ focus?: Partial<ConnectionFocus> }>({
      op: "observe",
      id: doc.id,
      revision: doc.revision,
      circuit: circuit.name,
    })
      .then((data) => {
        const focus = data?.focus;
        if (live)
          setState({
            scope,
            focus: {
              components: focus?.components || [],
              wires: focus?.wires || [],
              wireBundles: focus?.wireBundles || [],
              bitNets: focus?.bitNets || [],
            },
            error: "",
          });
      })
      .catch((error) => {
        if (!live) return;
        if (HostError.from(error).code === "STALE_REVISION") {
          callbacks.current.onStale();
          return;
        }
        setState({
          scope,
          focus: null,
          error: error instanceof Error ? error.message : String(error),
        });
        callbacks.current.onError(error);
      });
    return () => {
      live = false;
    };
  }, [scope, needed, known]);
  return known ? state : { scope, focus: null, error: "" };
}
