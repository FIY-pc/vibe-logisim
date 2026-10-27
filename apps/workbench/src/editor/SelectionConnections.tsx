import { useMemo } from "react";
import type { Circuit } from "../shared/types";
import {
  bitMapping,
  componentName,
  connectedPorts,
  connectionIndex,
  documentComponent,
  documentWire,
  portName,
  portSignal,
  type ConnectionFocus,
  type ConnectionPeer,
  type SignalTarget,
} from "./connectivity";
import "./inspector.css";
import { tip } from "../shared/Tooltips";

interface Props {
  focus: ConnectionFocus | null;
  circuit: Circuit;
  selection: string[];
  error?: string;
  onVisit: (peer: ConnectionPeer) => void;
  onTrace: (target: SignalTarget) => void;
  onBack?: () => void;
}

/** Selection details use the same native net records as explicit signal tracing. */
export function SelectionConnections({
  focus,
  circuit,
  selection,
  error,
  onVisit,
  onTrace,
  onBack,
}: Props) {
  const index = useMemo(() => (focus ? connectionIndex(focus) : null), [focus]);
  if (!selection.length)
    return (
      <div className="quiet-empty">
        选中元件或导线查看连接；Ctrl+点击信号可定位来源。
      </div>
    );
  if (!focus || !index)
    return (
      <div className="quiet-empty" role={error ? "alert" : "status"}>
        {error || "正在读取连接…"}
      </div>
    );
  const components = focus.components.filter((c) => {
    if (c.partial) return false;
    const selected = documentComponent(circuit, c);
    return selected && selection.includes(selected.id);
  });
  const selectedWires = circuit.wires.filter((w) => selection.includes(w.id));
  const nativeWires = focus.wires.filter((w) => {
    const selected = documentWire(circuit, w);
    return selected && selection.includes(selected.id);
  });
  const bundles = [...new Set(nativeWires.map((w) => w.bundleId))];
  const group = (target: SignalTarget, key: string) => {
    const peers = connectedPorts(index, target.bits, target.origin);
    return (
      <section className="connection-port" key={key}>
        <h3>{target.label}</h3>
        {target.bits.length > 0 && (
          <button className="signal-action" onClick={() => onTrace(target)}>
            追踪此信号
          </button>
        )}
        {!target.bits.length ? (
          <p className="connection-empty">未读取到此端口的连接信息</p>
        ) : !peers.length ? (
          <p className="connection-empty">没有连接其他端口</p>
        ) : (
          peers.map((peer) => (
            <button
              className="connection-peer"
              key={`${peer.component.componentId}:${peer.end.index}`}
              data-tip={`在画布定位 ${componentName(peer.component)} · ${portName(peer.component, peer.end)}`}
              onClick={() => onVisit(peer)}
            >
              <strong>{componentName(peer.component)}</strong>
              <span>{portName(peer.component, peer.end)}</span>
              {((peer.end.width ?? 0) > 1 ||
                peer.pairs.length > 1 ||
                peer.pairs.some((p) => p.from !== 0)) && (
                <small>{bitMapping(peer.pairs)}</small>
              )}
            </button>
          ))
        )}
      </section>
    );
  };
  return (
    <div className="selection-connections" aria-label="选中对象的连接">
      {onBack && (
        <button
          className="signal-action"
          onClick={onBack}
          {...tip("返回上个位置", "Alt+←")}
        >
          返回上个位置
        </button>
      )}
      {components.map((component) => (
        <section className="connection-component" key={component.componentId}>
          <h2>{componentName(component)}</h2>
          {!component.ends.length && (
            <p className="connection-empty">此对象没有电气端口</p>
          )}
          {component.ends.map((end) =>
            group(
              {
                ...portSignal(component, end),
                label: `${portName(component, end)} · ${end.width ?? "?"} 位`,
              },
              String(end.index),
            ),
          )}
        </section>
      ))}
      {bundles.map((id) => {
        const bundle = id ? index.bundles.get(id) : undefined;
        if (!bundle || !bundle.valid || !bundle.width)
          return (
            <section className="connection-port" key={id || "unknown-wire"}>
              <h3>
                导线 · {bundle?.valid === false ? "位宽冲突" : "位宽未定"}
              </h3>
            </section>
          );
        return group(
          {
            label: `导线 · ${bundle.width} 位`,
            bits: bundle.bitNets,
            origin: null,
          },
          bundle.bundleId,
        );
      })}
      {((!components.length && !selectedWires.length) ||
        selectedWires.length > nativeWires.length) && (
        <p className="connection-empty">未读取到所选对象的连接信息</p>
      )}
    </div>
  );
}
