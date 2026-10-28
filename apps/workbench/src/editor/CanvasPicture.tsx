import { useEffect, useLayoutEffect, useRef } from "react";
import { onImageLoad, paintFrame, type Frame } from "./paint";

/**
 * The editor picture's `<canvas>`. Each new frame is painted at the next
 * animation frame, so any number of changes within one display frame cost
 * one paint; a change of device pixel ratio or a recorded image finishing
 * loading paints again.
 */
export function CanvasPicture({ frame }: { frame: Frame }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(frame);
  latest.current = frame;
  const painted = useRef<Frame | null>(null);
  const scheduled = useRef<number | null>(null);
  const schedule = useRef(() => {});
  schedule.current = () => {
    if (scheduled.current !== null) return;
    scheduled.current = requestAnimationFrame(() => {
      scheduled.current = null;
      if (!canvas.current) return;
      painted.current = latest.current;
      paintFrame(canvas.current, latest.current, window.devicePixelRatio || 1);
    });
  };
  useLayoutEffect(() => {
    if (painted.current !== frame) schedule.current();
  });
  useEffect(() => {
    const repaint = () => {
      painted.current = null;
      schedule.current();
    };
    const stop = onImageLoad(repaint);
    let media: MediaQueryList | null = null;
    const watch = () => {
      media?.removeEventListener("change", changed);
      media =
        window.matchMedia?.(
          `(resolution: ${window.devicePixelRatio || 1}dppx)`,
        ) ?? null;
      media?.addEventListener("change", changed);
    };
    const changed = () => {
      watch();
      repaint();
    };
    watch();
    return () => {
      stop();
      media?.removeEventListener("change", changed);
      if (scheduled.current !== null) cancelAnimationFrame(scheduled.current);
      scheduled.current = null;
    };
  }, []);
  return <canvas ref={canvas} className="canvas-picture" aria-hidden="true" />;
}
