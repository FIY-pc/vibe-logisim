import {
  bitMapping,
  componentName,
  portName,
  signalTrace,
  type ConnectionIndex,
  type ConnectionPeer,
  type SignalTarget,
} from "./connectivity";

interface Props {
  index: ConnectionIndex;
  target: SignalTarget;
  onNavigate: (peer: ConnectionPeer) => void;
  onClose: () => void;
  onBack?: () => void;
}

/** The established connection view: sources, uses and exact bus-bit mappings. */
export function Connections({
  index,
  target,
  onNavigate,
  onClose,
  onBack,
}: Props) {
  const trace = signalTrace(index, target.bits, target.origin);
  const groups: [string, ConnectionPeer[]][] = [
    ["上游驱动端", trace.sources],
    ["使用位置", trace.uses],
    ["字段提取 / 合并位置", trace.taps],
    ["信号名称与引用", trace.aliases],
    ["方向未确定的连接", trace.unknown],
  ];
  return (
    <section className="signal-block" aria-label="信号追踪">
      <header>
        <strong>{target.label}</strong>
        {onBack && (
          <button onClick={onBack} title="Alt+←">
            返回上个位置
          </button>
        )}
        <button onClick={onClose} aria-label="退出信号追踪" title="退出追踪">
          ×
        </button>
      </header>
      {groups
        .filter(([title, peers]) => peers.length || title === "上游驱动端")
        .map(([title, peers]) => (
          <section className="signal-ports" key={title}>
            <strong>{title}</strong>
            {!peers.length && <p>未找到已知输出驱动端</p>}
            {title === "上游驱动端" && peers.length > 1 && (
              <p>这些端口可能驱动不同位，也可能存在多驱动。</p>
            )}
            {peers.map((peer) => (
              <button
                key={`${peer.component.componentId}:${peer.end.index}`}
                onClick={() => onNavigate(peer)}
                title={`定位 ${componentName(peer.component)} · ${portName(peer.component, peer.end)}`}
              >
                <strong>{componentName(peer.component)}</strong>
                <span> · {portName(peer.component, peer.end)}</span>
                {(peer.end.width !== 1 ||
                  peer.pairs.length > 1 ||
                  peer.pairs.some((p) => p.from !== 0)) && (
                  <small>{bitMapping(peer.pairs)}</small>
                )}
              </button>
            ))}
          </section>
        ))}
    </section>
  );
}
