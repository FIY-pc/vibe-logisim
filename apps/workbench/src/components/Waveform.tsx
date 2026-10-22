import { useEffect, useRef, useState } from "react";
import type { TraceDelta } from "../generated/TraceDelta";

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
  const chosen =
    samples.find((s) => s.sample === cursor) || samples.at(-1);
  if (!samples.length || !signals.length) return null;
  const cell = 28,
    width = Math.max(280, samples.length * cell);
  return (
    <div className="waveform">
      <div className="waveform-caption">
        <span>
          步骤 {chosen?.sample} · {chosen?.tick} tick
        </span>
        {trace.dropped > 0 && (
          <span>较早的 {trace.dropped} 步已移出窗口</span>
        )}
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
        <div style={{ minWidth: width + 150 }}>
          {signals.map((signal, row) => (
            <div className="waveform-row" key={signal.id}>
              <span title={labels[signal.id]}>
                {labels[signal.id] || signal.id}
                <code>{chosen?.values[row] || "—"}</code>
              </span>
              <svg
                width={width}
                height={36}
                role="img"
                aria-label={`${labels[signal.id] || signal.id} 波形`}
              >
                {samples.map((sample, i) => {
                  const bits = (sample.values[row] || "?").replaceAll(" ", ""),
                    previous = (samples[i - 1]?.values[row] || bits).replaceAll(
                      " ",
                      "",
                    );
                  const y = bits === "1" ? 7 : bits === "0" ? 28 : 18,
                    oldY = previous === "1" ? 7 : previous === "0" ? 28 : 18;
                  return (
                    <g key={sample.sample} onClick={() => setCursor(sample.sample)}>
                      <title>{`步骤 ${sample.sample}, ${sample.tick} tick: ${bits}`}</title>
                      <rect
                        x={i * cell}
                        y={0}
                        width={cell}
                        height={36}
                        fill={sample === chosen ? "#536cba20" : "transparent"}
                      />
                      <path
                        d={`M${i * cell},${oldY} V${y} H${(i + 1) * cell}`}
                        fill="none"
                        stroke={/^[01]+$/.test(bits) ? "#4c856e" : "#bd722d"}
                      />
                      {bits.length !== 1 || !/^[01]$/.test(bits) ? (
                        <text x={i * cell + 3} y={15}>
                          {/^[01]{2,32}$/.test(bits)
                            ? parseInt(bits, 2).toString(16).toUpperCase()
                            : bits}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>
          ))}
          <input
            aria-label="波形步骤"
            type="range"
            min={0}
            max={samples.length - 1}
            value={Math.max(0, samples.indexOf(chosen!))}
            onChange={(e) =>
              setCursor(samples[Number(e.target.value)].sample)
            }
          />
        </div>
      </div>
    </div>
  );
}
