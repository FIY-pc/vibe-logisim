import { Eye } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  Circuit,
  Document,
  Edit,
  Simulation,
  XmlNode,
} from "../lib/types";
import { command } from "../lib/transport";
interface Props {
  doc: Document;
  circuit: Circuit;
  selection: string[];
  edit: (e: Edit) => Promise<void>;
  simulation: Simulation | null;
  simulate: (op: string, attrs?: Record<string, string>) => Promise<void>;
  onError: (e: unknown) => void;
  onOpenMemory: (id: string) => void;
}
export function Inspector({
  doc,
  circuit,
  selection,
  edit,
  simulation,
  simulate,
  onError,
  onOpenMemory,
}: Props) {
  const selected = circuit.components.find((c) => c.id === selection[0]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<XmlNode[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setFields([]);
    setValues({});
    if (!selected) return;
    let live = true;
    setLoading(true);
    void command<XmlNode>({
      op: "properties",
      id: doc.id,
      revision: doc.revision,
      circuit: circuit.name,
      component: selected.id,
    })
      .then((result) => {
        if (live) {
          const attrs = result.children.filter((n) => n.tag === "attribute");
          setFields(attrs);
          setValues(
            Object.fromEntries(
              attrs.map((a) => [a.attributes.name, a.attributes.value]),
            ),
          );
        }
      })
      .catch((e) => {
        if (live) onError(e);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [doc.id, doc.revision, circuit.name, selected?.id]);
  const changes = Object.fromEntries(
    fields
      .filter(
        (f) =>
          f.attributes.editable === "true" &&
          values[f.attributes.name] !== f.attributes.value,
      )
      .map((f) => [f.attributes.name, values[f.attributes.name]]),
  );
  const trace = simulation?.frame.children.find((n) => n.tag === "trace");
  const watched =
    trace?.children
      .filter((n) => n.tag === "signal")
      .map((n) => n.attributes.key) || [];
  const watchButton = (id: string, label: string, port: string) => (
    <button
      aria-label={`观察 ${label} 端口 ${port}`}
      title="观察信号"
      aria-pressed={watched.includes(`${id}:${port}`)}
      disabled={watchPending}
      onClick={() => void toggleWatch(`${id}:${port}`)}
    >
      <Eye size={13} />
    </button>
  );
  const [watchPending, setWatchPending] = useState(false);
  const toggleWatch = async (key: string) => {
    if (!simulation || watchPending) return;
    setWatchPending(true);
    try {
      await simulate("trace", {
        viewId: simulation.viewId,
        signals: (watched.includes(key)
          ? watched.filter((k) => k !== key)
          : [...watched, key]
        ).join(","),
      });
    } catch (e) {
      onError(e);
    } finally {
      setWatchPending(false);
    }
  };
  const signals =
    simulation?.frame.children.filter((n) => n.tag === "component") || [];
  return (
    <div className="inspector">
      {selected ? (
        <>
          <div className="panel-heading">
            {selected.attributes.label || selected.name}
          </div>
          {["RAM", "ROM"].includes(selected.name) && (
            <button
              className="small-button"
              onClick={() => onOpenMemory(selected.id)}
            >
              查看内容
            </button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void edit({
                kind: "attributes",
                id: selected.id,
                values: changes,
              }).catch(onError);
            }}
          >
            {loading && (
              <div role="status" className="muted">
                正在读取属性…
              </div>
            )}
            {fields
              .filter((f) => f.attributes.editable === "true")
              .map((field) => {
                const key = field.attributes.name,
                  value = values[key] || "";
                const options = field.children.filter(
                  (n) => n.tag === "option",
                );
                return (
                  <label key={key}>
                    <span>{field.attributes.label || key}</span>
                    {options.length ? (
                      <select
                        value={value}
                        onChange={(e) =>
                          setValues({ ...values, [key]: e.target.value })
                        }
                      >
                        {options.map((o) => (
                          <option
                            key={o.attributes.value}
                            value={o.attributes.value}
                          >
                            {o.attributes.label || o.attributes.value}
                          </option>
                        ))}
                      </select>
                    ) : value.includes("\n") || key === "contents" ? (
                      <textarea
                        rows={6}
                        value={value}
                        onChange={(e) =>
                          setValues({ ...values, [key]: e.target.value })
                        }
                      />
                    ) : (
                      <input
                        value={value}
                        onChange={(e) =>
                          setValues({ ...values, [key]: e.target.value })
                        }
                      />
                    )}
                  </label>
                );
              })}
            <button
              className="small-button"
              type="submit"
              disabled={loading || !Object.keys(changes).length}
            >
              应用
            </button>
          </form>
        </>
      ) : (
        <div className="quiet-empty">
          {selection.length
            ? `已选择 ${selection.length} 个对象`
            : "选择元件以查看属性"}
        </div>
      )}
      {simulation && (
        <>
          <div className="panel-heading">
            信号 <span>{simulation.frame.attributes.ticks || 0} ticks</span>
          </div>
          <div className="signals">
            {signals.map((signal) => {
              const c = circuit.components.find(
                (c) => c.id === signal.attributes.id,
              );
              if (!c) return null;
              const input = signal.children.find((n) => n.tag === "input");
              const ports = signal.children.filter((n) => n.tag === "port");
              if (!ports.length) return null;
              const output = ports.length === 1 ? ports[0] : null;
              return (
                <div className="signal-block" key={c.id}>
                  <div className="signal">
                    <span>{c.attributes.label || c.name}</span>
                    {signal.attributes.control === "input" ? (
                      <input
                        aria-label={(c.attributes.label || c.name) + " 输入"}
                        key={c.id + input?.attributes.bits}
                        defaultValue={input?.attributes.bits || "0"}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        onBlur={(e) => {
                          if (e.currentTarget.value !== input?.attributes.bits)
                            void simulate("input", {
                              componentId: c.id,
                              bits: e.currentTarget.value,
                            }).catch(onError);
                        }}
                      />
                    ) : signal.attributes.control === "pulse" ? (
                      <HeldButton
                        simulate={simulate}
                        componentId={c.id}
                        viewId={simulation.viewId}
                        onError={onError}
                      />
                    ) : output ? (
                      <code>{output.attributes.bits}</code>
                    ) : null}
                    {output &&
                      watchButton(
                        c.id,
                        c.attributes.label || c.name,
                        output.attributes.index,
                      )}
                  </div>
                  {ports.length > 1 && (
                    <div className="signal-ports">
                      {signal.children
                        .filter((n) => n.tag === "port")
                        .map((port) => {
                          const key = `${c.id}:${port.attributes.index}`;
                          return (
                            <div key={key}>
                              <code>
                                {port.attributes.index}: {port.attributes.bits}
                              </code>
                              <button
                                aria-label={`观察 ${c.attributes.label || c.name} 端口 ${port.attributes.index}`}
                                title="观察信号"
                                aria-pressed={watched.includes(key)}
                                disabled={watchPending}
                                onClick={() => void toggleWatch(key)}
                              >
                                <Eye size={13} />
                              </button>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function HeldButton({
  simulate,
  componentId,
  viewId,
  onError,
}: {
  simulate: Props["simulate"];
  componentId: string;
  viewId: string;
  onError: Props["onError"];
}) {
  const down = useRef(false),
    [pressed, setPressed] = useState(false);
  const release = () => {
    if (!down.current) return;
    down.current = false;
    setPressed(false);
    void simulate("button-release", { componentId, viewId, value: "0" }).catch(
      onError,
    );
  };
  const press = () => {
    if (down.current) return;
    down.current = true;
    setPressed(true);
    void simulate("button", { componentId, viewId, value: "1" }).catch((e) => {
      release();
      onError(e);
    });
  };
  useEffect(() => {
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("blur", release);
      release();
    };
  }, [componentId, viewId]);
  return (
    <button
      aria-pressed={pressed}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onBlur={release}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          press();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          release();
        }
      }}
    >
      {pressed ? "松开" : "按下"}
    </button>
  );
}
