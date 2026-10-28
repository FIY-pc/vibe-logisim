import { useEffect, useRef, useState } from "react";
import type {
  CatalogTool,
  Circuit,
  Document,
  Edit,
  Point,
  XmlNode,
} from "../shared/types";
import type { PlacementState } from "./usePlacement";

export interface PlacementPreview {
  key: number;
  name: string;
  point: Point;
  template: XmlNode;
  /** The revision the placement made, once committed. */
  committed: string | null;
}

/**
 * Clicks while placing: each takes the template and attributes of its
 * moment and is committed in order, each from the revision the previous one
 * made. Until the document shows a placement, its ghost stays where it was
 * clicked; a failure drops the rest of the queue and says how many were not
 * placed.
 */
export function usePlacementQueue({
  doc,
  circuit,
  place,
  placement,
  onPlace,
  onCancelPlace,
  onError,
}: {
  doc: Document;
  circuit: Circuit;
  place: CatalogTool | null;
  placement: PlacementState;
  onPlace: (revision: string, edit: Edit) => Promise<{ revision: string }>;
  onCancelPlace: () => void;
  onError: (e: unknown) => void;
}) {
  const queue = useRef<{ key: number; revision: string; edit: Edit }[]>([]);
  const placing = useRef(false);
  const queueRevision = useRef<string | null>(null);
  const alive = useRef(true);
  const placeCommand = useRef(onPlace);
  placeCommand.current = onPlace;
  const sequence = useRef(0);
  const [previews, setPreviews] = useState<PlacementPreview[]>([]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current = [];
    };
  }, []);
  // A committed ghost leaves once the document shows its placement.
  useEffect(() => {
    const shown = (p: PlacementPreview) =>
      p.committed !== null &&
      (p.committed === doc.revision ||
        circuit.components.some(
          (c) =>
            c.name === p.name &&
            c.location.x === p.point.x &&
            c.location.y === p.point.y,
        ));
    if (previews.some(shown))
      setPreviews((previous) => previous.filter((p) => !shown(p)));
  }, [doc.revision, circuit, previews]);
  const drain = async () => {
    if (placing.current) return;
    placing.current = true;
    try {
      while (alive.current && queue.current.length) {
        const item = queue.current[0];
        const next = await placeCommand.current(
          queueRevision.current || item.revision,
          item.edit,
        );
        queueRevision.current = next.revision;
        if (alive.current)
          setPreviews((previous) =>
            previous.map((preview) =>
              preview.key === item.key
                ? { ...preview, committed: next.revision }
                : preview.committed
                  ? { ...preview, committed: next.revision }
                  : preview,
            ),
          );
        if (queue.current[0] === item) queue.current.shift();
      }
    } catch (e) {
      const remaining = queue.current.length;
      queue.current = [];
      if (alive.current) {
        setPreviews((previous) =>
          previous.filter((preview) => preview.committed),
        );
        onError(
          `${e instanceof Error ? e.message : String(e)}${remaining > 1 ? `；后续 ${remaining - 1} 个元件未放置` : ""}`,
        );
      }
    } finally {
      placing.current = false;
      queueRevision.current = null;
    }
  };
  const enqueue = (point: Point) => {
    const template = placement.template;
    if (!place || !template || placement.error) return;
    if (
      circuit.components.some(
        (c) =>
          c.name === place.name &&
          c.location.x === point.x &&
          c.location.y === point.y,
      ) ||
      queue.current.some(
        (item) =>
          item.edit.kind === "place" &&
          item.edit.name === place.name &&
          item.edit.location.x === point.x &&
          item.edit.location.y === point.y,
      )
    ) {
      onError("此位置已有相同元件");
      return;
    }
    const bounds = template.children.find((n) => n.tag === "bounds");
    if (
      bounds &&
      (point.x + Number(bounds.attributes.x) < 0 ||
        point.y + Number(bounds.attributes.y) < 0)
    ) {
      onError("请把整个元件放在坐标原点的右下方");
      return;
    }
    const key = ++sequence.current;
    if (!placing.current && !queue.current.length)
      queueRevision.current = doc.revision;
    queue.current.push({
      key,
      revision: doc.revision,
      edit: {
        kind: "place",
        name: place.name,
        library: place.library || null,
        location: point,
        attributes: { ...placement.attributes },
      },
    });
    setPreviews((previous) => [
      ...previous,
      { key, name: place.name, point, template, committed: null },
    ]);
    if (!placement.repeat) onCancelPlace();
    void drain();
  };
  return { previews, enqueue };
}
