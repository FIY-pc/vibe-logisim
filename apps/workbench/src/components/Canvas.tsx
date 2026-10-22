import { useMovePreview } from "../lib/useMovePreview";
import type { PlacementState } from "../lib/usePlacement";
import { Connections } from "./Connections";
import { SelectionConnections } from "./SelectionConnections";
import {
  connectionIndex,
  documentComponent,
  documentWire,
  portSignal,
  signalTrace,
  wireSignal,
  type ConnectionFocus,
  type ConnectionPeer,
  type SignalTarget,
} from "../lib/connections";
import {
  useCallback,
  useId,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  XmlNode,
  Bounds,
  CatalogTool,
  Circuit,
  Component,
  Document,
  Edit,
  Point,
  Tool,
} from "../lib/types";
import type { RunState } from "../generated/RunState";
import type { FrameImage } from "../generated/FrameImage";
import { command } from "../lib/transport";
import { liveViewport } from "../lib/simulation";
interface Props {
  doc: Document;
  circuit: Circuit;
  tool: Tool;
  selection: string[];
  setSelection: (s: string[]) => void;
  place: CatalogTool | null;
  edit: (e: Edit) => Promise<void>;
  /** The run, when the canvas shows its view rather than the definition. */
  run: RunState | null;
  /** The decoded picture of the run's frame, and where it was drawn. */
  picture: { frameSequence: number; url: string; image: FrameImage } | null;
  /** Components of the run whose input the user changed, until a frame shows it. */
  pending: string[];
  /** The button held down in the run. */
  pressed: string | null;
  /** Operates a component of the run: the poke tool, a button press and its
   * point, or an open memory. */
  onPoke: (component: Component, point: Point) => void;
  onPress: (component: Component) => void;
  onRelease: () => void;
  onViewport: (
    viewId: string,
    area: { x: number; y: number; width: number; height: number; scale: number },
  ) => void;
  onError: (e: unknown) => void;
  fitToken: number;
  zoomRequest?: { token: number; factor: number };
  onZoomChange?: (zoom: number) => void;
  onObservation?: (observation: {
    scope: string;
    focus: ConnectionFocus | null;
  }) => void;
  showGrid?: boolean;
  placement: PlacementState;
  onPlace: (revision: string, edit: Edit) => Promise<Document>;
  onCancelPlace: () => void;
  focusTarget?: { id: string; token: number } | null;
  onOpenMemory: (id: string) => void;
  onEnterCircuit: (name: string, id: string) => void;
  onSignalView?: (view: ReactNode) => void;
  onSignalOpen?: () => void;
}
const snap = (v: number) => Math.round(v / 10) * 10;
const route = (a: Point, b: Point): Point[] =>
  [a, { x: b.x, y: a.y }, b].filter(
    (p, i, arr) => i === 0 || p.x !== arr[i - 1].x || p.y !== arr[i - 1].y,
  );
