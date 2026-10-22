import type { Control } from "../generated/Control";
import type { PortState } from "../generated/PortState";
import type { Signal } from "../generated/Signal";
import type { TraceDelta } from "../generated/TraceDelta";
import type { Bounds, Component, Document } from "./types";

/** A view of the run: the instance the canvas shows while it shows the run. */
export interface Displayed {
  sessionId: string;
  viewId: string;
}

/** A waveform delta applied to the kept samples: a new id starts over, a full
 * delta replaces them, and a delta with dropped samples trims what fell out. */
export function traced(
  previous: TraceDelta | null,
  delta: TraceDelta,
): TraceDelta {
  const samples =
    previous && previous.id === delta.id && !delta.full
      ? [...previous.samples, ...delta.samples]
      : delta.samples;
  return {
    ...delta,
    signals:
      delta.signals.length || !previous || previous.id !== delta.id
        ? delta.signals
        : previous.signals,
    samples: samples.filter((sample) => sample.sample >= delta.dropped),
  };
}

/** How a component of the definition can be operated, before a run says
 * more: the run still decides whether an input is driven by its parent. */
export function inputControl(component: Component): Control | null {
  if (component.name === "Pin" && component.attributes.output !== "true")
    return "input";
  if (component.name === "Clock") return "clock";
  if (component.name === "Button") return "pulse";
  return null;
}

/** A port or input value as the canvas and inspector show it. */
export function formatSignal(port: PortState | Signal | undefined): string {
  if (!port) return "—";
  if (port.value === undefined) {
    const bits = port.bits.replaceAll(" ", "");
    if (/^[xX?]+$/.test(bits)) return `未知 · ${port.width}位`;
    if (/^[Ee]+$/.test(bits)) return `错误 · ${port.width}位`;
    return bits || "未知";
  }
  return port.width === 1
    ? String(port.value)
    : `0x${port.value
        .toString(16)
        .toUpperCase()
        .padStart(Math.ceil(port.width / 4), "0")}`;
}

/** The subcircuit instances from a run's root to one of its views, with the
 * circuit each one is placed in, as the document describes them. An id the
 * document no longer has ends the trail. */
export function instanceTrail(
  doc: Document,
  rootCircuit: string,
  instancePath: string[],
): {
  id: string;
  label: string;
  circuit: string;
  parent: string;
  location: { x: number; y: number };
}[] {
  const trail = [];
  let parent = rootCircuit;
  for (const id of instancePath) {
    const component = doc.circuits
      .find((item) => item.name === parent)
      ?.components.find((item) => item.id === id);
    if (!component) break;
    trail.push({
      id,
      label: component.attributes.label || component.name,
      circuit: component.name,
      parent,
      location: component.location,
    });
    parent = component.name;
  }
  return trail;
}

/** The region and scale a run should draw for the canvas viewport, so the
 * picture stays sharp at any zoom without exceeding the runtime's budget. */
export function liveViewport(
  view: { x: number; y: number; scale: number },
  size: { width: number; height: number },
): Bounds & { scale: number } {
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const margin = 64 / view.scale;
  const x = Math.floor(view.x - margin);
  const y = Math.floor(view.y - margin);
  const width = Math.ceil(size.width / view.scale + 2 * margin) + 1;
  const height = Math.ceil(size.height / view.scale + 2 * margin) + 1;
  const scale = Math.min(
    view.scale * ratio,
    32,
    4095 / width,
    4095 / height,
    Math.sqrt(7_900_000 / (width * height)),
  );
  return { x, y, width, height, scale };
}
