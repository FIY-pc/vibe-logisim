import { useCallback, useEffect, useRef, type RefObject } from "react";
import { isMac } from "../shared/shortcuts";

export function nativeDropPoint(position: { x: number; y: number }) {
  // Wry 0.57's WKWebView handler reports AppKit points, although Tauri labels
  // them PhysicalPosition. Keep the other platforms' conversion unchanged.
  const scale = isMac() ? 1 : window.devicePixelRatio;
  return { x: position.x / scale, y: position.y / scale };
}

/** Keep scrolling and hit-testing while a held drag stays at a tree edge. */
export function useFileDragHover(
  container: RefObject<HTMLDivElement | null>,
  onHover: (x: number, y: number) => void,
) {
  const hover = useRef(onHover);
  hover.current = onHover;
  const point = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const previousTime = useRef<number | null>(null);
  const cancel = useCallback(() => {
    point.current = null;
    previousTime.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const tick = useCallback(
    (time: number) => {
      const cursor = point.current;
      if (!cursor) return;
      const elapsed = Math.min(time - (previousTime.current ?? time), 32);
      previousTime.current = time;
      const tree = container.current?.querySelector<HTMLElement>(".file-tree");
      if (tree) {
        const rect = tree.getBoundingClientRect();
        if (
          cursor.x >= rect.left &&
          cursor.x <= rect.right &&
          cursor.y >= rect.top &&
          cursor.y <= rect.bottom
        ) {
          const edge = Math.min(35, rect.height / 3);
          const top = cursor.y - rect.top;
          const bottom = rect.bottom - cursor.y;
          const speed =
            top < edge
              ? -(1 - top / edge)
              : bottom < edge
                ? 1 - bottom / edge
                : 0;
          tree.scrollTop += (speed * 840 * elapsed) / 1000;
        }
      }
      // Scrolling or expanding a folder changes the target under a still cursor.
      hover.current(cursor.x, cursor.y);
      frame.current = requestAnimationFrame(tick);
    },
    [container],
  );
  const update = useCallback(
    (x: number, y: number) => {
      point.current = { x, y };
      hover.current(x, y);
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
    },
    [tick],
  );
  useEffect(() => cancel, [cancel]);
  return { update, cancel };
}
