import { useEffect, useRef, useState } from "react";
import type { MovePreview as Preview } from "../generated/MovePreview";
import { command } from "../shared/transport";
import type { Point } from "../shared/types";
type Move = {
  id: string;
  revision: string;
  circuit: string;
  ids: string[];
  delta: Point;
};
export function useMovePreview(move: Move | null) {
  const key = move ? JSON.stringify(move) : "";
  const latest = useRef({ key, move });
  latest.current = { key, move };
  const live = useRef(false);
  const running = useRef(false);
  // The position last sent: a frame that finds it already sent does nothing.
  const sent = useRef("");
  const frame = useRef<number | null>(null);
  const [preview, setPreview] = useState<{
    key: string;
    wires: Preview | null;
    error: string;
  }>({ key: "", wires: null, error: "" });
  const request = useRef<() => void>(() => {});
  request.current = () => {
    const target = latest.current;
    if (running.current || !live.current || !target.move) return;
    if (target.key === sent.current) return;
    sent.current = target.key;
    running.current = true;
    void command<Preview>({ op: "movePreview", ...target.move! })
      .then((result) => {
        if (live.current && latest.current.key === target.key)
          setPreview({
            key: target.key,
            wires: result,
            // A rejected position is a normal part of dragging.
            error: result.error?.message ?? "",
          });
      })
      .catch((error) => {
        if (live.current && latest.current.key === target.key)
          setPreview({
            key: target.key,
            wires: null,
            error: String(error instanceof Error ? error.message : error),
          });
      })
      .finally(() => {
        running.current = false;
        // Coalesce pointer movement while native geometry planning is in flight.
        if (
          live.current &&
          latest.current.key !== target.key &&
          latest.current.move
        )
          request.current();
      });
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, []);
  // At most one request per animation frame; it sends the latest position.
  useEffect(() => {
    if (!move || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      request.current();
    });
  }, [key]);
  return key && preview.key === key ? preview : { key, wires: null, error: "" };
}
