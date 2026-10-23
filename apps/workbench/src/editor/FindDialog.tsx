import { useEffect, useId, useState } from "react";
import type { Circuit, Document } from "../shared/types";
import { DialogClose, useModal } from "../shared/Dialog";
const names: Record<string, string> = {
  Register: "寄存器",
  Tunnel: "隧道",
  Pin: "引脚",
  Probe: "探针",
  Clock: "时钟",
  Multiplexer: "多路选择器",
  Splitter: "分线器",
  ROM: "只读存储器",
  RAM: "存储器",
  Button: "按钮",
  Constant: "常量",
  Adder: "加法器",
  Comparator: "比较器",
  Text: "文字",
};
export function FindDialog({
  mode,
  doc,
  circuit,
  onChoose,
  onClose,
}: {
  mode: "component" | "circuit";
  doc: Document;
  circuit: Circuit;
  onChoose: (circuit: string, component?: string) => void;
  onClose: () => void;
}) {
  const dialog = useModal();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const items =
    mode === "circuit"
      ? doc.circuits.map((c) => ({
          id: c.name,
          label: c.name,
          detail: "",
          circuit: c.name,
          component: undefined,
        }))
      : circuit.components.map((c) => ({
          id: c.id,
          label:
            c.attributes.label || c.attributes.text || names[c.name] || c.name,
          detail: `${names[c.name] || c.name} · ${c.location.x}, ${c.location.y}`,
          search: c.name,
          circuit: circuit.name,
          component: c.id,
        }));
  const results = items
    .filter((c) =>
      query
        .toLocaleLowerCase()
        .trim()
        .split(/\s+/)
        .every((part) =>
          `${c.label} ${c.detail} ${"search" in c ? c.search : ""}`
            .toLocaleLowerCase()
            .includes(part),
        ),
    )
    .sort((a, b) => {
      const value = query.toLocaleLowerCase().trim();
      const score = (label: string) =>
        label.toLocaleLowerCase() === value
          ? 0
          : label.toLocaleLowerCase().startsWith(value)
            ? 1
            : 2;
      return score(a.label) - score(b.label);
    })
    .slice(0, 100);
  const selected = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => {
    document
      .getElementById(`${listId}-${selected}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, query, listId]);
  const choose = (index: number) => {
    const item = results[index];
    if (item) {
      onChoose(item.circuit, item.component);
      onClose();
    }
  };
  return (
    <dialog
      ref={dialog}
      className="find-dialog"
      aria-label={mode === "circuit" ? "查找电路" : "查找元件"}
      onCancel={onClose}
    >
      <header>
        <h2>{mode === "circuit" ? "查找电路" : "查找元件"}</h2>
        <DialogClose onClick={onClose} />
      </header>
      <input
        data-autofocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={
          results.length ? `${listId}-${selected}` : undefined
        }
        aria-label={mode === "circuit" ? "电路名称" : "元件名称或标签"}
        placeholder={mode === "circuit" ? "电路名称" : "元件名称或标签"}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) {
            e.preventDefault();
            if (e.key === "Enter") choose(selected);
            else
              setActive(
                Math.max(
                  0,
                  Math.min(
                    results.length - 1,
                    selected + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
          }
        }}
      />
      <div className="find-results" role="listbox" id={listId}>
        {results.map((c, index) => (
          <button
            key={c.id}
            role="option"
            id={`${listId}-${index}`}
            tabIndex={-1}
            aria-selected={selected === index}
            onClick={() => choose(index)}
          >
            <span>{c.label}</span>
            <small>{c.detail}</small>
          </button>
        ))}
      </div>
      {!results.length && <p className="muted">没有匹配的结果</p>}
    </dialog>
  );
}
