// Preserve author text without making it an electrical placement node.
import { PyValueError, item, minOf, pyStr, sortBy } from "./py.mts";
import { attr, snap } from "./schematic-layout.mts";
import type { Report, SchematicLayout } from "./schematic-layout.mts";
import type { Bounds, Component } from "./types.mts";

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// The plan for every source Text: a compact heading over its group, or a
// note in the overview band above the diagram. Returns the plan and the
// height of that band (0 when it is empty). Marks groups whose heading comes
// from the source (sourceHeading), as the caller's annotation pass reads.
export function arrangeAnnotations(
  layout: SchematicLayout,
  intent: Report,
  groups: Report[],
  members: ReadonlyMap<string, string[]>,
  legacy: ReadonlyMap<string, string>,
): [Report[], number] {
  const texts = new Map<string, Component>();
  for (const [cid, c] of layout.byId)
    if (layout.bodyIds.has(cid) && c.factoryName === "Text") texts.set(cid, c);
  const byGroup = new Map<unknown, Report>(groups.map((g) => [g.id, g]));
  const explicit = new Map<unknown, Report>();
  for (const entry of (hasOwn(intent, "annotations")
    ? intent.annotations
    : []) as Report[]) {
    const cid = entry.componentId;
    if (!texts.has(cid) || explicit.has(cid))
      throw new PyValueError(`注释对象不存在、固定或重复: ${pyStr(cid)}`);
    const role = hasOwn(entry, "role") ? entry.role : "overview";
    if (role !== "heading" && role !== "overview")
      throw new PyValueError(`未知注释角色: ${pyStr(role)}`);
    const groupId = hasOwn(entry, "groupId") ? entry.groupId : null;
    if (role === "heading" && !byGroup.has(groupId))
      throw new PyValueError(`标题引用未知分组: ${pyStr(groupId)}`);
    explicit.set(cid, entry);
  }
  const result: Report[] = [];
  let top = 0;
  for (const [cid, c] of sortBy(texts, ([id, t]) => [
    t.bounds.y,
    t.bounds.x,
    id,
  ])) {
    const b: Bounds = hasOwn(c, "visualBounds")
      ? (c.visualBounds as Bounds)
      : c.bounds;
    const entry = explicit.get(cid) ?? {};
    const gid = hasOwn(entry, "groupId")
      ? entry.groupId
      : (legacy.get(cid) ?? null);
    const group = byGroup.get(gid);
    let role = hasOwn(entry, "role") ? entry.role : "overview";
    // Compatibility with old plans containing Text: only reuse a compact
    // original heading above its owned parts. Long legends and other notes
    // keep their native text/style in a separate overview band.
    if (!explicit.has(cid) && group && !group.sourceHeading) {
      const sourceTop = minOf(
        item(members, gid).map((p) => item(layout.byId, p).bounds.y),
        Infinity,
      );
      if (
        b.y + b.height <= sourceTop &&
        b.width <= group.width - 40 &&
        b.height <= 35
      )
        role = "heading";
    }
    let x: number;
    let y: number;
    if (role === "heading") {
      const heading = group as Report;
      if (
        heading.sourceHeading ||
        b.width > heading.width - 40 ||
        b.height > 35
      )
        throw new PyValueError(
          `分组标题重复或无法容纳原文: ${cid}；使用 overview 保留完整说明。`,
        );
      heading.sourceHeading = cid;
      [x, y] = [heading.x + 20, heading.y + 5];
    } else {
      [x, y] = [0, top];
      top += snap(b.height + 25);
    }
    result.push({
      componentId: cid,
      text: attr(c, "text") || "",
      role,
      groupId: gid,
      x,
      y,
      width: b.width,
      height: b.height,
    });
  }
  return [result, top ? top + 30 : 0];
}