export function Canvas({
  doc,
  circuit,
  tool,
  selection,
  setSelection,
  place,
  edit,
  run,
  picture: frame,
  pending,
  pressed,
  onPoke,
  onPress,
  onRelease,
  onViewport,
  onError,
  fitToken,
  zoomRequest,
  onZoomChange,
  onObservation,
  showGrid = true,
  placement,
  onPlace,
  onCancelPlace,
  focusTarget,
  onEnterCircuit,
  onSignalView,
  onSignalOpen,
  onOpenMemory,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ x: -40, y: -40, scale: 1 });
  const lastZoom = useRef(zoomRequest?.token);
  useEffect(() => {
    onZoomChange?.(view.scale);
  }, [view.scale, onZoomChange]);
  useEffect(() => {
    if (!zoomRequest || lastZoom.current === zoomRequest.token) return;
    lastZoom.current = zoomRequest.token;
    setView((previous) => {
      const scale = Math.max(
        0.05,
        Math.min(8, previous.scale * zoomRequest.factor),
      );
      return {
        x:
          previous.x + size.width / 2 / previous.scale - size.width / 2 / scale,
        y:
          previous.y +
          size.height / 2 / previous.scale -
          size.height / 2 / scale,
        scale,
      };
    });
  }, [zoomRequest, size]);
  const [image, setImage] = useState<{
    src: string;
    bounds: Bounds;
    revision: string;
  } | null>(null);
  const template = placement.template;
  const placementAttributes = placement.attributes;
  const [heldSpace, setHeldSpace] = useState(false);
  const spaceHeld = useRef(false);
  const queue = useRef<{ key: number; revision: string; edit: Edit }[]>([]);
  const placing = useRef(false);
  const queueRevision = useRef<string | null>(null);
  const lastPlacedRevision = useRef<string | null>(null);
  const alive = useRef(true);
  const placeCommand = useRef(onPlace);
  placeCommand.current = onPlace;
  const placementSequence = useRef(0);
  const [previews, setPreviews] = useState<
    { key: number; point: Point; template: XmlNode; committed: boolean }[]
  >([]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current = [];
    };
  }, []);
  useEffect(() => {
    if (image?.revision === lastPlacedRevision.current)
      setPreviews((previous) => previous.filter((item) => !item.committed));
  }, [image]);
  const drainPlacements = async () => {
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
        lastPlacedRevision.current = next.revision;
        if (alive.current)
          setPreviews((previous) =>
            previous.map((preview) =>
              preview.key === item.key
                ? { ...preview, committed: true }
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
  const enqueuePlacement = (point: Point) => {
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
    const key = ++placementSequence.current;
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
        attributes: { ...placementAttributes },
      },
    });
    setPreviews((previous) => [
      ...previous,
      { key, point, template, committed: false },
    ]);
    if (!placement.repeat) onCancelPlace();
    void drainPlacements();
  };
  const observationScope = `${doc.id}:${doc.revision}:${circuit.name}`;
  const pictureScope = `${doc.id}:${circuit.name}`;
  const [observation, setObservation] = useState<{
    scope: string;
    picture: string;
    focus: ConnectionFocus | null;
  }>({ scope: "", picture: "", focus: null });
  const focus =
    observation.scope === observationScope ? observation.focus : null;
  // Until the next revision is observed, the previous geometry keeps hit
  // testing and port marks working; components match by location and factory.
  const geometry =
    observation.picture === pictureScope ? observation.focus : null;
  const [observationError, setObservationError] = useState("");
  useEffect(() => {
    onObservation?.({ scope: observationScope, focus });
  }, [onObservation, observationScope, focus]);
  const observed = useMemo(() => geometry?.components || [], [geometry]);
  const connections = useMemo(
    () => (focus ? connectionIndex(focus) : null),
    [focus],
  );
  const [signal, setSignal] = useState<SignalTarget | null>(null);
  const internalSelection = useRef<string | null>(null);
  useEffect(() => {
    if (internalSelection.current !== selection.join(",")) setSignal(null);
    internalSelection.current = null;
  }, [selection.join(",")]);
  const selectObjects = (ids: string[]) => {
    setSignal(null);
    setSelection(ids);
  };
  const [signalHistory, setSignalHistory] = useState<
    { view: typeof view; selection: string[]; signal: SignalTarget | null }[]
  >([]);
  useEffect(() => setSignal(null), [place?.library, place?.name]);
  const [wire, setWire] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [drag, setDrag] = useState<{
    mode: "pan" | "move" | "box";
    axis?: "x" | "y";
    start: Point;
    client: Point;
    ids: string[];
    origin: typeof view;
  } | null>(null);
  const [delta, setDelta] = useState<Point>({ x: 0, y: 0 });
  const moving = drag?.mode === "move" && Boolean(delta.x || delta.y);
  const moveClip = useId().replaceAll(":", "");
  const movePreview = useMovePreview(
    moving
      ? {
          id: doc.id,
          revision: doc.revision,
          circuit: circuit.name,
          ids: drag.ids,
          delta,
        }
      : null,
  );
  // The preview answers with the routing difference, not a whole picture.
  const movedSegments = movePreview.wires?.addedWires ?? [];
  type Overlay = {
    kind: "move" | "wire" | "delete";
    delta: Point;
    /** Parts drawn at their new place, or covered when deleted. */
    clip: Bounds[];
    /** Wires drawn at their new place, or covered when deleted. */
    lines: { from: Point; to: Point; dashed?: boolean }[];
  };
  // A committed move, wire or deletion stays drawn until the picture of its
  // result arrives, so a large file does not show the old state in between.
  const [settle, setSettle] = useState<
    (Overlay & { key: number; from: string; resolved: boolean }) | null
  >(null);
  const settleKey = useRef(0);
  const shownPicture = useRef("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const held = useRef<(() => void) | null>(null);
  const wireGesture = useRef<{ x: number; y: number } | null>(null);
  const releaseHeld = () => {
    const release = held.current;
    held.current = null;
    if (release) release();
  };
  const releaseRef = useRef(releaseHeld);
  releaseRef.current = releaseHeld;
  useEffect(() => {
    const release = () => releaseRef.current();
    window.addEventListener("blur", release);
    return () => {
      release();
      window.removeEventListener("blur", release);
    };
  }, []);
  const live = Boolean(run);
  const bindings = {
    id: doc.id,
    revision: doc.revision,
    circuit: circuit.name,
  };
  useEffect(() => {
    if (!container.current) return;
    const ro = new ResizeObserver(([e]) =>
      setSize({
        width: Math.max(1, e.contentRect.width),
        height: Math.max(1, e.contentRect.height),
      }),
    );
    ro.observe(container.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setWire([]);
    wireGesture.current = null;
    setDrag(null);
    setDelta({ x: 0, y: 0 });
    releaseRef.current();
    setObservationError("");
    setSignal(null);
    setSignalHistory([]);
    // Another revision of the same circuit keeps its picture until the new one arrives.
    if (shownPicture.current !== pictureScope) {
      shownPicture.current = pictureScope;
      setImage(null);
      setSettle(null);
    }
    let live = true;
    command<{ focus: ConnectionFocus }>({
      op: "observe",
      ...bindings,
    })
      .then((data) => {
        if (live)
          setObservation({
            scope: observationScope,
            picture: pictureScope,
            focus: {
              ...data.focus,
              wires: data.focus.wires || [],
              wireBundles: data.focus.wireBundles || [],
              bitNets: data.focus.bitNets || [],
            },
          });
      })
      .catch((e) => {
        if (live) {
          setObservationError(e instanceof Error ? e.message : String(e));
          onError(e);
        }
      });
    return () => {
      live = false;
    };
  }, [doc.id, doc.revision, circuit.name]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        e.code !== "Space" ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.isComposing ||
        (e.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"]',
        ) ||
        document.querySelector('dialog[open],[aria-modal="true"]')
      )
        return;
      e.preventDefault();
      spaceHeld.current = true;
      setHeldSpace(true);
    };
    const release = () => {
      spaceHeld.current = false;
      setHeldSpace(false);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);
  const ghost = template?.children.find((n) => n.tag === "image");
  const boundsFor = useCallback(
    (id: string): Bounds => {
      const c = circuit.components.find((c) => c.id === id);
      if (c) {
        const o = observed.find(
          (o) =>
            o.location.x === c.location.x &&
            o.location.y === c.location.y &&
            o.factoryName === c.name,
        );
        return (
          o?.bounds || {
            x: c.location.x - 25,
            y: c.location.y - 15,
            width: 35,
            height: 30,
          }
        );
      }
      const w = circuit.wires.find((w) => w.id === id);
      if (!w) return { x: 0, y: 0, width: 0, height: 0 };
      return {
        x: Math.min(w.from.x, w.to.x),
        y: Math.min(w.from.y, w.to.y),
        width: Math.abs(w.to.x - w.from.x),
        height: Math.abs(w.to.y - w.from.y),
      };
    },
    [circuit, observed],
  );
  const overlay: Overlay | null = moving
    ? {
        kind: "move",
        delta,
        clip: circuit.components
          .filter((component) => drag.ids.includes(component.id))
          .map((component) => boundsFor(component.id)),
        lines: movedSegments.length
          ? movedSegments
          : circuit.wires
              .filter((wire) => drag.ids.includes(wire.id))
              .map((wire) => ({
                from: { x: wire.from.x + delta.x, y: wire.from.y + delta.y },
                to: { x: wire.to.x + delta.x, y: wire.to.y + delta.y },
                dashed: true,
              })),
      }
    : settle;
  const commit = (change: Edit, overlay: Overlay) => {
    const key = ++settleKey.current;
    setSettle({ ...overlay, key, from: doc.revision, resolved: false });
    edit(change)
      .then(() =>
        setSettle((s) => (s?.key === key ? { ...s, resolved: true } : s)),
      )
      .catch((e) => {
        setSettle((s) => (s?.key === key ? null : s));
        onError(e);
      });
  };
  const wireOverlay = (points: Point[]): Overlay => ({
    kind: "wire",
    delta: { x: 0, y: 0 },
    clip: [],
    lines: points.slice(1).map((to, i) => ({ from: points[i], to })),
  });
  const deleteOverlay = (ids: string[]): Overlay => ({
    kind: "delete",
    delta: { x: 0, y: 0 },
    clip: circuit.components
      .filter((component) => ids.includes(component.id))
      .map((component) => boundsFor(component.id)),
    lines: circuit.wires.filter((wire) => ids.includes(wire.id)),
  });
  useEffect(() => {
    if (!settle?.resolved) return;
    // The result's picture arrived, or the edit changed nothing.
    if (image?.revision === doc.revision || doc.revision === settle.from)
      setSettle(null);
  }, [settle, image, doc.revision]);
  const visitSignal = (peer: ConnectionPeer, previousSignal = signal) => {
    const component = documentComponent(circuit, peer.component);
    if (!component) return;
    setSignalHistory((previous) => [
      ...previous.slice(-39),
      { view, selection: [...selection], signal: previousSignal },
    ]);
    internalSelection.current = component.id;
    setSelection([component.id]);
    const b = peer.component.bounds;
    const scale = Math.min(
      1.3,
      view.scale,
      size.width / (b.width + 100),
      size.height / (b.height + 100),
    );
    setView({
      x: b.x + b.width / 2 - size.width / scale / 2,
      y: b.y + b.height / 2 - size.height / scale / 2,
      scale,
    });
  };
  const signalBack = () => {
    const previous = signalHistory.at(-1);
    if (!previous) return;
    setSignalHistory((items) => items.slice(0, -1));
    setSignal(previous.signal);
    internalSelection.current = previous.selection.join(",");
    setSelection(previous.selection);
    setView(previous.view);
  };
  useEffect(() => {
    onSignalView?.(
      signal && connections ? (
        <Connections
          index={connections}
          target={signal}
          onNavigate={visitSignal}
          onClose={() => setSignal(null)}
          onBack={signalHistory.length ? signalBack : undefined}
        />
      ) : (
        <SelectionConnections
          focus={focus}
          circuit={circuit}
          selection={selection}
          error={observationError}
          onVisit={visitSignal}
          onTrace={(target) => startSignal(target, false)}
          onBack={signalHistory.length ? signalBack : undefined}
        />
      ),
    );
  }, [
    signal,
    connections,
    signalHistory,
    view,
    selection.join(","),
    onSignalView,
    focus,
    circuit,
    observationError,
  ]);
  useEffect(() => () => onSignalView?.(null), [onSignalView]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        e.altKey &&
        e.key === "ArrowLeft" &&
        signalHistory.length &&
        !document.querySelector('dialog[open],[aria-modal="true"]') &&
        !(e.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"]',
        )
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        signalBack();
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [signalHistory]);
  const startSignal = (target: SignalTarget | null, jump = true) => {
    if (!connections || !target) {
      onError("未读取到此信号的连接信息");
      return;
    }
    const previous = signal;
    setSignal(target);
    onSignalOpen?.();
    const source = signalTrace(
      connections,
      target.bits,
      target.origin,
    ).singleSource;
    if (source && jump) visitSignal(source, previous);
  };
  const traceAt = (p: Point, id: string | null) => {
    if (!connections) {
      onError("正在读取连接，请稍后重试");
      return;
    }
    const near = observed
      .flatMap((component) =>
        component.ends.map((end) => ({
          component,
          end,
          distance: Math.hypot(p.x - end.location.x, p.y - end.location.y),
        })),
      )
      .filter((port) => port.distance <= Math.max(5, 7 / view.scale))
      .sort((a, b) => a.distance - b.distance)[0];
    if (near) {
      startSignal(portSignal(near.component, near.end));
      return;
    }
    const component = observed.find(
      (c) => documentComponent(circuit, c)?.id === id,
    );
    if (component?.ends.length === 1) {
      startSignal(portSignal(component, component.ends[0]));
      return;
    }
    const wire = focus?.wires.find((w) => documentWire(circuit, w)?.id === id);
    if (wire) {
      startSignal(wireSignal(connections, wire));
      return;
    }
    if (component) {
      selectObjects([id!]);
      onError("请选择要追踪的端口");
    }
  };
  const fitted = useRef("");
  useEffect(() => {
    const fitScope = `${doc.id}:${circuit.name}:${fitToken}`;
    if (
      !size.width ||
      !size.height ||
      fitted.current === fitScope ||
      (circuit.components.length > 0 && !observed.length)
    )
      return;
    fitted.current = fitScope;
    const points = [
      ...circuit.components.flatMap((c) => {
        const b = boundsFor(c.id);
        return [
          { x: b.x, y: b.y },
          { x: b.x + b.width, y: b.y + b.height },
        ];
      }),
      ...circuit.wires.flatMap((w) => [w.from, w.to]),
    ];
    if (!points.length) {
      setView({ x: -40, y: -40, scale: 1 });
      return;
    }
    const minX = Math.min(...points.map((p) => p.x)) - 45,
      minY = Math.min(...points.map((p) => p.y)) - 45,
      maxX = Math.max(...points.map((p) => p.x)) + 45,
      maxY = Math.max(...points.map((p) => p.y)) + 45;
    const viewport = container.current!.getBoundingClientRect();
    const surface = container.current!.parentElement;
    const toolbar = surface
      ?.querySelector(".canvas-tools")
      ?.getBoundingClientRect();
    const transport = surface
      ?.querySelector(".runtime-transport")
      ?.getBoundingClientRect();
    const top = transport
      ? Math.max(0, transport.bottom - viewport.top) + 12
      : 0;
    const bottom = toolbar
      ? Math.max(0, viewport.bottom - toolbar.top) + 12
      : 0;
    const availableHeight = Math.max(1, size.height - top - bottom);
    const scale = Math.min(
      2,
      Math.max(
        0.08,
        Math.min(size.width / (maxX - minX), availableHeight / (maxY - minY)),
      ),
    );
    setView({
      x: minX - (size.width / scale - (maxX - minX)) / 2,
      y: (minY + maxY) / 2 - (top + availableHeight / 2) / scale,
      scale,
    });
  }, [doc.id, circuit.name, fitToken, size, observed, boundsFor]);
  useEffect(() => {
    if (
      !focusTarget ||
      !size.width ||
      !size.height ||
      !circuit.components.some((c) => c.id === focusTarget.id)
    )
      return;
    setSignal(null);
    const bounds = boundsFor(focusTarget.id);
    setView((previous) => ({
      ...previous,
      x: bounds.x + bounds.width / 2 - size.width / previous.scale / 2,
      y: bounds.y + bounds.height / 2 - size.height / previous.scale / 2,
    }));
  }, [focusTarget?.id, focusTarget?.token, size.width, size.height, boundsFor]);
  useEffect(() => {
    if (live || !size.width || !size.height) {
      setLoading(false);
      return;
    }
    const ticket = ++generation.current;
    const region = {
      x: Math.floor(view.x),
      y: Math.floor(view.y),
      width: Math.ceil(size.width / view.scale),
      height: Math.ceil(size.height / view.scale),
    };
    const timer = setTimeout(() => {
      setLoading(true);
      const scale = Math.min(
        view.scale * (devicePixelRatio || 1),
        8,
        Math.sqrt(7_000_000 / (region.width * region.height)),
      );
      command<{ image: string }>({
        op: "render",
        ...bindings,
        ...region,
        scale,
      })
        .then((result) => {
          if (ticket === generation.current)
            setImage({
              src: result.image,
              bounds: region,
              revision: doc.revision,
            });
        })
        .catch((e) => {
          if (ticket === generation.current) onError(e);
        })
        .finally(() => {
          if (ticket === generation.current) setLoading(false);
        });
    }, 80);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [
    doc.id,
    doc.revision,
    circuit.name,
    view.x,
    view.y,
    view.scale,
    size.width,
    size.height,
    live,
  ]);
  // The run draws only what the canvas shows, at the canvas's zoom.
  const reported = useRef("");
  useEffect(() => {
    if (!run || !size.width || !size.height) return;
    const timer = setTimeout(() => {
      const area = liveViewport(
        { x: view.x, y: view.y, scale: view.scale },
        size,
      );
      const key = `${run.viewId}:${area.x},${area.y},${area.width},${area.height},${area.scale}`;
      if (reported.current === key) return;
      reported.current = key;
      onViewport(run.viewId, area);
    }, 100);
    return () => clearTimeout(timer);
  }, [run, size.width, size.height, view.x, view.y, view.scale, onViewport]);
  useEffect(() => {
    if (!run) reported.current = "";
  }, [run]);
  useEffect(() => {
    if (tool !== "wire") setWire([]);
  }, [tool]);
  const point = (
    event: { clientX: number; clientY: number },
    grid = true,
  ): Point => {
    const b = container.current!.getBoundingClientRect();
    const quantize = grid ? snap : Math.round;
    return {
      x: quantize((event.clientX - b.left) / view.scale + view.x),
      y: quantize((event.clientY - b.top) / view.scale + view.y),
    };
  };
  const finishWire = () => {
    const points =
      cursor && wire.length
        ? [...wire, ...route(wire[wire.length - 1], cursor).slice(1)]
        : wire;
    if (points.length > 1) commit({ kind: "wire", points }, wireOverlay(points));
    setWire([]);
  };
  const hit = (p: Point) => {
    for (const c of [...circuit.components].reverse()) {
      const b = boundsFor(c.id);
      if (
        p.x >= b.x - 3 &&
        p.x <= b.x + b.width + 3 &&
        p.y >= b.y - 3 &&
        p.y <= b.y + b.height + 3
      )
        return c.id;
    }
    for (const w of circuit.wires) {
      const b = boundsFor(w.id);
      if (
        p.x >= b.x - 4 &&
        p.x <= b.x + b.width + 4 &&
        p.y >= b.y - 4 &&
        p.y <= b.y + b.height + 4
      )
        return w.id;
    }
    return null;
  };
  // A live canvas paints the run's frame over the static picture, keeping the
  // static one until the frame is decoded: no blank in between.
  const picture = frame
    ? { src: frame.url, bounds: frame.image.bounds, live: true }
    : image
      ? { ...image, live: false }
      : null;
  const pendingWire =
    wire.length && cursor
      ? [...wire, ...route(wire[wire.length - 1], cursor).slice(1)]
      : wire;
  return (
    <div
      ref={container}
      className={"canvas tool-" + (heldSpace ? "pan" : tool)}
      tabIndex={0}
      aria-label="电路画布"
      onContextMenu={(e) => {
        e.preventDefault();
        setWire([]);
        if (place) onCancelPlace();
      }}
      onWheel={(e) => {
        const factor = Math.exp(-e.deltaY * 0.002);
        const scale = Math.max(0.05, Math.min(8, view.scale * factor));
        const b = container.current!.getBoundingClientRect();
        const px = e.clientX - b.left,
          py = e.clientY - b.top;
        setView({
          x: view.x + px / view.scale - px / scale,
          y: view.y + py / view.scale - py / scale,
          scale,
        });
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setWire([]);
          wireGesture.current = null;
          setDrag(null);
          setDelta({ x: 0, y: 0 });
          selectObjects([]);
        }
        if (e.key === "Enter" && wire.length) {
          e.preventDefault();
          finishWire();
        }
        if ((e.key === "Delete" || e.key === "Backspace") && selection.length) {
          e.preventDefault();
          commit({ kind: "delete", ids: selection }, deleteOverlay(selection));
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.button !== 1) return;
        e.currentTarget.focus();
        const p = point(e, tool !== "poke");
        setCursor(p);
        const target = hit(p);
        if (e.button === 0 && (e.ctrlKey || e.metaKey) && !spaceHeld.current) {
          e.preventDefault();
          if (wire.length) {
            onError("请先按 Esc 结束连线，再追踪信号");
            return;
          }
          traceAt(point(e, false), target);
          return;
        }
        if (e.button === 1 || tool === "pan" || spaceHeld.current) {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({
            mode: "pan",
            start: p,
            client: { x: e.clientX, y: e.clientY },
            ids: [],
            origin: view,
          });
          return;
        }
        setSignal(null);
        if (place) {
          enqueuePlacement(p);
          return;
        }
        if (tool === "wire") {
          wireGesture.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
          setWire((previous) =>
            previous.length
              ? [
                  ...previous,
                  ...route(previous[previous.length - 1], p).slice(1),
                ]
              : [p],
          );
          return;
        }
        if (tool === "poke" && target) {
          const component = circuit.components.find((c) => c.id === target);
          if (!component) return;
          if (component.name === "Button") {
            held.current = onRelease;
            e.currentTarget.setPointerCapture(e.pointerId);
            onPress(component);
          } else {
            // Inputs take the point clicked; memories open their contents.
            onPoke(component, point(e, false));
          }
          return;
        }
        const ids = target
          ? e.shiftKey
            ? [...new Set([...selection, target])]
            : selection.includes(target)
              ? selection
              : [target]
          : [];
        selectObjects(ids);
        setDelta({ x: 0, y: 0 });
        e.currentTarget.setPointerCapture(e.pointerId);
        const selectedWire =
          ids.length === 1
            ? circuit.wires.find((wire) => wire.id === ids[0])
            : null;
        setDrag({
          axis: selectedWire
            ? selectedWire.from.y === selectedWire.to.y
              ? "x"
              : "y"
            : undefined,
          mode: target ? "move" : "box",
          start: p,
          client: { x: e.clientX, y: e.clientY },
          ids,
          origin: view,
        });
      }}
      onPointerMove={(e) => {
        const p = point(e);
        setCursor(p);
        if (drag?.mode === "pan")
          setView({
            ...drag.origin,
            x: drag.origin.x - (e.clientX - drag.client.x) / drag.origin.scale,
            y: drag.origin.y - (e.clientY - drag.client.y) / drag.origin.scale,
          });
        else if (drag)
          setDelta({
            x: drag.axis === "x" ? 0 : p.x - drag.start.x,
            y: drag.axis === "y" ? 0 : p.y - drag.start.y,
          });
      }}
      onPointerUp={(e) => {
        const gesture = wireGesture.current;
        wireGesture.current = null;
        if (
          gesture &&
          tool === "wire" &&
          wire.length &&
          Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 4
        ) {
          const points = [
            ...wire,
            ...route(wire[wire.length - 1], point(e)).slice(1),
          ];
          if (points.length > 1)
            commit({ kind: "wire", points }, wireOverlay(points));
          setWire([]);
        }
        releaseHeld();
        if (drag?.mode === "move" && overlay && (delta.x || delta.y))
          commit({ kind: "move", ids: drag.ids, delta }, overlay);
        if (drag?.mode === "box") {
          const p = point(e);
          const box = {
            x: Math.min(p.x, drag.start.x),
            y: Math.min(p.y, drag.start.y),
            right: Math.max(p.x, drag.start.x),
            bottom: Math.max(p.y, drag.start.y),
          };
          selectObjects(
            [...circuit.components, ...circuit.wires]
              .filter((item) => {
                const b = boundsFor(item.id);
                return (
                  b.x >= box.x &&
                  b.y >= box.y &&
                  b.x + b.width <= box.right &&
                  b.y + b.height <= box.bottom
                );
              })
              .map((x) => x.id),
          );
        }
        setDrag(null);
        setDelta({ x: 0, y: 0 });
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onLostPointerCapture={releaseHeld}
      onPointerCancel={() => {
        wireGesture.current = null;
        setWire([]);
        releaseHeld();
        setDrag(null);
        setDelta({ x: 0, y: 0 });
      }}
      onDoubleClick={(e) => {
        if (tool === "wire") {
          finishWire();
          return;
        }
        const id = hit(point(e));
        const c = circuit.components.find((c) => c.id === id);
        if (c && !c.library && doc.circuits.some((x) => x.name === c.name))
          onEnterCircuit(c.name, c.id);
        else if (c && ["RAM", "ROM"].includes(c.name)) onOpenMemory(c.id);
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`${view.x} ${view.y} ${size.width / view.scale} ${size.height / view.scale}`}
      >
        <defs>
          <pattern
            id="grid"
            width="10"
            height="10"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="0" cy="0" r={0.55 / view.scale} fill="var(--grid)" />
          </pattern>
        </defs>
        <rect
          x={view.x}
          y={view.y}
          width={size.width / view.scale}
          height={size.height / view.scale}
          fill={showGrid ? "url(#grid)" : "transparent"}
        />
        {picture && (
          <image
            href={picture.src}
            {...picture.bounds}
            preserveAspectRatio="none"
            opacity={overlay?.kind === "move" ? 0.4 : 1}
          />
        )}
        {overlay?.kind === "move" && picture && (
          <g
            className="move-preview"
            pointerEvents="none"
            transform={`translate(${overlay.delta.x},${overlay.delta.y})`}
          >
            <defs>
              <clipPath id={moveClip} clipPathUnits="userSpaceOnUse">
                {overlay.clip.map((bounds) => (
                  <rect
                    key={`${bounds.x},${bounds.y}`}
                    x={bounds.x - 3}
                    y={bounds.y - 3}
                    width={bounds.width + 6}
                    height={bounds.height + 6}
                  />
                ))}
              </clipPath>
            </defs>
            <image
              href={picture.src}
              {...picture.bounds}
              preserveAspectRatio="none"
              clipPath={`url(#${moveClip})`}
            />
          </g>
        )}
        {overlay?.kind === "delete" && (
          <g className="delete-cover" pointerEvents="none" fill="var(--paper)">
            {overlay.clip.map((b) => (
              <rect
                key={`${b.x},${b.y}`}
                x={b.x - 3}
                y={b.y - 3}
                width={b.width + 6}
                height={b.height + 6}
              />
            ))}
            {overlay.lines.map((segment, i) => (
              <line
                key={i}
                x1={segment.from.x}
                y1={segment.from.y}
                x2={segment.to.x}
                y2={segment.to.y}
                stroke="var(--paper)"
                strokeWidth={9}
                strokeLinecap="square"
              />
            ))}
          </g>
        )}
        {overlay && overlay.kind !== "delete" && (
          <g
            className="move-wire-preview"
            pointerEvents="none"
            stroke="var(--accent)"
            strokeWidth={2 / view.scale}
            fill="none"
          >
            {overlay.lines.map((segment, i) => (
              <line
                key={`${i}:${segment.from.x},${segment.from.y}:${segment.to.x},${segment.to.y}`}
                x1={segment.from.x}
                y1={segment.from.y}
                x2={segment.to.x}
                y2={segment.to.y}
                strokeDasharray={segment.dashed ? "4 3" : undefined}
              />
            ))}
          </g>
        )}
        {signal &&
          connections &&
          focus?.wires
            .filter((w) => {
              const bits = w.bundleId
                ? connections.bundles.get(w.bundleId)?.bitNets
                : [];
              return bits?.some(
                (bit) =>
                  bit.netId &&
                  signal.bits.some((selected) => selected.netId === bit.netId),
              );
            })
            .map((wire) => (
              <line
                key={`signal-${wire.wireId}`}
                x1={wire.from.x}
                y1={wire.from.y}
                x2={wire.to.x}
                y2={wire.to.y}
                stroke="var(--accent)"
                strokeWidth={4 / view.scale}
                opacity={0.5}
                pointerEvents="none"
              />
            ))}
        {previews.map((preview) => {
          const ghost = preview.template.children.find(
            (n) => n.tag === "image",
          );
          return (
            <g
              key={preview.key}
              data-placement-state={preview.committed ? "committed" : "pending"}
              transform={`translate(${preview.point.x} ${preview.point.y})`}
              opacity={0.65}
              pointerEvents="none"
            >
              {ghost?.text ? (
                <image
                  href={ghost.text}
                  x={Number(ghost.attributes.x)}
                  y={Number(ghost.attributes.y)}
                  width={Number(ghost.attributes.width)}
                  height={Number(ghost.attributes.height)}
                />
              ) : (
                <circle r={5} fill="var(--accent)" />
              )}
            </g>
          );
        })}
        {[...new Set(pressed ? [pressed, ...pending] : pending)].map((id) => {
          const b = boundsFor(id);
          return (
            <rect
              key={`operated-${id}`}
              className={pressed === id ? "input-pressed" : "input-pending"}
              x={b.x - 3}
              y={b.y - 3}
              width={b.width + 6}
              height={b.height + 6}
              rx={3 / view.scale}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.5 / view.scale}
              strokeDasharray={pressed === id ? undefined : `${4 / view.scale} ${3 / view.scale}`}
              opacity={pressed === id ? 0.9 : 0.55}
              pointerEvents="none"
            />
          );
        })}
        {selection.map((id) => {
          const b = boundsFor(id);
          const offset = drag?.mode === "move" ? delta : { x: 0, y: 0 };
          return (
            <rect
              key={id}
              x={b.x - 4 + offset.x}
              y={b.y - 4 + offset.y}
              width={b.width + 8}
              height={b.height + 8}
              rx={3 / view.scale}
              fill="var(--selection-fill)"
              stroke="var(--accent)"
              strokeWidth={1.4 / view.scale}
            />
          );
        })}
        {tool === "wire" &&
          observed.flatMap((c) =>
            c.ends.map((p) => (
              <circle
                key={c.componentId + ":" + p.index}
                cx={p.location.x}
                cy={p.location.y}
                r={3 / view.scale}
                fill="var(--paper)"
                stroke="var(--accent)"
                strokeWidth={1 / view.scale}
              />
            )),
          )}
        {pendingWire.length > 0 && (
          <polyline
            points={pendingWire.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2 / view.scale}
          />
        )}
        {place && cursor && ghost?.text && (
          <g opacity=".75" transform={`translate(${cursor.x},${cursor.y})`}>
            <image
              href={ghost.text}
              x={Number(ghost.attributes.x)}
              y={Number(ghost.attributes.y)}
              width={Number(ghost.attributes.width)}
              height={Number(ghost.attributes.height)}
            />
            {template?.children
              .filter((n) => n.tag === "port")
              .map((p, i) => (
                <circle
                  key={i}
                  cx={Number(p.attributes.x)}
                  cy={Number(p.attributes.y)}
                  r={2 / view.scale}
                  fill="var(--accent)"
                />
              ))}
          </g>
        )}
        {drag?.mode === "box" && (
          <rect
            x={Math.min(drag.start.x, drag.start.x + delta.x)}
            y={Math.min(drag.start.y, drag.start.y + delta.y)}
            width={Math.abs(delta.x)}
            height={Math.abs(delta.y)}
            fill="var(--selection-fill)"
            stroke="var(--accent)"
            strokeWidth={1 / view.scale}
          />
        )}
      </svg>
      <div className="canvas-status">
        {moving && movePreview.error && (
          <span role="status">{movePreview.error}</span>
        )}
        {loading && <span role="status">正在绘制…</span>}
      </div>
    </div>
  );
}
