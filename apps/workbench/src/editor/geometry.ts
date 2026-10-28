/**
 * Where the canvas's objects are: component bounds from the recorded
 * pictures (see `symbols.ts`), wire boxes from their ends. Hit testing, box
 * selection, marks and fitting all read these, so they never wait for an
 * observation of the circuit.
 */
import type { Bounds, Circuit, Component, Point } from "../shared/types";
import type { Scene } from "./paint";

export interface View {
  x: number;
  y: number;
  scale: number;
}

/** Where a component is taken to be before its kind is known. */
export const fallbackBounds = (c: Component): Bounds => ({
  x: c.location.x - 25,
  y: c.location.y - 15,
  width: 35,
  height: 30,
});

export const wireBounds = (w: { from: Point; to: Point }): Bounds => ({
  x: Math.min(w.from.x, w.to.x),
  y: Math.min(w.from.y, w.to.y),
  width: Math.abs(w.to.x - w.from.x),
  height: Math.abs(w.to.y - w.from.y),
});

const within = (b: Bounds, p: Point, margin: number) =>
  p.x >= b.x - margin &&
  p.x <= b.x + b.width + margin &&
  p.y >= b.y - margin &&
  p.y <= b.y + b.height + margin;

/** The object under `p`: the topmost component, else a wire. */
export function hitTest(scene: Scene, circuit: Circuit, p: Point) {
  for (let i = circuit.components.length - 1; i >= 0; i--) {
    const c = circuit.components[i];
    const b = scene.bounds.get(c.id);
    if (b && within(b, p, 3)) return c.id;
  }
  for (const w of circuit.wires) {
    const b = scene.bounds.get(w.id);
    if (b && within(b, p, 4)) return w.id;
  }
  return null;
}

/** The objects lying entirely inside a box. */
export function insideBox(
  scene: Scene,
  circuit: Circuit,
  box: { x: number; y: number; right: number; bottom: number },
) {
  return [...circuit.components, ...circuit.wires]
    .filter((item) => {
      const b = scene.bounds.get(item.id);
      return (
        b &&
        b.x >= box.x &&
        b.y >= box.y &&
        b.x + b.width <= box.right &&
        b.y + b.height <= box.bottom
      );
    })
    .map((item) => item.id);
}

/**
 * The view showing the whole circuit with a margin, between the canvas's
 * top and bottom insets (the floating toolbars); null for an empty circuit.
 */
export function fitView(
  scene: Scene,
  size: { width: number; height: number },
  insets: { top: number; bottom: number },
): View | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const b of scene.bounds.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (minX === Infinity) return null;
  minX -= 45;
  minY -= 45;
  maxX += 45;
  maxY += 45;
  const height = Math.max(1, size.height - insets.top - insets.bottom);
  const scale = Math.min(
    2,
    Math.max(
      0.08,
      Math.min(size.width / (maxX - minX), height / (maxY - minY)),
    ),
  );
  return {
    x: minX - (size.width / scale - (maxX - minX)) / 2,
    y: (minY + maxY) / 2 - (insets.top + height / 2) / scale,
    scale,
  };
}
