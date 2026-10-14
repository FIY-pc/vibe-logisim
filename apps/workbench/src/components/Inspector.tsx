import { Eye } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  Circuit,
  Document,
  Edit,
  Simulation,
  XmlNode,
} from "../lib/types";
import type { ConnectionComponent } from "../lib/connections";
import { portName } from "../lib/connections";
import { componentLabels, isAppearanceProperty } from "../lib/componentLabels";
import { command } from "../lib/transport";
import { inputBits, inputDisplay } from "../lib/simulationInputs";
import { PropertyField } from "./PropertyField";
import "./inspector.css";

interface Props {
  doc: Document;
  circuit: Circuit;
  selection: string[];
  edit: (e: Edit) => Promise<void>;
  simulation: Simulation | null;
  simulate: (op: string, attrs?: Record<string, string>) => Promise<void>;
  onError: (e: unknown) => void;
  onOpenMemory: (id: string) => void;
  connectionComponent?: ConnectionComponent | null;
}
export function Inspector(props: Props) {
  const { doc, circuit, selection } = props;
  const selected =
    selection.length === 1
      ? circuit.components.find((c) => c.id === selection[0])
      : undefined;
  const wires = circuit.wires.filter((w) => selection.includes(w.id));
  const count = circuit.components.filter((c) =>
    selection.includes(c.id),
  ).length;
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  return (
    <div className="inspector">
      {selected ? (
        <SelectedInspector
          {...props}
          selected={selected}
          key={`${doc.id}:${doc.revision}:${circuit.name}:${selected.id}`}
          appearanceOpen={appearanceOpen}
          setAppearanceOpen={setAppearanceOpen}
        />
      ) : selection.length ? (
        <>
          <div className="panel-heading">
            {[
              count && `${count} 个元件`,
              wires.length && `${wires.length} 段导线`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <div className="inspector-content selected-wire-details">
            {wires.slice(0, 8).map((w) => (
              <p key={w.id}>
                ({w.from.x}, {w.from.y}) → ({w.to.x}, {w.to.y})
              </p>
            ))}
            {wires.length > 8 && <p>另有 {wires.length - 8} 段导线</p>}
          </div>
        </>
      ) : (
        <div className="quiet-empty">选择元件或导线以查看属性</div>
      )}
    </div>
  );
}

function SelectedInspector({
  doc,
  circuit,
  selected,
  edit,
  simulation,
  simulate,
  onError,
  onOpenMemory,
  connectionComponent,
  appearanceOpen,
  setAppearanceOpen,
}: Props & {
  selected: Circuit["components"][number];
  appearanceOpen: boolean;
  setAppearanceOpen: (value: boolean) => void;
}) {
  const [fields, setFields] = useState<XmlNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError("");
    void command<XmlNode>({
      op: "properties",
      id: doc.id,
      revision: doc.revision,
      circuit: circuit.name,
      component: selected.id,
    })
      .then((result) => {
        if (live)
          setFields(result.children.filter((n) => n.tag === "attribute"));
      })
      .catch((error) => {
        if (live)
          setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [doc.id, doc.revision, circuit.name, selected.id, retry]);
  const live = simulation?.frame.children.find(
    (n) =>
      n.tag === "component" &&
      [selected.id, connectionComponent?.componentId].includes(n.attributes.id),
  );
  const input = live?.children.find((n) => n.tag === "input");
  const ports = live?.children.filter((n) => n.tag === "port") || [];
  const trace = simulation?.frame.children.find((n) => n.tag === "trace");
  const watched =
    trace?.children
      .filter((n) => n.tag === "signal")
      .map((n) => n.attributes.key) || [];
  const [watchPending, setWatchPending] = useState(false);
  const nativeId =
    live?.attributes.id || connectionComponent?.componentId || selected.id;
  const toggleWatch = async (port: string) => {
    if (!simulation || watchPending) return;
    const key = `${nativeId}:${port}`;
    setWatchPending(true);
    try {
      await simulate("trace", {
        viewId: simulation.viewId,
        signals: (watched.includes(key)
          ? watched.filter((k) => k !== key)
          : [...watched, key]
        ).join(","),
      });
    } catch (error) {
      onError(error);
    } finally {
      setWatchPending(false);
    }
  };
  const attributes = fields
    .filter((f) => f.attributes.name !== "contents")
    .sort(
      (a, b) =>
        Number(b.attributes.name === "label") -
        Number(a.attributes.name === "label"),
    );
  const renderField = (field: XmlNode) => (
    <PropertyField
      key={field.attributes.name}
      field={field}
      disabled={loading}
      onCommit={(value) =>
        edit({
          kind: "attributes",
          id: selected.id,
          values: { [field.attributes.name]: value },
        })
      }
    />
  );
  const appearance = attributes.filter((f) =>
    isAppearanceProperty(f.attributes.name),
  );
  const isInput =
    live?.attributes.control === "input" ||
    (!live && selected.name === "Pin" && selected.attributes.output !== "true");
  const title =
    selected.attributes.label ||
    componentLabels[selected.name] ||
    selected.name;
  const subtitle = componentLabels[selected.name] || selected.name;
  const ends = connectionComponent?.ends || [];
  const valueOf = (name: string) =>
    fields.find((f) => f.attributes.name === name)?.attributes.value ||
    selected.attributes[name];
  return (
    <>
      <div
        className="panel-heading"
        title={`${circuit.name} › ${selected.name} · (${selected.location.x}, ${selected.location.y})`}
      >
        {title}
      </div>
      <div className="inspector-content">
        {title !== subtitle && (
          <p className="inspector-description">{subtitle}</p>
        )}
        {isInput && (
          <PropertyField
            field={{
              tag: "attribute",
              text: null,
              children: [],
              attributes: {
                name: "inputValue",
                label: "输入值",
                value: inputDisplay(
                  input?.attributes.bits || ports[0]?.attributes.bits,
                ),
                editable: "true",
              },
            }}
            placeholder="未运行"
            title="输入运行值并按 Enter；未运行时自动启动仿真"
            onCommit={(value) =>
              simulate("input", {
                componentId: selected.id,
                bits: inputBits(
                  value,
                  Number(
                    input?.attributes.width ||
                      ports[0]?.attributes.width ||
                      valueOf("width") ||
                      1,
                  ),
                  valueOf("tristate") === "true",
                ),
                ...(simulation ? { viewId: simulation.viewId } : {}),
              })
            }
          />
        )}
        {live?.attributes.control === "parent-input" && (
          <p className="inspector-description">
            此输入由父电路驱动，可返回父图调整。
          </p>
        )}
        {live?.attributes.control === "pulse" && simulation && (
          <div className="input-action">
            <span>按钮</span>
            <HeldButton
              simulate={simulate}
              componentId={selected.id}
              viewId={simulation.viewId}
              onError={onError}
            />
          </div>
        )}
        {["RAM", "ROM"].includes(selected.name) && (
          <button
            className="inspector-memory"
            onClick={() => onOpenMemory(selected.id)}
          >
            存储内容{" "}
            <span>
              {valueOf("addrWidth") && valueOf("dataWidth")
                ? `${2 ** Number(valueOf("addrWidth"))} × ${valueOf("dataWidth")} bit　›`
                : "›"}
            </span>
          </button>
        )}
        <h3 className="property-heading">属性</h3>
        {loading && (
          <p className="muted" role="status">
            正在读取属性…
          </p>
        )}
        {loadError && (
          <div className="property-error" role="alert">
            {loadError}
            <button onClick={() => setRetry((value) => value + 1)}>
              重新读取
            </button>
          </div>
        )}
        {attributes
          .filter((f) => !isAppearanceProperty(f.attributes.name))
          .map(renderField)}
        {ends.length > 0 && (
          <table className="pin-table">
            <thead>
              <tr>
                <th>接口</th>
                <th>位宽</th>
                {simulation && (
                  <>
                    <th>运行值</th>
                    <th />
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {ends.map((end) => {
                const value = ports.find(
                  (p) => p.attributes.index === String(end.index),
                );
                return (
                  <tr key={end.index}>
                    <td title={end.runtimeTooltip || undefined}>
                      {portName(connectionComponent!, end)}
                    </td>
                    <td>{end.width ?? "?"}</td>
                    {simulation && (
                      <>
                        <td>
                          <code>{value?.attributes.bits || "—"}</code>
                        </td>
                        <td>
                          <button
                            aria-label={`观察端口 ${end.index}`}
                            title="观察信号"
                            aria-pressed={watched.includes(
                              `${nativeId}:${end.index}`,
                            )}
                            disabled={watchPending || !value}
                            onClick={() => void toggleWatch(String(end.index))}
                          >
                            <Eye size={13} />
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {appearance.length > 0 && (
          <details
            className="appearance-properties"
            open={appearanceOpen}
            onToggle={(e) => setAppearanceOpen(e.currentTarget.open)}
          >
            <summary>外观</summary>
            {appearance.map(renderField)}
          </details>
        )}
      </div>
    </>
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
