import { useEffect, useRef, useState } from "react";
import type { MovePreview } from "../generated/MovePreview";
import { command } from "../shared/transport";
import type { Point } from "../shared/types";
type Move = {
  id: string;
  revision: string;
  circuit: string;
  ids: string[];
  delta: Point;
};
/** The wires Logisim's move gesture takes out and adds at the drag's offset,
 * for drawing; the drag never waits for them. One request at a time: when it
 * returns and the offset has changed, the latest offset is asked. */
export function useMovePreview(move: Move | null) {
  const key = move ? JSON.stringify(move) : "";
  const latest = useRef(key);
  latest.current = key;
  const busy = useRef(false);
  const [preview, setPreview] = useState({ key: "", wires: null as MovePreview | null });
  const ask = useRef(() => {});
  ask.current = () => {
    const asked = latest.current;
    if (busy.current || !asked) return;
    busy.current = true;
    command<MovePreview>({ op: "movePreview", ...JSON.parse(asked) })
      .then(
        (wires) => setPreview({ key: asked, wires }),
        () => {},
      )
      .finally(() => {
        busy.current = false;
        if (latest.current !== asked) ask.current();
      });
  };
  useEffect(() => ask.current(), [key]);
  return key && preview.key === key ? preview.wires : null;
}
