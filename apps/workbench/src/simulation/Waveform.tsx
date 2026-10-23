import { useEffect, useRef, useState } from "react";
import type { TraceDelta } from "../generated/TraceDelta";

const CELL = 28,
  ROW = 32,
  HIGH = 8,
  LOW = 24,
  MIDDLE = 16,
  SLANT = 3,
  DIGIT = 6.7;

/** A sample's bits without the grouping spaces. */
const bitsOf = (value: string | undefined) =>
  (value ?? "?").replaceAll(" ", "");

/** Bits read the way Logisim shows bus values: hex, one digit per four bits;
 * a digit is `x` when all its bits are unknown, `E` on an error and `?` when
 * known and unknown bits mix. */
export function busValue(value: string | undefined) {
  const bits = bitsOf(value);
  if (bits.length <= 1) return bits;
  let text = "";
  for (let end = bits.length; end > 0; end -= 4) {
    const nibble = bits.slice(Math.max(0, end - 4), end);
    text =
      (/^[01]+$/.test(nibble)
        ? parseInt(nibble, 2).toString(16).toUpperCase()
        : nibble.includes("E")
          ? "E"
          : /^x+$/.test(nibble)
            ? "x"
            : "?") + text;
  }
  return text;
}

/** Equal neighbouring samples drawn as one stretch. */
function runs(values: string[]) {
  const out: { start: number; end: number; bits: string }[] = [];
  values.forEach((bits, index) => {
    const last = out.at(-1);
    if (last && last.bits === bits) last.end = index + 1;
    else out.push({ start: index, end: index + 1, bits });
  });
  return out;
}

/** One signal's trace: a line between two levels for a single bit, a band
 * with crossings and values for a bus. */
function Trace({ values, wide }: { values: string[]; wide: boolean }) {
  const stretches = runs(values);
  if (!wide)
    return (
      <>
        {stretches.map(({ start, end, bits }, index) => {
          const level = bits === "1" ? HIGH : bits === "0" ? LOW : MIDDLE;
          const before = stretches[index - 1]?.bits;
          const from =
            before === "1" ? HIGH : before === "0" ? LOW : before ? MIDDLE : level;
          return (
            <path
              key={start}
              className={/^[01]$/.test(bits) ? "trace-known" : "trace-unknown"}
              d={`M${start * CELL},${from} V${level} H${end * CELL}`}
            />
          );
        })}
      </>
    );
  return (
    <>
      {stretches.map(({ start, end, bits }) => {
        const x0 = start * CELL,
          x1 = end * CELL,
          text = busValue(bits),
          span = text.length * DIGIT,
          // Long stretches repeat their value so it stays in view while scrolled.
          step = Math.max(span + 48, 168),
          marks: number[] = [];
        for (let x = x0 + SLANT + 4; x + span <= x1 - SLANT - 2; x += step)
          marks.push(x);
        return (
          <g key={start}>
            <path
              className={/^[01]+$/.test(bits) ? "trace-known" : "trace-unknown"}
              d={`M${x0},${MIDDLE} L${x0 + SLANT},${HIGH} H${x1 - SLANT} L${x1},${MIDDLE} L${x1 - SLANT},${LOW} H${x0 + SLANT} Z`}
            />
            {marks.map((x) => (
              <text key={x} x={x} y={MIDDLE + 4}>
                {text}
              </text>
            ))}
          </g>
        );
      })}
    </>
  );
}

/** The watched signals' samples, as the run delivered them. */
export function Waveform({
  trace,
  labels,
}: {
  trace: TraceDelta;
  labels: Record<string, string>;
}) {
  const { samples, signals } = trace;
  const [cursor, setCursor] = useState<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    setCursor(null);
    following.current = true;
  }, [trace.id]);
  useEffect(() => {
    if (following.current && cursor === null && scroll.current)
      scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, [samples.at(-1)?.sample, cursor]);
  const chosen = samples.find((s) => s.sample === cursor) || samples.at(-1);
  if (!samples.length || !signals.length) return null;
  const at = Math.max(0, samples.indexOf(chosen!));
  const width = Math.max(280, samples.length * CELL);
  return (
    <div className="waveform">
      <div className="waveform-caption">
        <span>
          步骤 {chosen?.sample} · {chosen?.tick} tick
        </span>
        {trace.dropped > 0 && <span>较早的 {trace.dropped} 步已移出窗口</span>}
      </div>
      <div
        className="waveform-scroll"
        ref={scroll}
        onScroll={() => {
          if (scroll.current)
            following.current =
              scroll.current.scrollWidth -
                scroll.current.scrollLeft -
                scroll.current.clientWidth <
              40;
        }}
      >
        <div className="waveform-sheet" style={{ minWidth: width + 160 }}>
          {signals.map((signal, row) => {
            const name = labels[signal.id] || signal.id;
            const value = chosen?.values[row];
            return (
              <div className="waveform-row" key={signal.id}>
                <span className="waveform-label" title={name}>
                  <span>{name}</span>
                  <code>{value === undefined ? "—" : busValue(value)}</code>
                </span>
                <svg
                  width={width}
                  height={ROW}
                  role="img"
                  aria-label={`${name} 波形`}
                  onClick={(event) => {
                    const left = event.currentTarget.getBoundingClientRect().left;
                    const index = Math.floor((event.clientX - left) / CELL);
                    if (samples[index]) setCursor(samples[index].sample);
                  }}
                >
                  <rect
                    className="waveform-cursor"
                    x={at * CELL}
                    width={CELL}
                    height={ROW}
                  />
                  <Trace
                    values={samples.map((sample) => bitsOf(sample.values[row]))}
                    wide={signal.width > 1}
                  />
                </svg>
              </div>
            );
          })}
          <input
            aria-label="波形步骤"
            type="range"
            min={0}
            max={samples.length - 1}
            value={at}
            onChange={(e) => setCursor(samples[Number(e.target.value)].sample)}
          />
        </div>
      </div>
    </div>
  );
}
