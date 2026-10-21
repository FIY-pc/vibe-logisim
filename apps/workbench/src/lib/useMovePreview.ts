import { useEffect, useRef, useState } from "react";
import type { MovePreview as Preview } from "../generated/MovePreview";
import { command } from "./transport";
import type { Point } from "./types";
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preview, setPreview] = useState<{
    key: string;
    wires: Preview | null;
    error: string;
  }>({ key: "", wires: null, error: "" });
  const request = useRef<() => void>(() => {});
  request.current = () => {
    if (running.current || !live.current || !latest.current.move) return;
    const target = latest.current;
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
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (!move) return;
    timer.current = setTimeout(() => request.current(), 100);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key]);
  return key && preview.key === key
    ? preview
    : { key, wires: null, error: "" };
}
