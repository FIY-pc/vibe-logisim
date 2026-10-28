import type { PortState } from "../generated/PortState";
import type { Signal } from "../generated/Signal";
import type { TraceDelta } from "../generated/TraceDelta";

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
