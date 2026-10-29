import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SymbolKey } from "../generated/SymbolKey";
import type {
  CatalogTool,
  Circuit,
  Component,
  Document,
  Edit,
  Point,
  Tool,
  XmlNode,
} from "../shared/types";
import { CanvasPicture } from "./CanvasPicture";
import { Connections } from "./Connections";
import { SelectionConnections } from "./SelectionConnections";
import {
  connectionIndex,
  portSignal,
  signalTrace,
  wireSignal,
  type ConnectionFocus,
  type ConnectionPeer,
  type SignalTarget,
} from "./connectivity";
import { fitView, hitTest, insideBox, type View } from "./geometry";
import { buildScene, program, type Frame, type Live } from "./paint";
import { symbolId, templateKey, useSymbols, type SymbolEntry } from "./symbols";
import { useMovePreview } from "./useMovePreview";
import { useConnections, type ConnectionSeeds } from "./useConnections";
import type { PlacementState } from "./usePlacement";
import { usePlacementQueue } from "./usePlacementQueue";

interface Props {
  doc: Document;
  circuit: Circuit;
  tool: Tool;
  selection: string[];
  setSelection: (s: string[]) => void;
  place: CatalogTool | null;
  edit: (e: Edit) => Promise<void>;
  /** The run's picture of the shown instance, as the runtime drew it, when
   * the canvas shows the run rather than the definition. */
  live: Live | null;
  /** Components of the run whose input the user changed, until a frame shows it. */
  pending: string[];
  /** The button held down in the run. */
  pressed: string | null;
  /** Operates a component of the run: the poke tool, a button press and its
   * point, or an open memory. */
  onPoke: (component: Component, point: Point) => void;
  onPress: (component: Component) => void;
  onRelease: () => void;
  onError: (e: unknown) => void;
  /** A picture or connection read was refused because the host's document
   * moved on (another revision exists); read the workspace again. */
  onStale?: () => void;
  fitToken: number;
  zoomRequest?: { token: number; factor: number };
  /** A deletion asked for outside the canvas (the toolbar); committed here
   * like the Delete key, so the objects leave the picture at once. */
  deleteRequest?: { token: number; ids: string[] };
  onZoomChange?: (zoom: number) => void;
  onObservation?: (observation: {
    scope: string;
    focus: ConnectionFocus | null;
  }) => void;
  showGrid?: boolean;
  placement: PlacementState;
  /** Commits a placement; answers with the revision it made. */
  onPlace: (revision: string, edit: Edit) => Promise<{ revision: string }>;
  onCancelPlace: () => void;
  focusTarget?: { id: string; token: number } | null;
  onOpenMemory: (id: string) => void;
  onEnterCircuit: (name: string, id: string) => void;
  onSignalView?: (view: ReactNode) => void;
  onSignalOpen?: () => void;
}

/** What a gesture shows changed before the document does. */
interface Overlay {
  /** Objects not drawn where they are: moved, deleted or rerouted. */
  hide: string[];
  /** Objects drawn displaced by `delta`. */
  move: string[];
  delta: Point;
  /** Wires drawn as if they existed: a committed wire. */
  wires: { from: Point; to: Point }[];
  /** The wires Logisim's move gesture adds for a drag. */
  lines: { from: Point; to: Point }[];
  /** Where the drag leaves an end unconnected, before the move. */
  unconnected: Point[];
}
const still: Point = { x: 0, y: 0 };
const none: Frame["ghosts"] = [];
const snap = (v: number) => Math.round(v / 10) * 10;
const route = (a: Point, b: Point): Point[] =>
  [a, { x: b.x, y: a.y }, b].filter(
    (p, i, arr) => i === 0 || p.x !== arr[i - 1].x || p.y !== arr[i - 1].y,
  );
const segments = (points: Point[]) =>
  points.slice(1).map((to, i) => ({ from: points[i], to }));

