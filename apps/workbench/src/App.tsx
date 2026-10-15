import { useConversationReferences } from "./lib/conversationReferences";
import { useFolderPicker } from "./lib/useFolderPicker";
import { ProjectInfo } from "./components/ProjectInfo";
import { DocumentHistory } from "./components/DocumentHistory";
import type { LocateChange } from "./lib/reviewTypes";
import { InterfaceEditor } from "./components/InterfaceEditor";
import type { Quotation } from "./lib/references";
import {
  useWorkspaceLayout,
  WorkspaceRail,
  PanelResize,
  ComponentPalette,
} from "./components/WorkspaceLayout";
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
import {
  SimulationMenu,
  SimulationTransport,
} from "./components/SimulationControls";
import { documentComponent, type ConnectionFocus } from "./lib/connections";
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
  Plus,
  Search,
  Ellipsis,
  FileText,
  X,
  PanelRight,
  PanelLeft,
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
  const [infoTarget, setInfoTarget] = useState<string | null>(null);
  const shownDocumentWarnings = useRef(new Set<string>());
  const [saveFailures, setSaveFailures] = useState<Record<string, string>>({});
  const [decision, setDecision] = useState<Decision | null>(null);
  const [lastCapture, setLastCapture] = useState<ObservationRecord | null>(
    null,
  );
  const [circuitPrompt, setCircuitPrompt] = useState(false);
  const [renameCircuit, setRenameCircuit] = useState(false);
  const [interfaceTarget, setInterfaceTarget] = useState<{
    doc: Document;
    circuit: string;
  } | null>(null);
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
  const [quotation, setQuotation] = useState<Quotation | null>(null);
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
      for (const doc of next) {
        const result = doc as Document & {
          historyWarning?: string;
          referenceWarning?: string;
        };
        const message = [result.historyWarning, result.referenceWarning]
          .filter(Boolean)
          .join("；");
        const key = `${doc.id}:${doc.revision}:${message}`;
        if (message && !shownDocumentWarnings.current.has(key)) {
          shownDocumentWarnings.current.add(key);
          setNotice(`${doc.name}：${message}`);
        }
      }
      setSaveFailures((previous) =>
        Object.fromEntries(
          next.flatMap((doc) => {
            const failure = (doc as Document & { saveError?: string })
              .saveError;
            return failure
              ? [[doc.id, failure]]
              : doc.dirty && previous[doc.id]
                ? [[doc.id, previous[doc.id]]]
                : [];
          }),
        ),
      );
    },
    [],
  );
  const setActive = useCallback((id: string | null) => {
    workspaceEpoch.current++;
    currentActive.current = id;
    setActiveState(id);
  }, []);
  const [tool, setTool] = useState<Tool>("select"),
    [place, setPlace] = useState<CatalogTool | null>(null);
  const [catalog, setCatalog] = useState<CatalogGroup[]>([]),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(0);
  const [sim, setSim] = useState<Simulation | null>(null),
    [fitToken, setFit] = useState(0),
    [right, setRight] = useState<"chat" | "connections" | "changes">("chat");
  const [zoom, setZoom] = useState(1);
  const [zoomRequest, setZoomRequest] = useState({ token: 0, factor: 1 });
  const [canvasObservation, setCanvasObservation] = useState<{
    scope: string;
    focus: ConnectionFocus | null;
  }>({ scope: "", focus: null });
  const [frequency, setFrequency] = useState(2);
  const simulationSequence = useRef(0);
  const [simulationRequests, setSimulationRequests] = useState<
    { id: number; scope: string; op: string }[]
  >([]);
  const [source, setSource] = useState<{
      xml: string;
      id: string;
      name: string;
      revision: string;
      circuit: string;
      error?: string;
    } | null>(null),
    [settings, setSettings] = useState(false);
  const {
    bindings: shortcutBindings,
    labels: shortcuts,
    save: saveShortcuts,
  } = useShortcuts();
  const [signalView, setSignalView] = useState<React.ReactNode>(null);
  const layout = useWorkspaceLayout();
  const { showExplorer, setShowExplorer, showRight, setShowRight } = layout;
  const [resourceTab, setResourceTab] = useState<"files" | "components">(
    "files",
  );
  const [circuitSearch, setCircuitSearch] = useState("");
  const circuitSearchInput = useRef<HTMLInputElement>(null);
  const [showGrid, setShowGrid] = useState(false);
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
  useEffect(() => {
    if (!doc) setRight("chat");
  }, [doc?.id]);
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
  const currentSelected = useRef(selected);
  currentSelected.current = selected;
  const selection = selected.scope === selectionScope ? selected.ids : [];
  const setSelection = (ids: string[]) =>
    setSelected({ scope: selectionScope, ids });
  const currentSelectionScope = useRef(selectionScope);
  currentSelectionScope.current = selectionScope;
  const simulationPending =
    simulationRequests.find((request) => request.scope === selectionScope)
      ?.op || null;
  const connectionComponent =
    canvasObservation.scope === selectionScope &&
    selection.length === 1 &&
    circuit
      ? canvasObservation.focus?.components.find(
          (component) =>
            documentComponent(circuit, component)?.id === selection[0],
        ) || null
      : null;
  const navigationRequest = useRef(0);
  const sourceRequest = useRef(0);
  const { sourceStatus, recheck } = useSourceStatus(doc);
  const onError = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const onFolder = (next: ProjectFolder) => {
    workspaceEpoch.current++;
    setFolder(next);
    layout.revealFiles();
  };
  const { openFolder, folderDialog } = useFolderPicker(onFolder, onError);
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
  const mergeDocument = useCallback(
    (document: Document, expectedBaseRevision?: string) => {
      const current = currentDocs.current.find(
        (item) => item.id === document.id,
      );
      if (!current) return;
      if (
        expectedBaseRevision &&
        current.revision !== expectedBaseRevision &&
        current.revision !== document.revision
      ) {
        // A later host event may arrive before this mutation response. Hashes have no ordering.
        void refreshWorkspace().catch(onError);
        return;
      }
      setDocs((previous) =>
        previous.map((item) => (item.id === document.id ? document : item)),
      );
    },
    [setDocs, refreshWorkspace, onError],
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
    mergeDocument(saved, target.revision);
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
      mergeDocument(next, doc.revision);
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
    const originSelection = currentSelected.current;
    const originNavigation = navigationRequest.current;
    const next = await busy(() =>
      command<Document>({
        op: "edit",
        id: doc.id,
        revision: doc.revision,
        circuit: circuit.name,
        edit,
      }),
    );
    mergeDocument(next, doc.revision);
    // A field commit keeps its object selected. Preserve the revision guard for
    // other edits, late responses and selections the user changed meanwhile.
    if (
      edit.kind === "attributes" &&
      currentSelected.current === originSelection &&
      currentActive.current === doc.id &&
      navigationRequest.current === originNavigation &&
      currentDocs.current.find((item) => item.id === doc.id)?.revision ===
        next.revision &&
      originSelection.scope === selectionScope &&
      originSelection.ids.includes(edit.id) &&
      next.circuits
        .find((item) => item.name === circuit.name)
        ?.components.some((item) => item.id === edit.id)
    ) {
      setSelected({
        scope: `${doc.id}:${next.revision}:${circuit.name}`,
        ids: [edit.id],
      });
    }
  };
  const history = (op: "undo" | "redo") => {
    if (doc)
      void busy(() =>
        command<Document>({ op, id: doc.id, revision: doc.revision }),
      )
        .then((next) => mergeDocument(next, doc.revision))
        .catch(onError);
  };
  const readSource = async () => {
    if (!doc || !circuit) return;
    const requested = ++sourceRequest.current;
    const navigation = navigationRequest.current;
    const stillCurrent = () =>
      requested === sourceRequest.current &&
      navigation === navigationRequest.current &&
      currentSelectionScope.current === selectionScope;
    try {
      const result = await command<{ xml: string }>({
        op: "source",
        id: doc.id,
        revision: doc.revision,
      });
      if (stillCurrent())
        setSource({
          xml: result.xml,
          id: doc.id,
          name: doc.name,
          revision: doc.revision,
          circuit: circuit.name,
        });
    } catch (error) {
      if (stillCurrent()) onError(error);
    }
  };
  const simulationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const simulate = async (
    op: string,
    attributes: Record<string, string> = {},
  ) => {
    if (!doc || !circuit) return;
    const origin = selectionScope;
    const navigation = navigationRequest.current;
    const sequence = ++simulationSequence.current;
    const request =
      op === "stop"
        ? { op: "simulationStop" as const }
        : {
            op: "simulationAction" as const,
            id: doc.id,
            revision: doc.revision,
            circuit: circuit.name,
            command: op,
            attributes: { initialFrequency: String(frequency), ...attributes },
          };
    const previous = simulationQueue.current;
    setSimulationRequests((items) => [
      ...items,
      { id: sequence, scope: origin, op },
    ]);
    const next = busy(async () => {
      await previous.catch(() => {});
      // A queued action belongs to the view where it was requested. Releasing
      // a held button is safe across navigation: the host checks its viewId.
      if (
        op !== "button-release" &&
        (currentSelectionScope.current !== origin ||
          navigationRequest.current !== navigation)
      )
        return;
      await command(request);
    }).finally(() => {
      setSimulationRequests((items) =>
        items.filter((item) => item.id !== sequence),
      );
    });
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
          layout.revealFiles();
          setResourceTab("components");
          requestAnimationFrame(() => searchInput.current?.focus());
        } else if (shortcut === "rotate") {
          if (place && canRotate) placement.rotate();
        } else if (shortcut === "save") save();
        else if (shortcut === "undo") history("undo");
        else if (shortcut === "find" && doc) setFind("component");
        else if (shortcut === "circuitSearch" && doc) {
          layout.revealNavigator();
          requestAnimationFrame(() => circuitSearchInput.current?.focus());
        } else if (shortcut === "fit") setFit((n) => n + 1);
        else if (shortcut === "grid") setShowGrid((shown) => !shown);
        else if (shortcut === "rail") setShowExplorer((shown) => !shown);
        else if (shortcut === "review") setShowRight((shown) => !shown);
        else if (shortcut === "capture") void capture().catch(onError);
        else if (shortcut === "clock")
          void simulate("toggle-clock").catch(onError);
        else if (shortcut === "propagation")
          void simulate("toggle-propagation").catch(onError);
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
        sourceRequest.current++;
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
    const requested = ++navigationRequest.current;
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
        .then((next) => {
          if (
            requested === navigationRequest.current &&
            currentActive.current === doc.id &&
            currentDocs.current.find((current) => current.id === doc.id)
              ?.revision === doc.revision
          )
            setSim(next);
        })
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
  const locateChange = ({ circuit: name, revision, object }: LocateChange) => {
    if (!doc || revision !== doc.revision) {
      onError("文档已有后续修改，无法定位这份对照中的对象");
      return;
    }
    const definition = doc.circuits.find((item) => item.name === name);
    const matches =
      definition?.components.filter(
        (item) =>
          item.name === object.factory &&
          item.location.x === object.location.x &&
          item.location.y === object.location.y,
      ) || [];
    const wires =
      object.factory === "wire" && object.from && object.to
        ? definition?.wires.filter(
            (wire) =>
              wire.id === object.id &&
              ((wire.from.x === object.from!.x &&
                wire.from.y === object.from!.y &&
                wire.to.x === object.to!.x &&
                wire.to.y === object.to!.y) ||
                (wire.from.x === object.to!.x &&
                  wire.from.y === object.to!.y &&
                  wire.to.x === object.from!.x &&
                  wire.to.y === object.from!.y)),
          ) || []
        : [];
    const targets = [...matches, ...wires];
    if (targets.length !== 1) {
      onError("无法唯一对应当前工程中的对象");
      return;
    }
    const id = targets[0].id;
    switchCircuit(name);
    setSelected({ scope: `${doc.id}:${doc.revision}:${name}`, ids: [id] });
    setFocusTarget({
      documentId: doc.id,
      revision: doc.revision,
      circuit: name,
      id,
      token: Date.now(),
    });
    layout.revealInspector();
  };
  const followConversationReference = useConversationReferences({
    doc,
    folder,
    onCircuit: (name, id) => {
      if (!doc) return;
      switchCircuit(name);
      setSelected({ scope: `${doc.id}:${doc.revision}:${name}`, ids: [id] });
      setFocusTarget({
        documentId: doc.id,
        revision: doc.revision,
        circuit: name,
        id,
        token: Date.now(),
      });
      layout.revealInspector();
    },
    onDocument: (document) => {
      update(document);
      setCircuitName(document.main);
    },
    onPreview: setPreview,
    onNotice: setNotice,
    onError,
  });
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
    <div
      className="app"
      data-workspace={doc ? "circuit" : folder ? "folder" : "empty"}
    >
      {folderDialog}
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
        <button
          className="icon-button project-toggle"
          title="展开 / 收起项目栏"
          aria-label="展开 / 收起项目栏"
          aria-controls="workspace-projects"
          aria-expanded={showExplorer}
          onClick={() => setShowExplorer((shown) => !shown)}
        >
          <PanelLeft size={18} />
        </button>
        <div className="brand">
          <svg aria-hidden="true" viewBox="0 0 38 38">
            <path d="M4 10h10v9h10v9h10" />
            <circle cx="4" cy="10" r="2.3" />
            <circle cx="14" cy="19" r="2.3" />
            <circle cx="24" cy="28" r="2.3" />
            <circle cx="34" cy="28" r="2.3" />
          </svg>
          <span>Vibe Logisim</span>
        </div>
        <div className="file-title">
          {doc && (
            <>
              <button
                title="文件信息与导出"
                onClick={() => setInfoTarget(doc.id)}
              >
                <FileText size={15} />
                {doc.name}
              </button>
              {doc.dirty && (
                <span className="dirty-dot" title="有未保存的修改" />
              )}
            </>
          )}
        </div>
        <div className="title-actions">
          {doc && circuit && (
            <SimulationMenu
              contextKey={selectionScope}
              circuitName={circuit.name}
              activeSim={activeSim}
              busyAction={simulationPending}
              disabled={Boolean(pending)}
              shortcuts={shortcuts}
              simulate={simulate}
              capture={capture}
              onError={onError}
              onObservations={() => setObservations({ documentId: doc.id })}
              frequency={
                Number(activeSim?.frame.attributes.frequency) || frequency
              }
              onFrequencyChange={async (value) => {
                if (activeSim)
                  await simulate("configure", { frequency: String(value) });
                if (currentSelectionScope.current === selectionScope)
                  setFrequency(value);
              }}
              onReturnToSimulation={
                sim &&
                !activeSim &&
                docs.some(
                  (item) =>
                    item.id === sim.documentId &&
                    item.revision === sim.revision,
                )
                  ? () => {
                      const owner = docs.find(
                        (item) =>
                          item.id === sim.documentId &&
                          item.revision === sim.revision,
                      );
                      if (!owner) return;
                      navigationRequest.current++;
                      setActive(owner.id);
                      setCircuitName(sim.circuit);
                      setSelection([]);
                      void command({ op: "activate", id: owner.id }).catch(
                        onError,
                      );
                    }
                  : undefined
              }
            />
          )}
          <button className="open-folder" onClick={() => void openFolder()}>
            <FolderOpen size={17} /> 打开文件夹
          </button>
          <details className="menu">
            <summary aria-label="更多" title="更多：文件、快捷键、反馈与更新">
              <Ellipsis size={18} />
            </summary>
            <div className="menu-content">
              <button aria-label="新建电路文件" onClick={() => void newFile()}>
                新建电路 <kbd>Ctrl N</kbd>
              </button>
              <button onClick={openFile}>
                打开… <kbd>Ctrl O</kbd>
              </button>
              <button onClick={() => void openFolder()}>打开文件夹…</button>
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
              <button
                disabled={!doc}
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  if (doc) setInfoTarget(doc.id);
                }}
              >
                文件信息与导出…
              </button>
              <button disabled={!doc} onClick={() => setFind("component")}>
                查找元件… <kbd>{shortcuts.find}</kbd>
              </button>
              <button disabled={!doc} onClick={() => setFind("circuit")}>
                查找电路… <kbd>{shortcuts.circuitSearch}</kbd>
              </button>
              <button disabled={!doc} onClick={() => void readSource()}>
                编辑源文件
              </button>
              <button
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  setSettings(true);
                }}
              >
                快捷键设置
              </button>
              <FeedbackMenu feedback={feedback} />
            </div>
          </details>
          <button
            className="icon-button"
            title="展开 / 收起工作栏"
            aria-label="展开 / 收起工作栏"
            aria-controls="workspace-review"
            aria-expanded={showRight}
            onClick={() => setShowRight((shown) => !shown)}
          >
            <PanelRight size={18} />
          </button>
        </div>
      </header>
      <UpdateNotice feedback={feedback} />
      <div className="workspace" ref={layout.workspace}>
        {layout.narrow && (showExplorer || showRight) && (
          <button
            className="workspace-shade"
            aria-label="关闭侧栏"
            onClick={layout.closeDrawers}
          />
        )}
        <WorkspaceRail
          layout={layout}
          hasCircuit={Boolean(doc)}
          title={folder?.name || "文件"}
          resourceTab={resourceTab}
          onResourceTab={setResourceTab}
          files={
            <Files
              folder={folder}
              activePath={doc?.path || null}
              onFolder={onFolder}
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
          }
          palette={
            <ComponentPalette
              catalog={catalog}
              search={search}
              onSearch={setSearch}
              inputRef={searchInput}
              shortcut={shortcuts.palette}
              place={place}
              onSelect={(t) => {
                setPlace(t);
                setSelection([]);
                layout.revealInspector();
                setTool("select");
                if (layout.narrow) layout.closeDrawers();
              }}
            />
          }
          navigation={
            <>
              <label className="circuit-search">
                <Search size={14} />
                <input
                  ref={circuitSearchInput}
                  aria-label="查找电路"
                  placeholder="查找电路"
                  value={circuitSearch}
                  onChange={(e) => setCircuitSearch(e.target.value)}
                />
                <kbd>{shortcuts.circuitSearch}</kbd>
              </label>{" "}
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
                          void command({ op: "activate", id: d.id }).catch(
                            onError,
                          );
                          setCircuitName(d.main);
                          setSelection([]);
                          layout.closeDrawers();
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
                        {d.circuits
                          .filter((c) =>
                            c.name
                              .toLowerCase()
                              .includes(circuitSearch.toLowerCase()),
                          )
                          .map((c) => (
                            <div className="circuit-row" key={c.name}>
                              <button
                                className={
                                  c.name === circuit?.name ? "active" : ""
                                }
                                onClick={() => switchCircuit(c.name)}
                                title={d.main === c.name ? "主电路" : undefined}
                              >
                                {c.name}
                                {d.main === c.name && (
                                  <span
                                    className="main-marker"
                                    aria-label="主电路"
                                  >
                                    ⌂
                                  </span>
                                )}
                              </button>
                              {c.name === circuit?.name && (
                                <details className="menu">
                                  <summary aria-label="电路操作">···</summary>
                                  <div
                                    className="menu-content"
                                    onClick={(event) => {
                                      if (
                                        (event.target as HTMLElement).closest(
                                          "button:not(:disabled)",
                                        )
                                      )
                                        event.currentTarget
                                          .closest("details")
                                          ?.removeAttribute("open");
                                    }}
                                  >
                                    <button
                                      onClick={() => setRenameCircuit(true)}
                                    >
                                      重命名…
                                    </button>
                                    <button
                                      onClick={() =>
                                        setInterfaceTarget({
                                          doc: d,
                                          circuit: c.name,
                                        })
                                      }
                                    >
                                      封装与接口…
                                    </button>
                                    <button
                                      disabled={d.main === c.name}
                                      onClick={() =>
                                        void edit({ kind: "setMain" }).catch(
                                          onError,
                                        )
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
                                                await edit({
                                                  kind: "deleteCircuit",
                                                });
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
            </>
          }
          navigatorActions={
            <>
              {actionButton("打开电路", <FolderOpen size={15} />, openFile)}
              {actionButton(
                "新建电路文件",
                <FilePlus2 size={15} />,
                () => void newFile(),
              )}
            </>
          }
          inspectorActions={
            selection.length ? (
              <button
                className="quiet-button"
                title="取消当前选择"
                onClick={() => setSelection([])}
              >
                取消选择
              </button>
            ) : null
          }
          inspector={
            place ? (
              <PlacementInspector
                key={`${doc?.id}:${place.library}:${place.name}`}
                placement={placement}
              />
            ) : circuit ? (
              <Inspector
                doc={doc!}
                circuit={circuit}
                selection={selection}
                connectionComponent={connectionComponent}
                onOpenMemory={openMemory}
                edit={edit}
                simulation={activeSim}
                simulate={simulate}
                onError={onError}
              />
            ) : (
              <div className="quiet-empty">选择元件以查看属性</div>
            )
          }
        />
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
              {saveFailures[doc.id] && (
                <div className="source-notice" role="alert">
                  <span>修改已保留，写回文件失败：{saveFailures[doc.id]}</span>
                  <button disabled={Boolean(pending)} onClick={() => save()}>
                    重试保存
                  </button>
                </div>
              )}
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
                <div className="circuit-actions">
                  <button
                    onClick={() =>
                      setInterfaceTarget({ doc, circuit: circuit.name })
                    }
                  >
                    封装与接口
                  </button>
                  <button
                    onClick={() => setFind("component")}
                    title={`查找元件（${shortcuts.find}）`}
                  >
                    查找元件
                  </button>
                </div>
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
                {activeSim && (
                  <span className="muted">
                    运行实例 · {activeSim.rootCircuit}
                    {activeSim.instancePath.length ? ` / ${circuit.name}` : ""}
                  </span>
                )}
                {sim && !activeSim && (
                  <span className="muted">{sim.circuit} 的仿真保留中</span>
                )}
              </div>
              <div className="canvas-surface">
                <EditorToolbar
                  tool={tool}
                  place={place}
                  shortcuts={shortcuts}
                  pending={pending}
                  canUndo={doc.canUndo}
                  canRedo={doc.canRedo}
                  hasSelection={Boolean(selection.length)}
                  onTool={setTool}
                  onCancelPlace={() => setPlace(null)}
                  onHistory={history}
                  onDelete={() =>
                    void edit({ kind: "delete", ids: selection }).catch(onError)
                  }
                  onFit={() => setFit((n) => n + 1)}
                  zoom={zoom}
                  onZoom={(factor) =>
                    setZoomRequest((previous) => ({
                      token: previous.token + 1,
                      factor,
                    }))
                  }
                  showGrid={showGrid}
                  onToggleGrid={() => setShowGrid((shown) => !shown)}
                />
                <SimulationTransport
                  activeSim={activeSim}
                  busyAction={simulationPending}
                  disabled={Boolean(pending)}
                  shortcuts={shortcuts}
                  simulate={simulate}
                  onError={onError}
                  tool={tool}
                  stale={Boolean(
                    sim &&
                    sim.documentId === doc.id &&
                    sim.circuit === circuit.name &&
                    sim.revision !== doc.revision,
                  )}
                />
                <Canvas
                  key={`${doc.id}:${circuit.name}`}
                  doc={doc}
                  circuit={circuit}
                  tool={tool}
                  selection={selection}
                  setSelection={(s) => {
                    setSelection(s);
                    if (s.length) layout.revealInspector();
                  }}
                  place={place}
                  edit={edit}
                  simulation={sim}
                  simulate={simulate}
                  onError={onError}
                  fitToken={fitToken}
                  zoomRequest={zoomRequest}
                  onZoomChange={setZoom}
                  onObservation={setCanvasObservation}
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
                    mergeDocument(next, revision);
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
                    setRight("connections");
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
              </div>
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
              <svg
                className="empty-symbol"
                aria-hidden="true"
                viewBox="0 0 180 120"
              >
                <path d="M9 74h38V34h34v61h39V54h50" />
                <circle cx="9" cy="74" r="5" />
                <circle cx="47" cy="34" r="5" />
                <circle cx="81" cy="95" r="5" />
                <circle cx="120" cy="54" r="5" />
                <circle cx="170" cy="54" r="5" />
              </svg>
              <h1>{folder ? "选择一个电路" : "尚未打开项目"}</h1>
              <div>
                <button
                  className="primary"
                  onClick={folder ? openFile : () => void openFolder()}
                >
                  <FolderOpen size={17} />
                  {folder ? "打开电路" : "打开文件夹"}
                </button>
              </div>
            </div>
          )}
        </main>
        <aside
          id="workspace-review"
          className={"right-panel" + (layout.narrow ? " workspace-drawer" : "")}
          style={{
            width: layout.sizes.review,
            display: showRight ? undefined : "none",
          }}
        >
          <div className="panel-tabs">
            <button
              className={right === "chat" ? "active" : ""}
              onClick={() => setRight("chat")}
            >
              对话
            </button>
            <button
              className={right === "connections" ? "active" : ""}
              onClick={() => setRight("connections")}
            >
              连接
            </button>
            <button
              className={right === "changes" ? "active" : ""}
              onClick={() => setRight("changes")}
            >
              改动
            </button>
          </div>
          {right === "connections" &&
            (signalView || (
              <div className="quiet-empty">
                选中元件或导线后，Ctrl+点击信号可定位来源。
              </div>
            ))}
          {!layout.narrow && <PanelResize side="review" layout={layout} />}
          <DocumentHistory
            doc={doc}
            circuit={circuit?.name || null}
            visible={right === "changes" && showRight}
            onError={onError}
            onDocument={mergeDocument}
            onLocate={locateChange}
          />
          <Chat
            onLocate={locateChange}
            visible={right === "chat" && showRight}
            doc={doc}
            circuit={circuit?.name || null}
            onError={onError}
            onDocument={mergeDocument}
            folder={folder}
            selection={selection}
            quotation={quotation}
            onFollowReference={(href, message) =>
              followConversationReference(href, message.context)
            }
            onQuoted={(id) =>
              setQuotation((current) => (current?.id === id ? null : current))
            }
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
        <Observations
          {...observations}
          onClose={() => setObservations(null)}
          onQuote={(references) => {
            if (!doc || doc.id !== observations.documentId) return;
            setQuotation({
              id: crypto.randomUUID(),
              documentId: doc.id,
              references,
            });
            setObservations(null);
            setRight("chat");
            setShowRight(true);
          }}
        />
      )}
      {interfaceTarget && (
        <InterfaceEditor
          doc={interfaceTarget.doc}
          circuit={interfaceTarget.circuit}
          onDocument={mergeDocument}
          onClose={() => setInterfaceTarget(null)}
        />
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
          onQuote={(reference) => {
            if (doc) {
              setQuotation({
                id: crypto.randomUUID(),
                documentId: doc.id,
                references: [reference],
              });
              setRight("chat");
              setShowRight(true);
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
              <Code2 size={18} /> {source.name}
              <button
                disabled={Boolean(pending)}
                onClick={() => setSource(null)}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </header>
            <textarea
              value={source.xml}
              disabled={Boolean(pending)}
              onChange={(e) => setSource({ ...source, xml: e.target.value })}
              spellCheck={false}
            />
            {source.error && (
              <p className="dialog-error" role="alert">
                {source.error}
              </p>
            )}
            <footer>
              <button
                disabled={Boolean(pending)}
                onClick={() => setSource(null)}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={Boolean(pending)}
                onClick={() =>
                  void busy(() =>
                    command<Document>({
                      op: "edit",
                      id: source.id,
                      revision: source.revision,
                      circuit: source.circuit,
                      edit: { kind: "replace", xml: source.xml },
                    }),
                  )
                    .then((next) => mergeDocument(next, source.revision))
                    .then(() => setSource(null))
                    .catch((error) =>
                      setSource((current) =>
                        current?.id === source.id &&
                        current.revision === source.revision
                          ? {
                              ...current,
                              error:
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                            }
                          : current,
                      ),
                    )
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
              layout.revealInspector();
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
      {infoTarget && docs.some((document) => document.id === infoTarget) && (
        <ProjectInfo
          key={infoTarget}
          doc={docs.find((document) => document.id === infoTarget)!}
          onClose={() => setInfoTarget(null)}
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
