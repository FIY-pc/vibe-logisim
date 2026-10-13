import {
  useFeedback,
  FeedbackMenu,
  FeedbackDialog,
  UpdateNotice,
} from "./components/Feedback";
import { usePlacement } from "./lib/usePlacement";
import { PlacementInspector } from "./components/PlacementInspector";
import { FindDialog } from "./components/FindDialog";
import { ShortcutSettings } from "./components/ShortcutSettings";
import { eventBinding, useShortcuts } from "./lib/shortcuts";
import { EditorToolbar } from "./components/EditorToolbar";
import { FilePreview, type PreviewFile } from "./components/FilePreview";
import { MemoryPanel } from "./components/MemoryPanel";
import { Waveform } from "./components/Waveform";
import { Observations } from "./components/Observations";
import type { ObservationRecord } from "./generated/ObservationRecord";
import { subscribeEvents } from "./lib/events";
import { DecisionDialog, type Decision } from "./components/DecisionDialog";
import { useSourceStatus } from "./lib/useSourceStatus";
import type { SourceStatus } from "./generated/SourceStatus";
import { TextPrompt } from "./components/TextPrompt";
import { Files, type ProjectFolder } from "./components/Files";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircuitBoard,
  FolderOpen,
  FilePlus2,
  Trash2,
  ChevronDown,
  Plus,
  Search,
  Settings2,
  X,
  PanelRight,
  Code2,
  Download,
  RotateCw,
} from "lucide-react";
import { Canvas } from "./components/Canvas";
import { Inspector } from "./components/Inspector";
import { Chat } from "./components/Chat";
import { command, desktop, openPath, savePath } from "./lib/transport";
import type {
  CatalogGroup,
  CatalogTool,
  Document,
  Edit,
  Simulation,
  Tool,
  XmlNode,
} from "./lib/types";
export function App() {
  const [notice, setNotice] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [lastCapture, setLastCapture] = useState<ObservationRecord | null>(
    null,
  );
  const [circuitPrompt, setCircuitPrompt] = useState(false);
  const [renameCircuit, setRenameCircuit] = useState(false);
  const [memory, setMemory] = useState<{
    documentId: string;
    circuit: string;
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const [observations, setObservations] = useState<{
    documentId: string;
    initial?: string;
  } | null>(null);
  const [folder, setFolder] = useState<ProjectFolder | null>(null);
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [quotation, setQuotation] = useState<{
    id: string;
    documentId: string;
    label: string;
    text: string;
  } | null>(null);
  const workspaceEpoch = useRef(0);
  const currentDocs = useRef<Document[]>([]);
  const currentActive = useRef<string | null>(null);
  const [docs, setDocsState] = useState<Document[]>([]),
    [active, setActiveState] = useState<string | null>(null),
    [circuitName, setCircuitName] = useState("main");
  const setDocs = useCallback(
    (value: Document[] | ((previous: Document[]) => Document[])) => {
      workspaceEpoch.current++;
      const next =
        typeof value === "function" ? value(currentDocs.current) : value;
      currentDocs.current = next;
      setDocsState(next);
    },
    [],
  );
  const setActive = useCallback((id: string | null) => {
    workspaceEpoch.current++;
    currentActive.current = id;
    setActiveState(id);
  }, []);
  const mergeDocument = useCallback(
    (d: Document) =>
      setDocs((previous) =>
        previous.some((x) => x.id === d.id)
          ? previous.map((x) => (x.id === d.id ? d : x))
          : previous,
      ),
    [setDocs],
  );
  const [tool, setTool] = useState<Tool>("select"),
    [place, setPlace] = useState<CatalogTool | null>(null);
  const [catalog, setCatalog] = useState<CatalogGroup[]>([]),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(0);
  const [sim, setSim] = useState<Simulation | null>(null),
    [fitToken, setFit] = useState(0),
    [right, setRight] = useState<"chat" | "properties">("chat");
  const [source, setSource] = useState<{
      xml: string;
      id: string;
      revision: string;
      circuit: string;
    } | null>(null),
    [settings, setSettings] = useState(false);
  const {
    bindings: shortcutBindings,
    labels: shortcuts,
    save: saveShortcuts,
  } = useShortcuts();
  const [signalView, setSignalView] = useState<React.ReactNode>(null);
  const [showExplorer, setShowExplorer] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [find, setFind] = useState<"component" | "circuit" | null>(null);
  const [focusTarget, setFocusTarget] = useState<{
    documentId: string;
    revision: string;
    circuit: string;
    id: string;
    token: number;
  } | null>(null);
  const upload = useRef<HTMLInputElement>(null),
    searchInput = useRef<HTMLInputElement>(null);
  const doc = docs.find((d) => d.id === active) || null;
  const circuit =
    doc?.circuits.find((c) => c.name === circuitName) || doc?.circuits[0];
  const placement = usePlacement(doc, circuit, place);
  const canRotate =
    Boolean(placement.template?.attributes.facingAttribute) &&
    !placement.loading;
  const [selected, setSelected] = useState<{ scope: string; ids: string[] }>({
    scope: "",
    ids: [],
  });
  const selectionScope = `${doc?.id}:${doc?.revision}:${circuit?.name}`;
  const selection = selected.scope === selectionScope ? selected.ids : [];
  const setSelection = (ids: string[]) =>
    setSelected({ scope: selectionScope, ids });
  const currentSelectionScope = useRef(selectionScope);
  currentSelectionScope.current = selectionScope;
  const navigationRequest = useRef(0);
  const { sourceStatus, recheck } = useSourceStatus(doc);
  const onError = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const refreshWorkspace = useCallback(
    async (includeFolder = false) => {
      for (;;) {
        const epoch = workspaceEpoch.current;
        const status = await command<{
          documents: Document[];
          active: string | null;
          folder: ProjectFolder | null;
          recoveryError: string | null;
        }>({ op: "status" });
        // Status can wait on the native runtime after taking its document snapshot.
        // Never let that earlier snapshot replace a newer event or local action.
        if (epoch !== workspaceEpoch.current) continue;
        const nextActive = status.documents.some(
          (d) => d.id === currentActive.current,
        )
          ? currentActive.current
          : status.active;
        setDocs(status.documents);
        if (currentActive.current !== nextActive) {
          setActive(nextActive);
          setCircuitName(
            status.documents.find((d) => d.id === nextActive)?.main || "main",
          );
          setPlace(null);
        }
        if (includeFolder) setFolder(status.folder);
        if (status.recoveryError) onError(status.recoveryError);
        return;
      }
    },
    [setDocs, setActive, onError],
  );
  const feedback = useFeedback(setNotice, onError);
  const busy = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    setPending((n) => n + 1);
    try {
      return await action();
    } finally {
      setPending((n) => n - 1);
    }
  }, []);
  const update = useCallback((d: Document) => {
    setDocs((old) =>
      old.some((x) => x.id === d.id)
        ? old.map((x) => (x.id === d.id ? d : x))
        : [...old, d],
    );
    setActive(d.id);
  }, []);
  const newFile = () =>
    busy(async () => {
      const d = await command<Document>({ op: "new", name: "未命名.circ" });
      update(d);
      setCircuitName(d.main);
    }).catch(onError);
  const openFile = () => {
    if (!desktop()) {
      upload.current?.click();
      return;
    }
    void busy(async () => {
      const path = await openPath();
      if (path) {
        const d = await command<Document>({ op: "open", path });
        update(d);
        setCircuitName(d.main);
      }
    }).catch(onError);
  };
  const saveDocument = async (
    target: Document,
    saveAs = false,
  ): Promise<Document | null> => {
    let path = saveAs ? null : target.path;
    let target_revision: string | undefined;
    if (!path) {
      if (!desktop()) {
        const { xml } = await command<{ xml: string }>({
          op: "source",
          id: target.id,
          revision: target.revision,
        });
        const url = URL.createObjectURL(
          new Blob([xml], { type: "application/xml" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = target.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return null;
      }
      path = await savePath(target.path || target.name);
      if (!path) return null;
      const destination = await command<{ revision: string | null }>({
        op: "saveTarget",
        path,
      });
      target_revision = destination.revision || undefined;
    }
    const saved = await command<Document>({
      op: "save",
      id: target.id,
      revision: target.revision,
      path,
      target_revision,
    });
    mergeDocument(saved);
    recheck();
    return saved;
  };
  const save = (saveAs = false) => {
    if (doc)
      void busy(() => saveDocument(doc, saveAs)).catch((e) => {
        recheck();
        onError(e);
      });
  };
  const closeDocument = async (target: Document, discard = false) => {
    await busy(() =>
      command({
        op: "close",
        id: target.id,
        revision: target.revision,
        discard,
      }),
    );
    setDocs((previous) => previous.filter((d) => d.id !== target.id));
    if (currentActive.current === target.id) {
      const next = currentDocs.current[0];
      setActive(next?.id || null);
      setCircuitName(next?.main || "main");
      if (next) await command({ op: "activate", id: next.id });
    }
    setSim((previous) =>
      previous?.documentId === target.id ? null : previous,
    );
  };
  const requestClose = (target: Document) => {
    if (!target.dirty) {
      void closeDocument(target).catch(onError);
      return;
    }
    setDecision({
      title: `关闭 ${target.name}？`,
      message: "这个文档还有未保存的修改。",
      actions: [
        { label: "不保存", run: () => closeDocument(target, true) },
        {
          label: desktop() || target.path ? "保存并关闭" : "下载副本",
          primary: true,
          run: async () => {
            const saved = await busy(() => saveDocument(target));
            if (!saved) return false;
            await closeDocument(saved);
          },
        },
      ],
    });
  };
  const requestReload = async () => {
    if (!doc) return;
    const status = await command<SourceStatus>({
      op: "sourceStatus",
      id: doc.id,
    });
    recheck();
    if (status.state !== "unchanged" && status.state !== "modified")
      throw new Error(
        status.state === "missing"
          ? "原文件已被移除，可以另存为保留当前文档。"
          : "无法读取源文件",
      );
    const reload = async (discard: boolean) => {
      const next = await busy(() =>
        command<Document>({
          op: "reload",
          id: doc.id,
          revision: doc.revision,
          source_revision: status.revision,
          discard,
        }),
      );
      mergeDocument(next);
      recheck();
    };
    if (!doc.dirty) {
      await reload(false);
      return;
    }
    setDecision({
      title: `重新载入 ${doc.name}？`,
      message: "当前未保存的修改将被源文件替换；载入后仍可撤销。",
      actions: [{ label: "重新载入", primary: true, run: () => reload(true) }],
    });
  };
  const edit = async (edit: Edit) => {
    if (!doc || !circuit) return;
    const next = await busy(() =>
      command<Document>({
        op: "edit",
        id: doc.id,
        revision: doc.revision,
        circuit: circuit.name,
        edit,
      }),
    );
    mergeDocument(next);
  };
  const history = (op: "undo" | "redo") => {
    if (doc)
      void busy(() =>
        command<Document>({ op, id: doc.id, revision: doc.revision }),
      )
        .then(mergeDocument)
        .catch(onError);
  };
  const simulationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const simulate = async (
    op: string,
    attributes: Record<string, string> = {},
  ) => {
    if (!doc || !circuit) return;
    const request =
      op === "stop"
        ? { op: "simulationStop" as const }
        : {
            op: "simulationAction" as const,
            id: doc.id,
            revision: doc.revision,
            circuit: circuit.name,
            command: op,
            attributes,
          };
    const next = simulationQueue.current
      .catch(() => {})
      .then(() => busy(() => command(request)));
    simulationQueue.current = next;
    await next;
  };
  const activeSim =
    sim &&
    doc &&
    sim.documentId === doc.id &&
    sim.revision === doc.revision &&
    sim.circuit === circuit?.name
      ? sim
      : null;
  const memoryComponent =
    memory && memory.documentId === doc?.id && memory.circuit === circuit?.name
      ? circuit?.components.find(
          (c) =>
            c.name === memory.name &&
            c.location.x === memory.x &&
            c.location.y === memory.y,
        )
      : null;
  const openMemory = (id: string) => {
    const c = circuit?.components.find((c) => c.id === id);
    if (doc && circuit && c)
      setMemory({
        documentId: doc.id,
        circuit: circuit.name,
        name: c.name,
        x: c.location.x,
        y: c.location.y,
      });
  };
  const capture = async () => {
    if (!doc || !activeSim) return;
    const record = await busy(() =>
      command<ObservationRecord>({
        op: "observationCapture",
        id: doc.id,
        revision: doc.revision,
        view_id: activeSim.viewId,
        title: "",
      }),
    );
    setLastCapture(record);
  };
  const trace = activeSim?.frame.children.find((n) => n.tag === "trace");
  const traceLabels = Object.fromEntries(
    (trace?.children || [])
      .filter((n) => n.tag === "signal")
      .map((n) => {
        const [id, port] = n.attributes.key.split(":");
        const c = circuit?.components.find((c) => c.id === id);
        return [
          n.attributes.key,
          `${c?.attributes.label || c?.name || id} [${port}]`,
        ];
      }),
  );
  useEffect(() => {
    void refreshWorkspace(true).catch(onError);
  }, [refreshWorkspace, onError]);
  useEffect(() => {
    if (!doc || !circuit) {
      setCatalog([]);
      return;
    }
    let live = true;
    command<XmlNode>({
      op: "catalog",
      id: doc.id,
      revision: doc.revision,
      circuit: circuit.name,
    })
      .then((root) => {
        if (live)
          setCatalog(
            root.children
              .filter((n) => n.tag === "group")
              .map((g) => ({
                id: g.attributes.id,
                label: g.attributes.label,
                tools: g.children.map((t) => ({
                  ...t.attributes,
                  library: g.attributes.id,
                })) as unknown as CatalogTool[],
              })),
          );
      })
      .catch((e) => {
        if (live) onError(e);
      });
    return () => {
      live = false;
    };
  }, [doc?.id, doc?.revision, circuit?.name]);
  useEffect(() => {
    let live = true;
    let version = 0;
    const stop = subscribeEvents((event) => {
      if (event.topic === "simulation") {
        version++;
        setSim(event.data);
      }
      if (event.topic === "resync") {
        setError((previous) =>
          previous === "连接中断，正在重新连接…" ? "" : previous,
        );
        const requested = ++version;
        void command<Simulation | null>({ op: "simulationStatus" })
          .then((next) => {
            if (live && requested === version) setSim(next);
          })
          .catch(onError);
      }
      if (event.topic === "connection") onError(event.data);
    });
    return () => {
      live = false;
      stop();
    };
  }, []);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open],[aria-modal="true"]')) return;
      if (
        (e.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"]',
        )
      )
        return;
      const key = eventBinding(e);
      if (!key) return;
      const shortcut = Object.entries(shortcutBindings).find(
        ([, binding]) => binding === key,
      )?.[0];
      if (shortcut) {
        e.preventDefault();
        if (["select", "wire", "poke", "pan"].includes(shortcut)) {
          setTool(shortcut as Tool);
          setPlace(null);
        } else if (shortcut === "palette") {
          setShowExplorer(true);
          requestAnimationFrame(() => searchInput.current?.focus());
        } else if (shortcut === "rotate") {
          if (place && canRotate) placement.rotate();
        } else if (shortcut === "save") save();
        else if (shortcut === "undo") history("undo");
        else if (shortcut === "find" && doc) setFind("component");
        else if (shortcut === "circuitSearch" && doc) setFind("circuit");
        else if (shortcut === "fit") setFit((n) => n + 1);
        else if (shortcut === "grid") setShowGrid((shown) => !shown);
        else if (shortcut === "rail") setShowExplorer((shown) => !shown);
        else if (shortcut === "review") setShowRight((shown) => !shown);
        else if (shortcut === "capture") void capture().catch(onError);
        else if (shortcut === "clock")
          void simulate(
            activeSim?.frame.attributes.running === "true" ? "pause" : "play",
          ).catch(onError);
        else if (shortcut === "propagation")
          void simulate("configure", {
            automatic:
              activeSim?.frame.attributes.automatic === "false"
                ? "true"
                : "false",
          }).catch(onError);
        else if (["tick", "step", "reset"].includes(shortcut))
          void simulate(shortcut).catch(onError);
        return;
      }
      if (key === "Mod+N") {
        e.preventDefault();
        void newFile();
      }
      if (key === "Mod+Shift+S") {
        e.preventDefault();
        save(true);
      }
      if (key === "Mod+W" && doc) {
        e.preventDefault();
        requestClose(doc);
      }
      if (["Mod+Shift+Z", "Mod+Y"].includes(key)) {
        e.preventDefault();
        history("redo");
      }
      if (key === "Mod+,") {
        e.preventDefault();
        setSettings(true);
      }
      if (key === "Mod+Shift+O") {
        setShowRight(true);
        setRight("chat");
      }
      if (key === "Mod+O") {
        e.preventDefault();
        openFile();
      }
      if (e.key === "Escape") {
        setPlace(null);
        setSource(null);
        setSettings(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      // Acknowledged drafts are already checkpointed by Rust. Only warn while an
      // operation is still waiting for acknowledgement, rather than on every reload.
      if (pending) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [pending]);
  const switchCircuit = (name: string) => {
    navigationRequest.current++;
    if (
      sim &&
      doc &&
      sim.documentId === doc.id &&
      sim.revision === doc.revision &&
      sim.rootCircuit === name &&
      sim.instancePath.length
    ) {
      void command<Simulation>({
        op: "simulationView",
        id: doc.id,
        revision: doc.revision,
        path: [],
      })
        .then(setSim)
        .catch(onError);
    }
    setCircuitName(name);
    setSelection([]);
    setPlace(null);
  };
  const navigateSimulation = async (path: string[]) => {
    if (!doc || !circuit) return;
    const scope = selectionScope;
    const requested = ++navigationRequest.current;
    const next = await command<Simulation>({
      op: "simulationView",
      id: doc.id,
      revision: doc.revision,
      path,
    });
    if (
      requested !== navigationRequest.current ||
      currentSelectionScope.current !== scope
    )
      return;
    setSim(next);
    setCircuitName(next.circuit);
    setSelection([]);
    setPlace(null);
  };
  const actionButton = (
    title: string,
    icon: React.ReactNode,
    action: () => void,
    disabled = false,
  ) => (
    <button
      className="icon-button"
      title={title}
      aria-label={title}
      onClick={action}
      disabled={disabled}
    >
      {icon}
    </button>
  );
  return (
    <div className="app">
      <input
        hidden
        ref={upload}
        type="file"
        accept=".circ"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void busy(async () => {
              const d = await command<Document>({
                op: "import",
                name: file.name,
                xml: await file.text(),
              });
              update(d);
              setCircuitName(d.main);
            }).catch(onError);
          e.target.value = "";
        }}
      />
      <header className="titlebar">
        <div className="brand">
          <CircuitBoard size={21} />
          <span>Vibe Logisim</span>
        </div>
        <div className="file-title">
          {doc && (
            <>
              {doc.name}
              {doc.dirty && (
                <span className="dirty-dot" title="有未保存的修改" />
              )}
            </>
          )}
        </div>
        <div className="title-actions">
          <details className="menu">
            <summary>
              文件 <ChevronDown size={13} />
            </summary>
            <div className="menu-content">
              <button onClick={() => void newFile()}>
                新建电路 <kbd>Ctrl N</kbd>
              </button>
              <button onClick={openFile}>
                打开… <kbd>Ctrl O</kbd>
              </button>
              <button
                disabled={!doc || Boolean(pending)}
                onClick={() => save()}
              >
                保存 <kbd>{shortcuts.save}</kbd>
              </button>
              <button
                disabled={!doc || Boolean(pending)}
                onClick={() => save(true)}
              >
                {desktop() ? "另存为…" : "下载副本"} <kbd>Ctrl Shift S</kbd>
              </button>
              <button
                disabled={!doc?.path || Boolean(pending)}
                onClick={() => void requestReload().catch(onError)}
              >
                重新载入
              </button>
              <button
                disabled={!doc || Boolean(pending)}
                onClick={() => doc && requestClose(doc)}
              >
                关闭文档 <kbd>Ctrl W</kbd>
              </button>
              <button disabled={!doc} onClick={() => setFind("component")}>
                查找元件… <kbd>{shortcuts.find}</kbd>
              </button>
              <button disabled={!doc} onClick={() => setFind("circuit")}>
                查找电路… <kbd>{shortcuts.circuitSearch}</kbd>
              </button>
              <button
                disabled={!doc}
                onClick={() =>
                  doc &&
                  void command<{ xml: string }>({
                    op: "source",
                    id: doc.id,
                    revision: doc.revision,
                  })
                    .then((r) =>
                      setSource({
                        xml: r.xml,
                        id: doc.id,
                        revision: doc.revision,
                        circuit: circuit?.name || doc.main,
                      }),
                    )
                    .catch(onError)
                }
              >
                编辑源文件
              </button>
              <FeedbackMenu feedback={feedback} />
            </div>
          </details>
          {actionButton("快捷键设置", <Settings2 size={17} />, () =>
            setSettings(true),
          )}
          {actionButton("展开 / 收起工作栏", <PanelRight size={17} />, () =>
            setShowRight((shown) => !shown),
          )}
        </div>
      </header>
      <UpdateNotice feedback={feedback} />
      <div className="workspace">
        <aside
          className="explorer"
          style={showExplorer ? undefined : { display: "none" }}
        >
          <div className="panel-heading">
            工程
            <div>
              {actionButton("打开电路", <FolderOpen size={15} />, openFile)}
              {actionButton(
                "新建电路文件",
                <FilePlus2 size={15} />,
                () => void newFile(),
              )}
            </div>
          </div>
          <Files
            folder={folder}
            onFolder={(next) => {
              workspaceEpoch.current++;
              setFolder(next);
            }}
            onRename={() => refreshWorkspace()}
            onOpen={(path) =>
              void busy(() => command<Document>({ op: "open", path }))
                .then((d) => {
                  update(d);
                  setCircuitName(d.main);
                })
                .catch(onError)
            }
            onPreview={setPreview}
            onError={onError}
          />
          <div className="document-list">
            {docs.map((d) => (
              <div key={d.id}>
                <div
                  className={
                    "document-row " + (d.id === active ? "active" : "")
                  }
                >
                  <button
                    className="document-item"
                    onClick={() => {
                      navigationRequest.current++;
                      setActive(d.id);
                      setPlace(null);
                      void command({ op: "activate", id: d.id }).catch(onError);
                      setCircuitName(d.main);
                      setSelection([]);
                    }}
                  >
                    <CircuitBoard size={15} />
                    <span>{d.name}</span>
                    {d.dirty && (
                      <span className="dirty-dot" title="有未保存的修改" />
                    )}
                  </button>
                  <button
                    className="document-close"
                    title={`关闭 ${d.name}`}
                    aria-label={`关闭 ${d.name}`}
                    disabled={Boolean(pending)}
                    onClick={() => requestClose(d)}
                  >
                    <X size={13} />
                  </button>
                </div>
                {d.id === active && (
                  <div className="circuit-list">
                    {d.circuits.map((c) => (
                      <div className="circuit-row" key={c.name}>
                        <button
                          className={c.name === circuit?.name ? "active" : ""}
                          onClick={() => switchCircuit(c.name)}
                          title={d.main === c.name ? "主电路" : undefined}
                        >
                          {c.name}
                          {d.main === c.name && (
                            <span className="main-marker" aria-label="主电路">
                              ⌂
                            </span>
                          )}
                        </button>
                        {c.name === circuit?.name && (
                          <details className="menu">
                            <summary aria-label="电路操作">···</summary>
                            <div className="menu-content">
                              <button onClick={() => setRenameCircuit(true)}>
                                重命名…
                              </button>
                              <button
                                disabled={d.main === c.name}
                                onClick={() =>
                                  void edit({ kind: "setMain" }).catch(onError)
                                }
                              >
                                设为主电路
                              </button>
                              <button
                                disabled={d.circuits.length === 1}
                                onClick={() =>
                                  setDecision({
                                    title: `删除电路 ${c.name}？`,
                                    message: "删除后可以撤销。",
                                    actions: [
                                      {
                                        label: "删除",
                                        run: async () => {
                                          await edit({ kind: "deleteCircuit" });
                                          switchCircuit(
                                            d.circuits.find(
                                              (x) => x.name !== c.name,
                                            )!.name,
                                          );
                                        },
                                      },
                                    ],
                                  })
                                }
                              >
                                删除电路
                              </button>
                            </div>
                          </details>
                        )}
                      </div>
                    ))}
                    <button
                      className="muted"
                      onClick={() => setCircuitPrompt(true)}
                    >
                      <Plus size={13} />
                      新建电路
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {doc && (
            <>
              <div className="palette-search">
                <Search size={15} />
                <input
                  ref={searchInput}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索元件"
                  aria-label="搜索元件"
                />
                <kbd>{shortcuts.palette}</kbd>
              </div>
              <div className="palette">
                {catalog.map((group) => {
                  const tools = group.tools.filter((t) =>
                    (t.name + " " + t.label)
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  );
                  return tools.length ? (
                    <details key={group.id} open>
                      <summary>{group.label}</summary>
                      {tools.map((t) => (
                        <button
                          key={t.name}
                          disabled={Boolean(t.disabled)}
                          title={t.disabled || t.label}
                          aria-label={t.label}
                          className={
                            place?.name === t.name &&
                            place.library === t.library
                              ? "selected"
                              : ""
                          }
                          onClick={() => {
                            setPlace(t);
                            setSelection([]);
                            setRight("properties");
                            setShowRight(true);
                            setTool("select");
                          }}
                        >
                          {t.icon && <img src={t.icon} alt="" />}
                          <span>{t.label}</span>
                        </button>
                      ))}
                    </details>
                  ) : null;
                })}
              </div>
            </>
          )}
        </aside>
        <main className="editor">
          {doc && circuit ? (
            <>
              {sourceStatus &&
                !["unchanged", "untitled"].includes(sourceStatus.state) && (
                  <div className="source-notice" role="status">
                    <span>
                      {sourceStatus.state === "modified"
                        ? "源文件已被其他程序修改"
                        : sourceStatus.state === "missing"
                          ? "原文件已被移除"
                          : "无法读取源文件"}
                    </span>
                    {sourceStatus.state === "modified" && (
                      <button
                        disabled={Boolean(pending)}
                        onClick={() => void requestReload().catch(onError)}
                      >
                        重新载入
                      </button>
                    )}
                    <button
                      disabled={Boolean(pending)}
                      onClick={() => save(true)}
                    >
                      {desktop() ? "另存为…" : "下载副本"}
                    </button>
                    {sourceStatus.state === "unreadable" && (
                      <button onClick={recheck}>重试</button>
                    )}
                  </div>
                )}
              <EditorToolbar
                tool={tool}
                place={place}
                shortcuts={shortcuts}
                pending={pending}
                canUndo={doc.canUndo}
                canRedo={doc.canRedo}
                hasSelection={Boolean(selection.length)}
                activeSim={activeSim}
                onTool={setTool}
                onCancelPlace={() => setPlace(null)}
                onHistory={history}
                onDelete={() =>
                  void edit({ kind: "delete", ids: selection }).catch(onError)
                }
                onFit={() => setFit((n) => n + 1)}
                onObservations={() => setObservations({ documentId: doc.id })}
                simulate={simulate}
                capture={capture}
                onError={onError}
              />
              <div className="breadcrumbs">
                <span>{doc.name}</span>
                <span>/</span>
                {activeSim && activeSim.instancePath.length > 0 && (
                  <button
                    onClick={() =>
                      void navigateSimulation(
                        activeSim.instancePath.slice(0, -1),
                      ).catch(onError)
                    }
                  >
                    ↑ 返回上层实例
                  </button>
                )}
                <strong>{circuit.name}</strong>
                {place &&
                  actionButton(
                    `旋转 90° (${shortcuts.rotate})`,
                    <RotateCw size={14} />,
                    () => placement.rotate(),
                    !canRotate,
                  )}
                {place && (
                  <label className="placement-repeat">
                    <input
                      type="checkbox"
                      checked={placement.repeat}
                      onChange={(e) => placement.setRepeat(e.target.checked)}
                    />
                    连续放置
                  </label>
                )}
                {place && (
                  <button className="placing" onClick={() => setPlace(null)}>
                    {place.label}
                    <X size={12} />
                  </button>
                )}
                {sim && !activeSim && (
                  <span className="muted">{sim.circuit} 的仿真保留中</span>
                )}
              </div>
              <Canvas
                key={`${doc.id}:${circuit.name}`}
                doc={doc}
                circuit={circuit}
                tool={tool}
                selection={selection}
                setSelection={(s) => {
                  setSelection(s);
                  if (s.length) setRight("properties");
                }}
                place={place}
                edit={edit}
                simulation={sim}
                simulate={simulate}
                onError={onError}
                fitToken={fitToken}
                showGrid={showGrid}
                placement={placement}
                onCancelPlace={() => setPlace(null)}
                onPlace={async (revision, edit) => {
                  const next = await busy(() =>
                    command<Document>({
                      op: "edit",
                      id: doc.id,
                      revision,
                      circuit: circuit.name,
                      edit,
                    }),
                  );
                  mergeDocument(next);
                  return next;
                }}
                focusTarget={
                  focusTarget?.documentId === doc.id &&
                  focusTarget.revision === doc.revision &&
                  focusTarget.circuit === circuit.name
                    ? focusTarget
                    : null
                }
                onSignalView={setSignalView}
                onSignalOpen={() => {
                  setRight("properties");
                  setShowRight(true);
                }}
                onOpenMemory={openMemory}
                onEnterCircuit={(name, id) => {
                  if (activeSim && doc)
                    void navigateSimulation([
                      ...activeSim.instancePath,
                      id,
                    ]).catch(onError);
                  else switchCircuit(name);
                }}
              />
              {activeSim?.frame.attributes.failure && (
                <p className="dialog-error" role="alert">
                  {activeSim.frame.attributes.failure}
                </p>
              )}
              {activeSim?.frame.attributes.oscillating === "true" && (
                <p className="dialog-error" role="alert">
                  电路发生振荡，时钟已暂停
                </p>
              )}
              {trace && trace.children.some((n) => n.tag === "signal") && (
                <section className="simulation-dock" aria-label="观察信号">
                  <header>
                    <span>观察信号</span>
                    <button
                      onClick={() =>
                        void simulate(
                          trace.attributes.recording === "true"
                            ? "trace-stop"
                            : "trace",
                          trace.attributes.recording === "true"
                            ? {}
                            : {
                                signals: trace.children
                                  .filter((n) => n.tag === "signal")
                                  .map((n) => n.attributes.key)
                                  .join(","),
                              },
                        ).catch(onError)
                      }
                    >
                      {trace.attributes.recording === "true"
                        ? "停止记录"
                        : "重新记录"}
                    </button>
                  </header>
                  <Waveform
                    key={trace.attributes.id}
                    trace={trace}
                    labels={traceLabels}
                  />
                </section>
              )}
              {memoryComponent && (
                <MemoryPanel
                  key={`${doc.id}:${circuit.name}:${memoryComponent.location.x}:${memoryComponent.location.y}`}
                  doc={doc}
                  circuit={circuit.name}
                  component={memoryComponent}
                  simulation={activeSim}
                  simulate={simulate}
                  onDocument={mergeDocument}
                  onClose={() => setMemory(null)}
                />
              )}
            </>
          ) : (
            <div className="welcome">
              <CircuitBoard size={42} />
              <h1>开始一个电路</h1>
              <div>
                <button className="primary" onClick={openFile}>
                  <FolderOpen size={17} />
                  打开电路
                </button>
                <button onClick={() => void newFile()}>
                  <Plus size={17} />
                  新建
                </button>
              </div>
            </div>
          )}
        </main>
        <aside
          className="right-panel"
          style={showRight ? undefined : { display: "none" }}
        >
          <div className="panel-tabs">
            <button
              className={right === "chat" ? "active" : ""}
              onClick={() => setRight("chat")}
            >
              对话
            </button>
            <button
              className={right === "properties" ? "active" : ""}
              onClick={() => setRight("properties")}
            >
              属性与信号
            </button>
          </div>
          {right === "properties" &&
            (signalView ||
              (place ? (
                <PlacementInspector
                  key={`${doc?.id}:${place.library}:${place.name}`}
                  placement={placement}
                />
              ) : circuit ? (
                <Inspector
                  doc={doc!}
                  circuit={circuit}
                  selection={selection}
                  onOpenMemory={openMemory}
                  edit={edit}
                  simulation={activeSim}
                  simulate={simulate}
                  onError={onError}
                />
              ) : (
                <div className="quiet-empty">打开电路后查看属性</div>
              )))}
          <Chat
            visible={right === "chat"}
            doc={doc}
            circuit={circuit?.name || null}
            onError={onError}
            onDocument={mergeDocument}
            folder={folder}
            selection={selection}
            quotation={quotation}
            onQuoted={() => setQuotation(null)}
          />
        </aside>
      </div>
      {notice && (
        <div className="capture-notice" role="status">
          <span>{notice}</span>
          <button aria-label="关闭提示" onClick={() => setNotice("")}>
            <X size={13} />
          </button>
        </div>
      )}
      {lastCapture && !notice && (
        <div className="capture-notice" role="status">
          <button
            onClick={() =>
              setObservations({
                documentId: lastCapture.documentId,
                initial: lastCapture.id,
              })
            }
          >
            已留存 · {lastCapture.title}
          </button>
          <button
            aria-label="关闭留存提示"
            onClick={() => setLastCapture(null)}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {error && (
        <div className="error-bar" role="alert">
          <span>{error}</span>
          <button aria-label="关闭错误" onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {feedback.dialogOpen && (
        <FeedbackDialog onClose={() => feedback.setDialogOpen(false)} />
      )}
      {decision && (
        <DecisionDialog decision={decision} onClose={() => setDecision(null)} />
      )}
      {observations && (
        <Observations {...observations} onClose={() => setObservations(null)} />
      )}
      {renameCircuit && circuit && (
        <TextPrompt
          title="重命名电路"
          initial={circuit.name}
          onClose={() => setRenameCircuit(false)}
          onSubmit={async (name) => {
            await edit({ kind: "renameCircuit", name });
            switchCircuit(name);
          }}
        />
      )}
      {circuitPrompt && (
        <TextPrompt
          title="新建电路"
          onClose={() => setCircuitPrompt(false)}
          onSubmit={async (name) => {
            await edit({ kind: "addCircuit", name });
            switchCircuit(name);
          }}
        />
      )}
      {preview && (
        <FilePreview
          file={preview}
          onClose={() => setPreview(null)}
          onQuote={(label, text) => {
            if (doc) {
              setQuotation({
                id: crypto.randomUUID(),
                documentId: doc.id,
                label,
                text,
              });
              setRight("chat");
            }
          }}
        />
      )}
      {source !== null && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="编辑源文件"
            className="source-dialog"
          >
            <header>
              <Code2 size={18} /> {doc?.name}
              <button onClick={() => setSource(null)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <textarea
              value={source.xml}
              onChange={(e) => setSource({ ...source, xml: e.target.value })}
              spellCheck={false}
            />
            <footer>
              <button onClick={() => setSource(null)}>取消</button>
              <button
                className="primary"
                onClick={() =>
                  void command<Document>({
                    op: "edit",
                    id: source.id,
                    revision: source.revision,
                    circuit: source.circuit,
                    edit: { kind: "replace", xml: source.xml },
                  })
                    .then(mergeDocument)
                    .then(() => setSource(null))
                    .catch(onError)
                }
              >
                应用修改
              </button>
            </footer>
          </section>
        </div>
      )}
      {find && doc && circuit && (
        <FindDialog
          mode={find}
          doc={doc}
          circuit={circuit}
          onClose={() => setFind(null)}
          onChoose={(name, id) => {
            switchCircuit(name);
            if (id) {
              setSelection([id]);
              setRight("properties");
              setShowRight(true);
              setFocusTarget({
                documentId: doc.id,
                revision: doc.revision,
                circuit: name,
                id,
                token: Date.now(),
              });
            }
          }}
        />
      )}
      {settings && (
        <ShortcutSettings
          bindings={shortcutBindings}
          onChange={saveShortcuts}
          onClose={() => setSettings(false)}
        />
      )}
    </div>
  );
}