export function Canvas({
  doc,
  circuit,
  tool,
  selection,
  setSelection,
  place,
  edit,
  live,
  pending,
  pressed,
  onPoke,
  onPress,
  onRelease,
  onError,
  onStale,
  fitToken,
  zoomRequest,
  deleteRequest,
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
  const [view, setView] = useState<View>({ x: -40, y: -40, scale: 1 });
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
  const template = placement.template;
  const [heldSpace, setHeldSpace] = useState(false);
  const spaceHeld = useRef(false);
  const stale = () => onStale?.();
  const { previews, enqueue } = usePlacementQueue({
    doc,
    circuit,
    place,
    placement,
    onPlace,
    onCancelPlace,
    onError,
  });

  // The picture: every kind's recorded drawing, asked for once per document.
  const ghostKey = place ? templateKey(template) : null;
  const extra = useMemo(() => {
    const keys = new Map<string, SymbolKey>();
    for (const key of [
      ghostKey,
      ...previews.map((p) => templateKey(p.template)),
    ])
      if (key) keys.set(symbolId(key), key);
    return [...keys.values()];
  }, [ghostKey, previews]);
  const symbols = useSymbols(doc, circuit, extra, onError, stale);
  // A component whose new kind is still being asked for keeps its last picture.
  const lastDrawn = useRef(
    new Map<string, { kind: string; entry: SymbolEntry }>(),
  );
  const scene = useMemo(() => {
    const previous = lastDrawn.current;
    const next = new Map<string, { kind: string; entry: SymbolEntry }>();
    const built = buildScene(
      circuit,
      (component) => {
        const kind = `${component.library ?? ""}\n${component.name}`;
        const kept = previous.get(component.id);
        const entry =
          symbols.get(component) ??
          (kept?.kind === kind ? kept.entry : undefined) ??
          symbols.latest(component);
        if (entry) next.set(component.id, { kind, entry });
        return entry;
      },
      symbols.widthErrors,
    );
    lastDrawn.current = next;
    return built;
    // `symbols.version` changes with every answer.
  }, [doc, circuit, symbols.version, symbols.widthErrors]);
  // The first picture of a circuit waits until all its kinds are known.
  const shown = useRef(false);
  if (symbols.ready) shown.current = true;

  const [signal, setSignal] = useState<SignalTarget | null>(null);
  /** A Ctrl+click: the ports within `radius` of `point`, else object `id`. */
  const [traceRequest, setTraceRequest] = useState<{
    point: Point;
    radius: number;
    id: string | null;
    scope: string;
  } | null>(null);
  // The selection's connections and a traced click's are read; a traced
  // signal's nets are already in what was read.
  const seeds = useMemo((): ConnectionSeeds => {
    const wires = new Set(circuit.wires.map((w) => w.id));
    const components = new Set(circuit.components.map((c) => c.id));
    const ids = [...new Set([...selection, traceRequest?.id ?? ""])];
    const { point, radius } = traceRequest ?? {};
    return {
      components: ids.filter((id) => components.has(id)),
      wires: ids.filter((id) => wires.has(id)),
      // The runtime takes whole points; a wider radius keeps every port near the click.
      point:
        point && radius
          ? {
              x: Math.round(point.x),
              y: Math.round(point.y),
              radius: radius + 1,
            }
          : null,
    };
  }, [circuit, selection.join(","), traceRequest]);
  const observation = useConnections(doc, circuit, seeds, onError, stale);
  const { scope: observationScope, focus } = observation;
  useEffect(() => {
    onObservation?.({ scope: observationScope, focus });
  }, [onObservation, observationScope, focus]);
  const connections = useMemo(
    () => (focus ? connectionIndex(focus) : null),
    [focus],
  );
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
    { view: View; selection: string[]; signal: SignalTarget | null }[]
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
    origin: View;
  } | null>(null);
  const [delta, setDelta] = useState<Point>(still);
  // Shift while dragging moves without keeping connections, as in Logisim.
  const [detach, setDetach] = useState(false);
  const moving = drag?.mode === "move" && Boolean(delta.x || delta.y);
  const movePreview = useMovePreview(
    moving && !detach
      ? {
          id: doc.id,
          revision: doc.revision,
          circuit: circuit.name,
          ids: drag.ids,
          delta,
        }
      : null,
  );
  const dragOverlay = useMemo<Overlay | null>(
    () =>
      moving && drag
        ? {
            hide: [...drag.ids, ...(movePreview?.removed ?? [])],
            move: drag.ids,
            delta,
            wires: [],
            lines: movePreview?.added ?? [],
            unconnected: movePreview?.unconnected ?? [],
          }
        : null,
    [moving, drag, delta, movePreview],
  );
  // A committed edit shows its result until the document has it.
  const [gesture, setGesture] = useState<
    (Overlay & { key: number; from: string }) | null
  >(null);
  const gestureKey = useRef(0);
  const overlay =
    dragOverlay ?? (gesture?.from === doc.revision ? gesture : null);
  const commit = (change: Edit, result: Overlay) => {
    const key = ++gestureKey.current;
    setGesture({ ...result, key, from: doc.revision });
    const done = () => setGesture((g) => (g?.key === key ? null : g));
    edit(change).then(done, (e) => {
      done();
      onError(e);
    });
  };
  const commitWire = (points: Point[]) =>
    commit(
      { kind: "wire", points },
      {
        hide: [],
        move: [],
        delta: still,
        wires: segments(points),
        lines: [],
        unconnected: [],
      },
    );
  const commitDelete = (ids: string[]) =>
    commit(
      { kind: "delete", ids },
      {
        hide: ids,
        move: [],
        delta: still,
        wires: [],
        lines: [],
        unconnected: [],
      },
    );
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
  useEffect(() => {
    if (!container.current) return;
    const ro = new ResizeObserver(([e]) =>
      setSize({ width: e.contentRect.width, height: e.contentRect.height }),
    );
    ro.observe(container.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setWire([]);
    wireGesture.current = null;
    setDrag(null);
    setDelta(still);
    releaseRef.current();
    setSignal(null);
    setSignalHistory([]);
    setTraceRequest(null);
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

  // The frame the canvas paints: the scene, what gestures show changed, ghosts.
  const ghostOf = (node: XmlNode | null) => {
    const key = templateKey(node);
    const entry = key ? (symbols.get(key) ?? symbols.latest(key)) : undefined;
    return entry?.picture ? program(entry.picture) : null;
  };
  const ghostAt = place ? cursor : null;
  const ghostProgram = place ? ghostOf(template) : null;
  const ghosts = useMemo(() => {
    const list: Frame["ghosts"] = [];
    for (const preview of previews) {
      const ghost = ghostOf(preview.template);
      if (ghost)
        list.push({
          program: ghost,
          x: preview.point.x,
          y: preview.point.y,
          alpha: 0.65,
        });
    }
    if (ghostAt && ghostProgram)
      list.push({
        program: ghostProgram,
        x: ghostAt.x,
        y: ghostAt.y,
        alpha: 0.75,
      });
    return list.length ? list : none;
  }, [previews, ghostAt, ghostProgram, symbols.version]);
  const paintable = shown.current;
  const pictureFrame = useMemo<Frame>(() => {
    const moved = overlay?.move.length ? new Set(overlay.move) : null;
    return {
      view,
      width: size.width,
      height: size.height,
      scene: paintable ? scene : null,
      hidden: new Set(overlay?.hide),
      moved:
        moved && overlay
          ? {
              delta: overlay.delta,
              parts: scene.parts.filter((p) => moved.has(p.id)),
              wires: scene.wires.filter((w) => moved.has(w.id)),
            }
          : null,
      added: overlay?.wires ?? [],
      ghosts,
      live,
    };
  }, [view, size, scene, paintable, overlay, ghosts, live]);

  const visitSignal = (peer: ConnectionPeer, previousSignal = signal) => {
    const component = circuit.components.find(
      (c) => c.id === peer.component.componentId,
    );
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
    const reading = !observation.ready && !observation.error;
    const panel =
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
          focus={reading ? null : focus}
          circuit={circuit}
          selection={selection}
          error={observation.error}
          onVisit={visitSignal}
          onTrace={(target) => startSignal(target, false)}
          onBack={signalHistory.length ? signalBack : undefined}
        />
      );
    // A selection's connections take a moment to read; the panel says so
    // only when that takes long, and keeps what it showed until then.
    if (!(signal && connections) && selection.length && reading) {
      const timer = setTimeout(() => onSignalView?.(panel), 200);
      return () => clearTimeout(timer);
    }
    onSignalView?.(panel);
  }, [
    signal,
    connections,
    signalHistory,
    view,
    selection.join(","),
    onSignalView,
    focus,
    circuit,
    observation.ready,
    observation.error,
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
  const traceAt = (p: Point, id: string | null, radius: number) => {
    if (!connections || !focus) {
      onError("未读取到此信号的连接信息");
      return;
    }
    const near = focus.components
      .flatMap((component) =>
        component.ends.map((end) => ({
          component,
          end,
          distance: Math.hypot(p.x - end.location.x, p.y - end.location.y),
        })),
      )
      .filter((port) => port.distance <= radius)
      .sort((a, b) => a.distance - b.distance)[0];
    if (near) {
      startSignal(portSignal(near.component, near.end));
      return;
    }
    const component = focus.components.find((c) => c.componentId === id);
    if (component?.ends.length === 1) {
      startSignal(portSignal(component, component.ends[0]));
      return;
    }
    const wire = focus.wires.find((w) => w.wireId === id);
    if (wire) {
      startSignal(wireSignal(connections, wire));
      return;
    }
    if (component) {
      selectObjects([id!]);
      onError("请选择要追踪的端口");
    }
  };
  // A trace runs once the connections around the click are read.
  useEffect(() => {
    if (!traceRequest) return;
    if (traceRequest.scope !== observationScope || observation.error) {
      setTraceRequest(null);
      return;
    }
    if (!observation.ready) return;
    setTraceRequest(null);
    traceAt(traceRequest.point, traceRequest.id, traceRequest.radius);
  }, [traceRequest, observation.ready, observationScope, observation.error]);
  // A circuit opens fitted; until its view is moved, the fit follows the
  // canvas size as the layout around it settles.
  const fitted = useRef<{ scope: string; size: string; view: View } | null>(
    null,
  );
  const shownView = useRef(view);
  shownView.current = view;
  useLayoutEffect(() => {
    const fitScope = `${doc.id}:${circuit.name}:${fitToken}`;
    const sized = `${size.width}x${size.height}`;
    const last = fitted.current;
    if (
      size.width < 2 ||
      size.height < 2 ||
      !symbols.ready ||
      (last?.scope === fitScope &&
        (last.size === sized || last.view !== shownView.current))
    )
      return;
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
    const next = fitView(scene, size, { top, bottom }) ?? {
      x: -40,
      y: -40,
      scale: 1,
    };
    fitted.current = { scope: fitScope, size: sized, view: next };
    setView(next);
  }, [doc.id, circuit.name, fitToken, size, symbols.ready, scene]);
  useEffect(() => {
    const bounds = focusTarget && scene.bounds.get(focusTarget.id);
    if (!bounds || !size.width || !size.height) return;
    setSignal(null);
    setView((previous) => ({
      ...previous,
      x: bounds.x + bounds.width / 2 - size.width / previous.scale / 2,
      y: bounds.y + bounds.height / 2 - size.height / previous.scale / 2,
    }));
  }, [focusTarget?.id, focusTarget?.token, size.width, size.height, scene]);
  const lastDelete = useRef(deleteRequest?.token);
  useEffect(() => {
    if (!deleteRequest || lastDelete.current === deleteRequest.token) return;
    lastDelete.current = deleteRequest.token;
    if (deleteRequest.ids.length) commitDelete(deleteRequest.ids);
  }, [deleteRequest]);
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
    if (points.length > 1) commitWire(points);
    setWire([]);
  };
  const hit = (p: Point) => hitTest(scene, circuit, p);
  const pendingWire =
    wire.length && cursor
      ? [...wire, ...route(wire[wire.length - 1], cursor).slice(1)]
      : wire;
  const viewBox = `${view.x} ${view.y} ${size.width / view.scale} ${size.height / view.scale}`;
  const right = view.x + size.width / view.scale,
    bottom = view.y + size.height / view.scale;
  const onScreen = (p: Point) =>
    p.x >= view.x && p.x <= right && p.y >= view.y && p.y <= bottom;
  const displaced = overlay?.move.length ? new Set(overlay.move) : null;
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
          setDelta(still);
          selectObjects([]);
        }
        if (e.key === "Enter" && wire.length) {
          e.preventDefault();
          finishWire();
        }
        if ((e.key === "Delete" || e.key === "Backspace") && selection.length) {
          e.preventDefault();
          commitDelete(selection);
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
          setTraceRequest({
            point: point(e, false),
            radius: Math.max(5, 7 / view.scale),
            id: target,
            scope: observationScope,
          });
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
          enqueue(p);
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
        setDelta(still);
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
        else if (drag) {
          setDelta({
            x: drag.axis === "x" ? 0 : p.x - drag.start.x,
            y: drag.axis === "y" ? 0 : p.y - drag.start.y,
          });
          setDetach(e.shiftKey);
        }
      }}
      onPointerLeave={() => {
        if (place && !drag) setCursor(null);
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
          if (points.length > 1) commitWire(points);
          setWire([]);
        }
        releaseHeld();
        if (drag?.mode === "move" && dragOverlay)
          commit(
            {
              kind: "move",
              ids: drag.ids,
              delta,
              ...(e.shiftKey ? { detach: true } : {}),
            },
            e.shiftKey
              ? { ...dragOverlay, hide: drag.ids, lines: [], unconnected: [] }
              : dragOverlay,
          );
        if (drag?.mode === "box") {
          const p = point(e);
          selectObjects(
            insideBox(scene, circuit, {
              x: Math.min(p.x, drag.start.x),
              y: Math.min(p.y, drag.start.y),
              right: Math.max(p.x, drag.start.x),
              bottom: Math.max(p.y, drag.start.y),
            }),
          );
        }
        setDrag(null);
        setDelta(still);
        setDetach(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onLostPointerCapture={releaseHeld}
      onPointerCancel={() => {
        wireGesture.current = null;
        setWire([]);
        releaseHeld();
        setDrag(null);
        setDelta(still);
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
        className="canvas-grid"
        width="100%"
        height="100%"
        viewBox={viewBox}
        aria-hidden="true"
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
      </svg>
      <CanvasPicture frame={pictureFrame} />
      <svg width="100%" height="100%" viewBox={viewBox}>
        {overlay && overlay.lines.length > 0 && (
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
              />
            ))}
          </g>
        )}
        {overlay && overlay.unconnected.length > 0 && (
          <g
            className="move-unconnected"
            pointerEvents="none"
            fill="var(--danger)"
          >
            {overlay.unconnected.flatMap((at) =>
              [at, { x: at.x + overlay.delta.x, y: at.y + overlay.delta.y }].map(
                (p, i) => (
                  <circle key={`${at.x},${at.y}:${i}`} cx={p.x} cy={p.y} r={3} />
                ),
              ),
            )}
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
        {previews.map((preview) => (
          <g
            key={preview.key}
            data-placement-state={preview.committed ? "committed" : "pending"}
            transform={`translate(${preview.point.x} ${preview.point.y})`}
            pointerEvents="none"
          >
            {!ghostOf(preview.template) && (
              <circle r={5} fill="var(--accent)" opacity={0.65} />
            )}
          </g>
        ))}
        {[...new Set(pressed ? [pressed, ...pending] : pending)].map((id) => {
          const b = scene.bounds.get(id);
          if (!b) return null;
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
              strokeDasharray={
                pressed === id
                  ? undefined
                  : `${4 / view.scale} ${3 / view.scale}`
              }
              opacity={pressed === id ? 0.9 : 0.55}
              pointerEvents="none"
            />
          );
        })}
        {selection.map((id) => {
          const b = scene.bounds.get(id);
          if (!b) return null;
          const offset = displaced?.has(id) ? overlay!.delta : still;
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
          scene.ports
            .filter(onScreen)
            .map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={3 / view.scale}
                fill="var(--paper)"
                stroke="var(--accent)"
                strokeWidth={1 / view.scale}
              />
            ))}
        {pendingWire.length > 0 && (
          <polyline
            points={pendingWire.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2 / view.scale}
          />
        )}
        {place && cursor && template && (
          <g transform={`translate(${cursor.x},${cursor.y})`}>
            {template.children
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
    </div>
  );
}
