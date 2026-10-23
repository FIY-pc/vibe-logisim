import { createElement, useEffect, useRef, useState } from "react";
import { Maximize, Trash2, Undo2, X } from "lucide-react";
import { command } from "../shared/transport";
import type { Document } from "../shared/types";
import type { SymbolDraft } from "../generated/SymbolDraft";
import type { SymbolShape } from "../generated/SymbolShape";
import {
  movePort,
  removePort,
  resizeRect,
  translateShape,
} from "./symbol-geometry";
import "./InterfaceEditor.css";
import { Select } from "../shared/Select";
import { DialogClose, useModal } from "../shared/Dialog";
interface Definition extends SymbolDraft {
  uses: { circuit: string }[];
  newPinLocation: { x: number; y: number };
}
interface Impact {
  circuit: string;
  instances: number;
  movedPorts: number;
  detachedPorts: number;
}
interface Preview {
  previewId: string;
  impacts: Impact[];
  addedPorts: number;
  removedPorts: number;
  changed: boolean;
}
type Selected = { kind: "port" | "shape"; id: string };
export function InterfaceEditor({
  doc,
  circuit,
  onDocument,
  onClose,
}: {
  doc: Document;
  circuit: string;
  onDocument: (doc: Document, expectedBaseRevision?: string) => void;
  onClose: () => void;
}) {
  const dialog = useModal(),
    svg = useRef<SVGSVGElement>(null),
    artwork = useRef<SVGGElement>(null);
  const [base, setBase] = useState<Definition | null>(null),
    [draft, setDraft] = useState<SymbolDraft | null>(null),
    [selected, setSelected] = useState<Selected | null>(null);
  const [undo, setUndo] = useState<SymbolDraft[]>([]),
    [busy, setBusy] = useState(true),
    [applying, setApplying] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [parentImage, setParentImage] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState("0 0 300 240");
  const ref = useRef({ id: doc.id, revision: doc.revision, circuit }).current;
  const active =
    ref.id === doc.id &&
    ref.revision === doc.revision &&
    ref.circuit === circuit;
  const dirty =
    !!draft &&
    !!base &&
    JSON.stringify(draft) !==
      JSON.stringify({ ports: base.ports, shapes: base.shapes });
  const pointer = useRef<{
    id: number;
    start: { x: number; y: number };
    before: SymbolDraft;
    selected: Selected;
    moved: boolean;
  } | null>(null);
  const fit = () => {
    const b = artwork.current?.getBBox();
    if (b)
      setViewBox(
        `${b.x - 50} ${b.y - 50} ${Math.max(160, b.width + 100)} ${Math.max(140, b.height + 100)}`,
      );
  };
  useEffect(() => {
    let live = true;
    void command<Definition>({ op: "interfaceRead", ...ref })
      .then((result) => {
        if (live) {
          setBase(result);
          setDraft({ ports: result.ports, shapes: result.shapes });
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (base) fit();
  }, [base]);
  const invalidate = () => {
    setPreview(null);
    setParentImage(null);
    setError("");
  };
  const edit = (mutate: (draft: SymbolDraft) => void) => {
    if (!draft || busy || !active) return;
    const next = structuredClone(draft);
    mutate(next);
    setUndo((old) => [...old.slice(-59), draft]);
    setDraft(next);
    invalidate();
  };
  const restore = () => {
    if (busy || !undo.length) return;
    setDraft(undo.at(-1)!);
    setUndo((old) => old.slice(0, -1));
    invalidate();
  };
  const cancelDrag = () => {
    if (pointer.current) {
      setDraft(pointer.current.before);
      pointer.current = null;
    }
  };
  useEffect(() => {
    window.addEventListener("blur", cancelDrag);
    return () => window.removeEventListener("blur", cancelDrag);
  }, []);
  const selectedPort =
    selected?.kind === "port"
      ? draft?.ports.find((p) => p.id === selected.id)
      : null;
  const selectedShape =
    selected?.kind === "shape"
      ? draft?.shapes.find((s) => s.id === selected.id)
      : null;
  const prepare = async () => {
    if (!draft || !active) throw new Error("工程已改变，请重新打开封装编辑器");
    const result = await command<Preview>({
      op: "interfacePreview",
      ...ref,
      draft,
    });
    setPreview(result);
    return result;
  };
  const run = async (action: () => Promise<void>, apply = false) => {
    if (busy) return;
    setBusy(true);
    setApplying(apply);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setApplying(false);
    }
  };
  const point = (event: { clientX: number; clientY: number }) => {
    const matrix = svg.current?.getScreenCTM()?.inverse();
    if (!matrix) return { x: 0, y: 0 };
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
  };
  const apply = () =>
    run(async () => {
      if (!draft || !dirty || !active) return;
      const checked = preview || (await prepare());
      const updated = await command<Document>({
        op: "interfaceApply",
        ...ref,
        preview_id: checked.previewId,
        draft,
      });
      onDocument(updated, ref.revision);
      onClose();
    }, true);
  return (
    <dialog
      ref={dialog}
      className="interface-editor"
      aria-label={`${circuit} 封装与接口`}
      onCancel={(event) => {
        event.preventDefault();
        if (pointer.current) cancelDrag();
        else if (!applying) onClose();
      }}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "z" &&
          !(event.target as HTMLElement).closest("input,select,textarea")
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!event.shiftKey) restore();
        }
      }}
    >
      <header>
        <h2>{circuit} · 封装与接口</h2>
        <DialogClose label="关闭封装编辑器" disabled={applying} onClick={onClose} />
      </header>
      {!active && (
        <p role="alert" className="dialog-error">
          工程已改变，请关闭后重新打开编辑器。
        </p>
      )}
      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      <div className="symbol-workspace" aria-busy={busy}>
        <div className="symbol-drawing">
          <div className="symbol-toolbar">
            <button
              disabled={busy || !draft}
              onClick={() =>
                edit((d) => {
                  const id = "new-" + crypto.randomUUID();
                  d.shapes.push({
                    id,
                    tag: "rect",
                    attrs: {
                      x: "70",
                      y: "70",
                      width: "80",
                      height: "60",
                      stroke: "#294963",
                      fill: "none",
                      "stroke-width": "2",
                    },
                    text: "",
                    editable: true,
                  });
                  setSelected({ kind: "shape", id });
                })
              }
            >
              矩形
            </button>
            <button
              disabled={busy || !draft}
              onClick={() =>
                edit((d) => {
                  const id = "new-" + crypto.randomUUID();
                  d.shapes.push({
                    id,
                    tag: "text",
                    attrs: {
                      x: "100",
                      y: "100",
                      "font-family": "Dialog",
                      "font-size": "14",
                      fill: "#24364b",
                    },
                    text: "文字",
                    editable: true,
                  });
                  setSelected({ kind: "shape", id });
                })
              }
            >
              文字
            </button>
            <button title="适应封装" aria-label="适应封装" onClick={fit}>
              <Maximize size={15} />
            </button>
            <button
              title="撤销封装修改"
              aria-label="撤销封装修改"
              disabled={busy || !undo.length}
              onClick={restore}
            >
              <Undo2 size={15} />
            </button>
          </div>
          <svg
            ref={svg}
            className="symbol-canvas"
            viewBox={viewBox}
            role="group"
            aria-label="封装画布"
            tabIndex={0}
            onPointerDown={(event) => {
              if (busy || !draft || event.button !== 0 || !active) return;
              const target = (event.target as Element).closest<SVGElement>(
                "[data-shape],[data-port]",
              );
              if (!target) return;
              const chosen: Selected = target.dataset.port
                ? { kind: "port", id: target.dataset.port }
                : { kind: "shape", id: target.dataset.shape! };
              setSelected(chosen);
              pointer.current = {
                id: event.pointerId,
                start: point(event),
                before: structuredClone(draft),
                selected: chosen,
                moved: false,
              };
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              const drag = pointer.current;
              if (!drag || drag.id !== event.pointerId) return;
              const p = point(event),
                dx = Math.round((p.x - drag.start.x) / 10) * 10,
                dy = Math.round((p.y - drag.start.y) / 10) * 10;
              const next = structuredClone(drag.before);
              drag.moved = !!(dx || dy);
              if (drag.selected.kind === "port") {
                const p = next.ports.find((p) => p.id === drag.selected.id)!;
                movePort(next, p.id, { x: p.x + dx, y: p.y + dy });
              } else {
                const s = next.shapes.find((s) => s.id === drag.selected.id)!;
                if (s.editable && s.tag !== "path") translateShape(s, dx, dy);
              }
              setDraft(next);
              if (drag.moved) invalidate();
            }}
            onPointerUp={() => {
              const drag = pointer.current;
              if (drag?.moved)
                setUndo((old) => [...old.slice(-59), drag.before]);
              pointer.current = null;
            }}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
            onKeyDown={(event) => {
              if (event.key === "Escape" && pointer.current) {
                event.preventDefault();
                event.stopPropagation();
                cancelDrag();
                return;
              }
              const delta = (
                {
                  ArrowLeft: [-10, 0],
                  ArrowRight: [10, 0],
                  ArrowUp: [0, -10],
                  ArrowDown: [0, 10],
                } as Record<string, number[]>
              )[event.key];
              if (!delta || !selected) return;
              event.preventDefault();
              edit((d) => {
                if (selected.kind === "port") {
                  const p = d.ports.find((p) => p.id === selected.id)!;
                  movePort(d, p.id, { x: p.x + delta[0], y: p.y + delta[1] });
                } else {
                  const s = d.shapes.find((s) => s.id === selected.id)!;
                  if (s.editable && s.tag !== "path")
                    translateShape(s, delta[0], delta[1]);
                }
              });
            }}
          >
            <g ref={artwork}>
              {draft?.shapes.map((s) => (
                <Shape key={s.id} shape={s} selected={selected?.id === s.id} />
              ))}
              {draft?.ports.map((p) => (
                <g
                  key={p.id}
                  data-port={p.id}
                  className={`symbol-port ${selected?.id === p.id ? "selected" : ""}`}
                  role="button"
                  aria-label={`端口 ${p.label}`}
                >
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={11}
                    fill="transparent"
                    stroke="none"
                  />
                  {p.direction === "input" ? (
                    <circle cx={p.x} cy={p.y} r={4} />
                  ) : (
                    <rect x={p.x - 5} y={p.y - 5} width={10} height={10} />
                  )}
                </g>
              ))}
            </g>
          </svg>
          {(selectedPort || selectedShape) && (
            <fieldset className="symbol-properties" disabled={busy || !active}>
              {selectedPort && (
                <>
                  <Field
                    label="X"
                    value={selectedPort.x}
                    numeric
                    onChange={(v) =>
                      edit((d) =>
                        movePort(d, selectedPort.id, { x: Number(v) }),
                      )
                    }
                  />
                  <Field
                    label="Y"
                    value={selectedPort.y}
                    numeric
                    onChange={(v) =>
                      edit((d) =>
                        movePort(d, selectedPort.id, { y: Number(v) }),
                      )
                    }
                  />
                  <label>
                    内外接线
                    <Select
                      label="内外接线"
                      size="small"
                      value={selectedPort.disconnect ? "detach" : "keep"}
                      options={[
                        { value: "keep", label: "保持接线" },
                        { value: "detach", label: "断开接线" },
                      ]}
                      onChange={(value) =>
                        edit((d) =>
                          movePort(d, selectedPort.id, {
                            disconnect: value === "detach",
                          }),
                        )
                      }
                    />
                  </label>
                  {selectedPort.id.startsWith("new-") && (
                    <>
                      <Field
                        label="内部 X"
                        numeric
                        value={selectedPort.internalX}
                        onChange={(v) =>
                          edit((d) =>
                            movePort(d, selectedPort.id, {
                              internalX: Number(v),
                            }),
                          )
                        }
                      />
                      <Field
                        label="内部 Y"
                        numeric
                        value={selectedPort.internalY}
                        onChange={(v) =>
                          edit((d) =>
                            movePort(d, selectedPort.id, {
                              internalY: Number(v),
                            }),
                          )
                        }
                      />
                    </>
                  )}
                  {selectedPort.disconnect && (
                    <p>将断开内部及所有父图中此端口的支线。</p>
                  )}
                </>
              )}
              {selectedShape &&
                (selectedShape.editable ? (
                  <>
                    {selectedShape.tag === "text" && (
                      <Field
                        label="文字内容"
                        value={selectedShape.text}
                        onChange={(v) =>
                          edit((d) => {
                            d.shapes.find(
                              (s) => s.id === selectedShape.id,
                            )!.text = v;
                          })
                        }
                      />
                    )}
                    {(
                      [
                        ["x", "X"],
                        ["y", "Y"],
                        ["width", "宽度"],
                        ["height", "高度"],
                        ["x1", "起点 X"],
                        ["y1", "起点 Y"],
                        ["x2", "终点 X"],
                        ["y2", "终点 Y"],
                        ["cx", "中心 X"],
                        ["cy", "中心 Y"],
                        ["rx", "横半径"],
                        ["ry", "纵半径"],
                        ["font-size", "字号"],
                        ["fill", "填充"],
                        ["stroke", "线色"],
                      ] as const
                    )
                      .filter(([key]) => selectedShape.attrs[key] !== undefined)
                      .map(([key, label]) => (
                        <Field
                          key={key}
                          label={label}
                          value={selectedShape.attrs[key]!}
                          numeric={!["fill", "stroke"].includes(key)}
                          onChange={(value) =>
                            edit((d) => {
                              const s = d.shapes.find(
                                (s) => s.id === selectedShape.id,
                              )!;
                              if (
                                s.tag === "rect" &&
                                ["width", "height"].includes(key)
                              )
                                resizeRect(d, s.id, { [key]: value });
                              else s.attrs[key] = value;
                            })
                          }
                        />
                      ))}
                    <button
                      aria-label="删除图形"
                      onClick={() =>
                        edit((d) => {
                          d.shapes = d.shapes.filter(
                            (s) => s.id !== selectedShape.id,
                          );
                          setSelected(null);
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                ) : (
                  <p>此图形保留原样；可以继续编辑端口或添加图形。</p>
                ))}
            </fieldset>
          )}
        </div>
        <section className="symbol-ports">
          <header>
            <h3>端口</h3>
            <button
              disabled={!base || busy || !active}
              onClick={() =>
                edit((d) => {
                  const id = "new-" + crypto.randomUUID();
                  d.ports.push({
                    id,
                    label: "SIGNAL",
                    direction: "input",
                    width: 1,
                    x: 50,
                    y: Math.max(50, ...d.ports.map((p) => p.y)) + 20,
                    internalX: base!.newPinLocation.x,
                    internalY:
                      base!.newPinLocation.y +
                      d.ports.filter((p) => p.id.startsWith("new-")).length *
                        30,
                    disconnect: false,
                  });
                  setSelected({ kind: "port", id });
                })
              }
            >
              添加端口
            </button>
          </header>
          <div className="symbol-port-columns">
            <span />
            <span>名称</span>
            <span>方向</span>
            <span>位宽</span>
            <span />
          </div>
          {draft?.ports.map((p) => (
            <fieldset
              disabled={busy || !active}
              key={p.id}
              className={`symbol-port-row ${selected?.id === p.id ? "selected" : ""}`}
            >
              <button
                aria-label={`定位端口 ${p.label}`}
                onClick={() => setSelected({ kind: "port", id: p.id })}
              >
                {p.direction === "input" ? "→" : "←"}
              </button>
              <Field
                label={`${p.label} 名称`}
                value={p.label}
                onChange={(v) => edit((d) => movePort(d, p.id, { label: v }))}
              />
              <Select
                label={`${p.label} 方向`}
                size="small"
                value={p.direction}
                options={[
                  { value: "input", label: "输入" },
                  { value: "output", label: "输出" },
                ]}
                onChange={(direction) =>
                  edit((d) => movePort(d, p.id, { direction }))
                }
              />
              <Field
                label={`${p.label} 位宽`}
                numeric
                value={p.width}
                onChange={(v) =>
                  edit((d) => movePort(d, p.id, { width: Number(v) }))
                }
              />
              <button
                aria-label={`删除端口 ${p.label}`}
                onClick={() =>
                  edit((d) => {
                    removePort(d, p.id);
                    if (selected?.id === p.id) setSelected(null);
                  })
                }
              >
                <X size={13} />
              </button>
            </fieldset>
          ))}
          {base && (
            <p className="muted">
              {base.uses.length
                ? `共享定义 · ${base.uses.length} 处父图引用`
                : "此定义尚未放入其他电路"}
            </p>
          )}
          {preview && (
            <div className="symbol-impact">
              <h3>应用后的影响</h3>
              {preview.impacts.map((i) => (
                <div key={i.circuit}>
                  <span>
                    {i.circuit}：调整 {i.movedPorts} 个接点，断开{" "}
                    {i.detachedPorts} 个端口
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await command<{ image: string }>({
                          op: "interfaceRender",
                          ...ref,
                          preview_id: preview.previewId,
                          circuit: i.circuit,
                        });
                        setParentImage(result.image);
                      })
                    }
                  >
                    查看图面
                  </button>
                </div>
              ))}
              {(preview.addedPorts > 0 || preview.removedPorts > 0) && (
                <p>
                  新增 {preview.addedPorts} 个、删除 {preview.removedPorts}{" "}
                  个端口
                </p>
              )}
            </div>
          )}
        </section>
      </div>
      {parentImage && (
        <div className="symbol-parent-preview">
          <button
            aria-label="关闭图面预览"
            onClick={() => setParentImage(null)}
          >
            <X size={15} />
          </button>
          <img src={parentImage} alt="应用后的电路" />
        </div>
      )}
      <footer>
        <span role="status">
          {busy ? "正在读取并检查电路…" : dirty ? "草稿尚未应用" : ""}
        </span>
        <button
          disabled={!dirty || busy || !active}
          onClick={() =>
            void run(async () => {
              await prepare();
            })
          }
        >
          预览修改
        </button>
        <button
          className="primary"
          disabled={!dirty || busy || !active}
          onClick={() => void apply()}
        >
          应用
        </button>
      </footer>
    </dialog>
  );
}
function Field({
  label,
  value,
  onChange,
  numeric = false,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  numeric?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    if (numeric && (!text.trim() || !Number.isFinite(Number(text)))) {
      setText(String(value));
      return;
    }
    if (text !== String(value)) onChange(text);
  };
  return (
    <label>
      <span>{label}</span>
      <input
        aria-label={label}
        inputMode={numeric ? "decimal" : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
function Shape({ shape, selected }: { shape: SymbolShape; selected: boolean }) {
  if (
    ![
      "rect",
      "ellipse",
      "line",
      "polyline",
      "polygon",
      "path",
      "text",
    ].includes(shape.tag)
  )
    return null;
  const attributes = Object.fromEntries(
    Object.entries(shape.attrs)
      .filter(
        ([key, value]) =>
          /^(x|y|width|height|r|rx|ry|cx|cy|x1|x2|y1|y2|points|d|fill|stroke|stroke-width|font-family|font-size|font-weight|font-style|text-anchor|dominant-baseline)$/.test(
            key,
          ) && !String(value).includes("url("),
      )
      .map(([key, value]) => [
        key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
        value,
      ]),
  );
  if (
    attributes.fontFamily === "Dialog" ||
    attributes.fontFamily === "SansSerif"
  )
    attributes.fontFamily = "sans-serif";
  return createElement(
    shape.tag,
    {
      ...attributes,
      "data-shape": shape.id,
      className: selected ? "symbol-selected" : "",
      role: "button",
      "aria-label": shape.tag === "text" ? `文字 ${shape.text}` : "封装图形",
    },
    shape.tag === "text" ? shape.text : undefined,
  );
}
