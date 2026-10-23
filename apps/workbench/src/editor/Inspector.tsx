import { Eye } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentState } from "../generated/ComponentState";
import type { Circuit, Document, Edit, XmlNode } from "../shared/types";
import type { ConnectionComponent } from "./connectivity";
import { portName } from "./connectivity";
import { componentLabels, isAppearanceProperty } from "./componentLabels";
import { command } from "../shared/transport";
import { inputBits, inputDisplay } from "../simulation/simulationInputs";
import { formatSignal } from "../simulation/simulation";
import { PropertyField } from "../shared/PropertyField";
import "./inspector.css";

interface Props {
  doc: Document;
  circuit: Circuit;
  selection: string[];
  edit: (e: Edit) => Promise<void>;
  /** The selected component in the run, when the canvas shows its view. */
  live: ComponentState | null;
  /** Watched ports of the run, as `componentId:port`. */
  watched: string[];
  /** Sets the run's input for the selected component to the bits given. */
  onInput: (bits: string) => Promise<void>;
  /** Watches or stops watching a port of the run. */
  onWatch: (key: string) => void;
  /** Holds the selected button of the run down, or lets it go. */
  onPress: () => void;
  onRelease: () => void;
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
  live: component,
  watched,
  onInput,
  onWatch,
  onPress,
  onRelease,
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
  const live = component;
  const input = component?.input;
  const ports = component?.ports || [];
  const nativeId = component?.id || selected.id;
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
    live?.control === "input" ||
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
        data-tip={`${circuit.name} › ${selected.name} · (${selected.location.x}, ${selected.location.y})`}
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
                value: inputDisplay(input?.bits || ports[0]?.bits),
                editable: "true",
              },
            }}
            placeholder="未运行"
            title="输入运行值并按 Enter；未运行时自动启动仿真"
            onCommit={(value) =>
              onInput(
                inputBits(
                  value,
                  Number(ports[0]?.width || valueOf("width") || 1),
                  valueOf("tristate") === "true",
                ),
              )
            }
          />
        )}
        {live?.control === "parent-input" && (
          <p className="inspector-description">
            此输入由父电路驱动，可返回父图调整。
          </p>
        )}
        {live?.control === "pulse" && component && (
          <div className="input-action">
            <span>按钮</span>
            <HeldButton
              componentId={selected.id}
              onPress={onPress}
              onRelease={onRelease}
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
                {component && (
                  <>
                    <th>运行值</th>
                    <th />
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {ends.map((end) => {
                const value = ports.find((p) => p.index === end.index);
                return (
                  <tr key={end.index}>
                    <td data-tip={end.runtimeTooltip || undefined}>
                      {portName(connectionComponent!, end)}
                    </td>
                    <td>{end.width ?? "?"}</td>
                    {component && (
                      <>
                        <td>
                          <code>{formatSignal(value)}</code>
                        </td>
                        <td>
                          <button
                            aria-label={`观察端口 ${end.index}`}
                            data-tip="观察信号"
                            aria-pressed={watched.includes(
                              `${nativeId}:${end.index}`,
                            )}
                            disabled={!value}
                            onClick={() => onWatch(`${nativeId}:${end.index}`)}
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
  componentId,
  onPress,
  onRelease,
}: {
  componentId: string;
  onPress: Props["onPress"];
  onRelease: Props["onRelease"];
}) {
  const down = useRef(false),
    [pressed, setPressed] = useState(false);
  const release = () => {
    if (!down.current) return;
    down.current = false;
    setPressed(false);
    onRelease();
  };
  const press = () => {
    if (down.current) return;
    down.current = true;
    setPressed(true);
    onPress();
  };
  useEffect(() => {
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("blur", release);
      release();
    };
  }, [componentId]);
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
