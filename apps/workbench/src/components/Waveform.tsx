import { useEffect, useRef, useState } from "react";
import type { XmlNode } from "../lib/types";
export function Waveform({
  trace,
  labels,
}: {
  trace: XmlNode;
  labels: Record<string, string>;
}) {
  const samples = trace.children.filter((n) => n.tag === "sample"),
    signals = trace.children.filter((n) => n.tag === "signal");
  const [cursor, setCursor] = useState<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    setCursor(null);
    following.current = true;
  }, [trace.attributes.id]);
  useEffect(() => {
    if (following.current && cursor === null && scroll.current)
      scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, [samples.at(-1)?.attributes.sequence, cursor]);
  const chosen =
    samples.find((s) => Number(s.attributes.sequence) === cursor) ||
    samples.at(-1);
  if (!samples.length || !signals.length) return null;
  const cell = 28,
    width = Math.max(280, samples.length * cell);
  const values = samples.map((s) => (s.text || "").split("|"));
  return (
    <div className="waveform">
      <div className="waveform-caption">
        <span>
          步骤 {chosen?.attributes.sequence} · {chosen?.attributes.tick} tick
        </span>
        {Number(trace.attributes.dropped) > 0 && (
          <span>较早的 {trace.attributes.dropped} 步已移出窗口</span>
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
            <div className="waveform-row" key={signal.attributes.key}>
              <span title={labels[signal.attributes.key]}>
                {labels[signal.attributes.key] || signal.attributes.key}
                <code>{(chosen?.text || "").split("|")[row] || "—"}</code>
              </span>
              <svg
                width={width}
                height={36}
                role="img"
                aria-label={`${labels[signal.attributes.key] || signal.attributes.key} 波形`}
              >
                {samples.map((sample, i) => {
                  const bits = (values[i][row] || "?").replaceAll(" ", ""),
                    previous = (values[i - 1]?.[row] || bits).replaceAll(
                      " ",
                      "",
                    );
                  const y = bits === "1" ? 7 : bits === "0" ? 28 : 18,
                    oldY = previous === "1" ? 7 : previous === "0" ? 28 : 18;
                  return (
                    <g
                      key={sample.attributes.sequence}
                      onClick={() =>
                        setCursor(Number(sample.attributes.sequence))
                      }
                    >
                      <title>{`步骤 ${sample.attributes.sequence}, ${sample.attributes.tick} tick: ${bits}`}</title>
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
              setCursor(
                Number(samples[Number(e.target.value)].attributes.sequence),
              )
            }
          />
        </div>
      </div>
    </div>
  );
}
