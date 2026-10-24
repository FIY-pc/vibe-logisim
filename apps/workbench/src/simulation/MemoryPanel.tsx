import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { tip } from "../shared/Tooltips";
import type { MemoryPage } from "../generated/MemoryPage";
import type { Document } from "../shared/types";
import type { Component } from "../shared/types";

const hex = (value: number, bits = 1) =>
  value
    .toString(16)
    .toUpperCase()
    .padStart(Math.ceil(bits / 4), "0");
/** The words a page shows, as the released version showed them. */
const PAGE = 64;

/** One word written through the page's own storage: a RAM's through the run,
 * a ROM's as a document edit. `expected` is the word the page showed, so a
 * word the run changed since is not overwritten. */
export interface MemoryWrite {
  offset: number;
  address: number;
  expected: string;
  value: string;
}

export function MemoryPanel({
  doc,
  circuit,
  component,
  live,
  page,
  state,
  ticks,
  designSaved,
  start,
  readPage,
  writePage,
  onDocument,
  onClose,
}: {
  doc: Document;
  circuit: string;
  component: Component;
  /** The run this memory belongs to is running this circuit. */
  live: boolean;
  /** The run's page for this component, as frames deliver it. */
  page: MemoryPage | null;
  /** "运行中" or "已暂停", for a run's page. */
  state: string;
  ticks: number | undefined;
  /** The document has no unsaved edits. */
  designSaved: boolean;
  start: () => Promise<boolean>;
  readPage: (offset: number) => Promise<MemoryPage | null>;
  writePage: (write: MemoryWrite) => Promise<MemoryPage | null>;
  onDocument: (doc: Document, expectedBaseRevision?: string) => void;
  onClose: () => void;
}) {
  const [rom, setRom] = useState<MemoryPage | null>(null),
    [offset, setOffset] = useState(0),
    [address, setAddress] = useState("0"),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0);
  // The words the page last showed, to mark the ones a frame changed.
  const previous = useRef(new Map<number, number>());
  const ram = component.name === "RAM";
  const scope = `${doc.id}:${doc.revision}:${circuit}:${component.id}:${ram ? "ram" : "rom"}`;
  // A run's page is live: frames replace it while the panel shows the same
  // page. A ROM's page is read on request and kept here.
  const shown = ram ? (page?.offset === offset ? page : null) : rom;
  // A word a frame changed since the page was last drawn is highlighted, as
  // in the released version; the map is updated once this render is drawn.
  const changed = new Set<number>();
  if (shown) {
    let moved = false;
    for (const [index, word] of shown.words.entries()) {
      const at = shown.offset + index;
      const before = previous.current.get(at);
      if (before !== word) {
        if (before !== undefined) changed.add(at);
        previous.current.set(at, word);
        moved = true;
      }
    }
    if (!moved && previous.current.size !== shown.words.length)
      previous.current = new Map(
        shown.words.map((word, index) => [shown.offset + index, word]),
      );
  }
  // A new page starts without highlights.
  useEffect(() => {
    previous.current = new Map();
  }, [scope, offset, ram && live]);
  const read = async (at: number) => {
    const requested = epoch.current;
    const result = await readPage(at);
    if (requested !== epoch.current) return;
    if (!result) throw new Error("未能读取存储器内容，请检查运行状态。");
    if (!ram) setRom(result);
    setOffset(at);
    setAddress(hex(at));
  };
  const runAction = async (action: () => Promise<unknown>) => {
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
    setRom(null);
    setOffset(0);
    setAddress("0");
    if (ram ? live : true) void runAction(() => read(0));
    return () => {
      epoch.current++;
    };
  }, [scope, ram && live]);
  const write = (word: number, value: string) =>
    runAction(async () => {
      if (!shown) return;
      if (
        !/^[\da-f]+$/i.test(value) ||
        BigInt("0x" + value) >= 1n << BigInt(shown.dataBits)
      )
        throw new Error(`请输入 ${shown.dataBits} 位以内的十六进制数据`);
      if (BigInt("0x" + value) === BigInt(word)) return;
      const written = await writePage({
        offset,
        address: shown.offset + shown.words.indexOf(word),
        expected: hex(word, shown.dataBits),
        value: value.toUpperCase(),
      });
      if (ram) {
        if (!written)
          throw new Error("写入未成功；若内容已变化，请刷新后再编辑。");
      } else if (!written) throw new Error("ROM 写入未成功，工程未改变。");
    });
  const stateLine = !ram
    ? designSaved
      ? "工程已保存"
      : "工程未保存"
    : live
      ? `${state} · ${ticks ?? "—"} tick`
      : "运行已结束 · 内容已失效";
  return (
    <section className="memory-panel" aria-label="存储器内容">
      <header>
        <strong>
          {circuit} › {component.attributes.label || component.name}
        </strong>
        <span className="muted">
          {ram ? "RAM · 运行内容" : "ROM · 工程内容"}
        </span>
        <span className="muted memory-state">{stateLine}</span>
        <button
          aria-label="关闭存储器"
          {...tip("关闭")}
          onClick={(event) => {
            // Keyboard focus moves on to the canvas instead of leaving with the panel.
            event.currentTarget
              .closest("main")
              ?.querySelector<HTMLElement>(".canvas")
              ?.focus({ preventScroll: true });
            onClose();
          }}
        >
          <X size={15} />
        </button>
      </header>
      {ram && !live ? (
        <div className="memory-empty">
          <p>RAM 内容属于运行实例。</p>
          <button
            className="small-button"
            disabled={pending}
            onClick={() => void runAction(start)}
          >
            启动此电路的仿真
          </button>
        </div>
      ) : (
        <>
          <div className="memory-navigation">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const at = /^(0x)?[\da-f]+$/i.test(address.trim())
                  ? parseInt(address.trim().replace(/^0x/i, ""), 16)
                  : NaN;
                void runAction(() =>
                  Number.isSafeInteger(at) && at >= 0
                    ? read(at)
                    : Promise.reject(new Error("地址超出存储器范围")),
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
            {shown && (
              <span className="muted">
                {shown.length.toLocaleString()} 字 × {shown.dataBits} bit
              </span>
            )}
            <button
              aria-label="上一页地址"
              {...tip("上一页")}
              disabled={pending || !offset}
              onClick={() =>
                void runAction(() => read(Math.max(0, offset - PAGE)))
              }
            >
              <ChevronLeft size={15} />
            </button>
            <button
              aria-label="下一页地址"
              {...tip("下一页")}
              disabled={pending || !shown || offset + PAGE >= shown.length}
              onClick={() => void runAction(() => read(offset + PAGE))}
            >
              <ChevronRight size={15} />
            </button>
            <button
              aria-label="刷新存储器"
              {...tip("重新读取")}
              disabled={pending}
              onClick={() => void runAction(() => read(offset))}
            >
              <RefreshCw size={14} />
            </button>
            {pending && (
              <span className="spinner" aria-label="正在读取存储器" />
            )}
          </div>
          <div className="memory-grid">
            {shown?.words.map((word, index) => (
              <MemoryWord
                key={`${scope}:${shown.offset + index}`}
                address={shown.offset + index}
                value={word}
                bits={shown.dataBits}
                addressBits={shown.addressBits}
                changed={changed.has(shown.offset + index)}
                disabled={pending}
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
  address,
  value,
  bits,
  addressBits,
  changed,
  disabled,
  write,
}: {
  address: number;
  value: number;
  bits: number;
  addressBits: number;
  /** A frame changed the word since the page was drawn. */
  changed: boolean;
  disabled: boolean;
  write: (word: number, value: string) => Promise<boolean>;
}) {
  const original = useRef(value);
  const current = hex(value, bits);
  const [draft, setDraft] = useState(current),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(current);
  }, [current, editing]);
  return (
    <label data-changed={changed || undefined}>
      <code>{hex(address, addressBits)}</code>
      <input
        aria-label={`地址 ${hex(address, addressBits)}`}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        onFocus={() => {
          original.current = value;
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
