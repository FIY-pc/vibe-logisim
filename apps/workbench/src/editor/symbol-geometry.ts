import type { SymbolDraft } from "../generated/SymbolDraft";
import type { SymbolPort } from "../generated/SymbolPort";
import type { SymbolShape } from "../generated/SymbolShape";
export function movePort(
  draft: SymbolDraft,
  id: string,
  changes: Partial<SymbolPort>,
) {
  const port = draft.ports.find((p) => p.id === id);
  if (!port) return;
  const labels = draft.shapes.filter(
    (s) =>
      s.tag === "text" &&
      s.text === port.label &&
      Math.hypot(Number(s.attrs.x) - port.x, Number(s.attrs.y) - port.y) < 45,
  );
  if (labels.length === 1) {
    const label = labels[0];
    if (changes.x !== undefined)
      label.attrs.x = String(Number(label.attrs.x) + changes.x - port.x);
    if (changes.y !== undefined)
      label.attrs.y = String(Number(label.attrs.y) + changes.y - port.y);
    if (changes.label !== undefined) label.text = changes.label;
  }
  Object.assign(port, changes);
}
export function removePort(draft: SymbolDraft, id: string) {
  const port = draft.ports.find((p) => p.id === id);
  if (!port) return;
  const labels = draft.shapes.filter(
    (s) =>
      s.tag === "text" &&
      s.text === port.label &&
      Math.hypot(Number(s.attrs.x) - port.x, Number(s.attrs.y) - port.y) < 45,
  );
  if (labels.length === 1)
    draft.shapes = draft.shapes.filter((s) => s !== labels[0]);
  draft.ports = draft.ports.filter((p) => p.id !== id);
}
export function translateShape(shape: SymbolShape, dx: number, dy: number) {
  const a = shape.attrs;
  for (const [key, delta] of [
    ["x", dx],
    ["y", dy],
    ["cx", dx],
    ["cy", dy],
    ["x1", dx],
    ["x2", dx],
    ["y1", dy],
    ["y2", dy],
  ] as const)
    if (a[key] !== undefined) a[key] = String(Number(a[key]) + delta);
  if (a.points)
    a.points = a.points
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return `${x + dx},${y + dy}`;
      })
      .join(" ");
}
export function resizeRect(
  draft: SymbolDraft,
  id: string,
  changes: Record<string, string>,
) {
  const shape = draft.shapes.find((s) => s.id === id)!;
  const old = { ...shape.attrs };
  Object.assign(shape.attrs, changes);
  const dx = Number(shape.attrs.width) - Number(old.width),
    dy = Number(shape.attrs.height) - Number(old.height);
  for (const p of draft.ports) {
    const update: Partial<SymbolPort> = {};
    if (
      p.x === Number(old.x) + Number(old.width) &&
      p.y >= Number(old.y) &&
      p.y <= Number(old.y) + Number(old.height)
    )
      update.x = p.x + dx;
    if (
      p.y === Number(old.y) + Number(old.height) &&
      p.x >= Number(old.x) &&
      p.x <= Number(old.x) + Number(old.width)
    )
      update.y = p.y + dy;
    if (Object.keys(update).length) movePort(draft, p.id, update);
  }
  for (const text of draft.shapes.filter(
    (s) => s.tag === "text" && s.attrs["text-anchor"] === "middle",
  ))
    if (Number(text.attrs.x) === Number(old.x) + Number(old.width) / 2)
      text.attrs.x = String(Number(text.attrs.x) + dx / 2);
}
