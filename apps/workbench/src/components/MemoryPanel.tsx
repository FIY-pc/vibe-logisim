import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { command } from "../lib/transport";
import type { Component, Document, Simulation, XmlNode } from "../lib/types";
const hex = (value: number, bits = 1) =>
  value
    .toString(16)
    .toUpperCase()
    .padStart(Math.ceil(bits / 4), "0");
export function MemoryPanel({
  doc,
  circuit,
  component,
  simulation,
  simulate,
  onDocument,
  onClose,
}: {
  doc: Document;
  circuit: string;
  component: Component;
  simulation: Simulation | null;
  simulate: (op: string, attrs?: Record<string, string>) => Promise<void>;
  onDocument: (doc: Document) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<XmlNode | null>(null),
    [offset, setOffset] = useState(0),
    [address, setAddress] = useState("0"),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0);
  const ram = component.name === "RAM";
  const scope = `${doc.id}:${doc.revision}:${circuit}:${component.id}:${ram ? simulation?.viewId : "rom"}`;
  const read = async (at: number) => {
    if (!Number.isSafeInteger(at) || at < 0)
      throw new Error("请输入有效的十六进制字地址");
    if (ram) {
      if (!simulation) return;
      await simulate("memory", {
        componentId: component.id,
        offset: String(at),
        count: "64",
        viewId: simulation.viewId,
      });
    } else {
      const requested = epoch.current;
      const result = await command<XmlNode>({
        op: "memory",
        id: doc.id,
        revision: doc.revision,
        circuit,
        component: component.id,
        offset: at,
        count: 64,
      });
      if (requested === epoch.current)
        setPage(result.children.find((n) => n.tag === "memory") || null);
    }
    setOffset(at);
    setAddress(hex(at));
  };
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    epoch.current++;
    setPage(null);
    void run(() => read(offset));
    return () => {
      epoch.current++;
    };
  }, [scope]);
  useEffect(() => {
    if (!ram) return;
    const next = simulation?.frame.children.find(
      (n) => n.tag === "memory" && n.attributes.componentId === component.id,
    );
    if (next) setPage(next);
  }, [simulation?.frame, ram, component.id]);
  const write = (word: XmlNode, value: string) =>
    run(async () => {
      if (!page) return;
      if (
        !/^[\da-f]+$/i.test(value) ||
        BigInt("0x" + value) >= 1n << BigInt(page.attributes.dataBits)
      )
        throw new Error(
          `请输入 ${page.attributes.dataBits} 位以内的十六进制数据`,
        );
      const expected = hex(Number(word.attributes.value));
      if (ram) {
        if (!simulation) throw new Error("本次仿真已结束");
        await simulate("memory-write", {
          viewId: simulation.viewId,
          componentId: component.id,
          offset: String(offset),
          count: "64",
          address: word.attributes.address,
          expected,
          value,
        });
      } else {
        onDocument(
          await command<Document>({
            op: "memoryWrite",
            id: doc.id,
            revision: doc.revision,
            circuit,
            component: component.id,
            address: Number(word.attributes.address),
            expected,
            value,
          }),
        );
      }
    });
  return (
    <section className="memory-panel" aria-label="存储器内容">
      <header>
        <strong>
          {circuit} › {component.attributes.label || component.name}
        </strong>
        <span className="muted">
          {ram ? "RAM · 运行内容" : "ROM · 工程内容"}
        </span>
        <button aria-label="关闭存储器" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {ram && !simulation ? (
        <button
          className="small-button"
          disabled={pending}
          onClick={() => void run(() => simulate("start"))}
        >
          启动仿真
        </button>
      ) : (
        <>
          <div className="memory-navigation">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  read(
                    /^(0x)?[\da-f]+$/i.test(address)
                      ? parseInt(address.replace(/^0x/i, ""), 16)
                      : NaN,
                  ),
                );
              }}
            >
              <label>
                地址{" "}
                <input
                  aria-label="跳转到字地址（十六进制）"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  disabled={pending}
                />
              </label>
            </form>
            {page && (
              <span className="muted">
                {Number(page.attributes.length).toLocaleString()} 字 ×{" "}
                {page.attributes.dataBits} bit
              </span>
            )}
            <button
              aria-label="上一页地址"
              disabled={pending || !offset}
              onClick={() => void run(() => read(Math.max(0, offset - 64)))}
            >
              <ChevronLeft size={15} />
            </button>
            <button
              aria-label="下一页地址"
              disabled={
                pending ||
                !page ||
                offset + 64 >= Number(page.attributes.length)
              }
              onClick={() => void run(() => read(offset + 64))}
            >
              <ChevronRight size={15} />
            </button>
            <button
              aria-label="刷新存储器"
              disabled={pending}
              onClick={() => void run(() => read(offset))}
            >
              <RefreshCw size={14} />
            </button>
            {pending && (
              <span className="spinner" aria-label="正在读取存储器" />
            )}
          </div>
          <div className="memory-grid">
            {page?.children
              .filter((n) => n.tag === "word")
              .map((word) => (
                <MemoryWord
                  key={`${scope}:${word.attributes.address}`}
                  word={word}
                  bits={Number(page.attributes.dataBits)}
                  addressBits={Number(page.attributes.addressBits)}
                  disabled={pending || (ram && !simulation)}
                  write={write}
                />
              ))}
          </div>
        </>
      )}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
function MemoryWord({
  word,
  bits,
  addressBits,
  disabled,
  write,
}: {
  word: XmlNode;
  bits: number;
  addressBits: number;
  disabled: boolean;
  write: (w: XmlNode, value: string) => Promise<boolean>;
}) {
  const original = useRef(word);
  const current = hex(Number(word.attributes.value), bits);
  const [draft, setDraft] = useState(current),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(current);
  }, [current, editing]);
  return (
    <label>
      <code>{hex(Number(word.attributes.address), addressBits)}</code>
      <input
        aria-label={`地址 ${hex(Number(word.attributes.address), addressBits)}`}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        onFocus={() => {
          original.current = word;
          setEditing(true);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          setDraft(current);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
          if (e.key === "Enter") {
            e.preventDefault();
            const input = e.currentTarget;
            void write(original.current, draft.replace(/^0x/i, "")).then(
              (saved) => {
                if (saved) input.blur();
              },
            );
          }
        }}
      />
    </label>
  );
}
