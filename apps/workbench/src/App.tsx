import { useConversationReferences } from "./lib/conversationReferences";
import { ProjectInfo } from "./components/ProjectInfo";
import { DocumentHistory } from "./components/DocumentHistory";
import type { LocateChange } from "./lib/reviewTypes";
import { InterfaceEditor } from "./components/InterfaceEditor";
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
import { eventBinding } from "./lib/shortcuts";
import { EditorToolbar } from "./components/EditorToolbar";
import {
  SimulationMenu,
  SimulationTransport,
} from "./components/SimulationControls";
import { documentComponent } from "./lib/connections";
import { FilePreview } from "./components/FilePreview";
import { MemoryPanel } from "./components/MemoryPanel";
import { Waveform } from "./components/Waveform";
import { Observations } from "./components/Observations";
import { subscribeEvents } from "./lib/events";
import { DecisionDialog } from "./components/DecisionDialog";
import { TextPrompt } from "./components/TextPrompt";
import { Files } from "./components/Files";
import { useEffect } from "react";
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
import { command, desktop } from "./lib/transport";
import {
  useConversation,
  useDocuments,
  useEditor,
  useFiles,
  useNotices,
  useSettings,
  useShell,
  useSimulation,
  useView,
} from "./workbench/hooks";
import { activeSimulation, currentView } from "./workbench/view";
import { sourceStatusOf } from "./stores/documents";
import {
  useOwnWorkbench,
  useWorkbench,
  WorkbenchProvider,
} from "./workbench/provider";
import type { Edit, Simulation, Tool } from "./lib/types";
export function App() {
  const workbench = useOwnWorkbench();
  useEffect(() => workbench.start(), [workbench]);
  return (
    <WorkbenchProvider value={workbench}>
      <Shell />
    </WorkbenchProvider>
  );
}
function Shell() {
  const { stores, actions } = useWorkbench();
  const { workspace, editor: editing, simulation: simulating } = actions;
  const { notice, decision, error, setNotice, setDecision, setError, onError } =
    useNotices((state) => state);
  const {
    docs,
    active,
    saveFailures,
    setActive,
    refreshWorkspace,
    mergeDocument,
    update,
    recheck,
  } = useDocuments((state) => state);
  const {
    folder,
    preview,
    infoTarget,
    folderPrompt,
    uploadInput: upload,
    setPreview,
    setInfoTarget,
    setFolderPrompt,
  } = useFiles((state) => state);
  const quotation = useConversation((state) => state.quotation);
  const { setQuotation } = stores.conversation.getState();
  const {
    setCircuitName,
    tool,
    setTool,
    place,
    setPlace,
    catalog,
    search,
    setSearch,
    selected,
    setSelected,
    fitToken,
    requestFit,
    zoom,
    setZoom,
    zoomRequest,
    requestZoom,
    canvasObservation,
    setCanvasObservation,
    source,
    setSource,
    signalView,
    setSignalView,
    circuitSearch,
    setCircuitSearch,
    showGrid,
    setShowGrid,
    find,
    setFind,
    focusTarget,
    setFocusTarget,
    circuitPrompt,
    setCircuitPrompt,
    renameCircuit,
    setRenameCircuit,
    interfaceTarget,
    setInterfaceTarget,
    navigation: navigationRequest,
    sourceRequest,
    searchInput,
    circuitSearchInput,
  } = useEditor((state) => state);
  const {
    sim,
    setSim,
    frequency,
    requests: simulationRequests,
    memory,
    setMemory,
    observations,
    setObservations,
    lastCapture,
    setLastCapture,
  } = useSimulation((state) => state);
  const pending = useShell((state) => state.pending);
  const right = useShell((state) => state.right);
  const resourceTab = useShell((state) => state.resourceTab);
  const { setRight, setResourceTab } = stores.shell.getState();
  const settings = useSettings((state) => state.open);
  const shortcutBindings = useSettings((state) => state.bindings);
  const shortcuts = useSettings((state) => state.labels);
  const { setOpen: setSettings, saveBindings: saveShortcuts } =
    stores.settings.getState();
  const layout = useWorkspaceLayout();
  const { showExplorer, setShowExplorer, showRight, setShowRight } = layout;
  const view = useView();
  const { doc, circuit, scope: selectionScope } = view;
  useEffect(() => {
    if (!doc) setRight("chat");
  }, [doc?.id]);
  const placement = usePlacement(doc, circuit, place);
  const canRotate =
    Boolean(placement.template?.attributes.facingAttribute) &&
    !placement.loading;
  const selection = selected.scope === selectionScope ? selected.ids : [];
  // Handlers act on the view of this render.
  const setSelection = (ids: string[]) => editing.select(view, ids);
  const save = (saveAs = false) => workspace.save(view, saveAs);
  const requestReload = () => workspace.requestReload(view);
  const edit = (change: Edit) => editing.edit(view, change);
  const history = (op: "undo" | "redo") => editing.history(view, op);
  const readSource = () => editing.readSource(view);
  const simulate = (op: string, attributes?: Record<string, string>) =>
    simulating.simulate(view, op, attributes);
  const capture = () => simulating.capture(view);
  const openMemory = (id: string) => simulating.openMemory(view, id);
  const { newFile, openFile, requestClose, openFolder } = workspace;
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
  const sourceStatus = useDocuments((state) => sourceStatusOf(state, doc));
  const feedback = useFeedback(setNotice, onError);
  const activeSim = activeSimulation(sim, view);
  const memoryComponent =
    memory && memory.documentId === doc?.id && memory.circuit === circuit?.name
      ? circuit?.components.find(
          (c) =>
            c.name === memory.name &&
            c.location.x === memory.x &&
            c.location.y === memory.y,
        )
      : null;
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
        } else if (shortcut === "fit") requestFit();
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
        sourceRequest.next();
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
    const requested = navigationRequest.next();
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
            stores.documents.getState().active === doc.id &&
            stores.documents
              .getState()
              .docs.find((current) => current.id === doc.id)?.revision ===
              doc.revision
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
    const requested = navigationRequest.next();
    const next = await command<Simulation>({
      op: "simulationView",
      id: doc.id,
      revision: doc.revision,
      path,
    });
    if (
      requested !== navigationRequest.current ||
      currentView(stores).scope !== scope
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
      {folderPrompt && (
        <TextPrompt
          title="打开文件夹"
          onClose={() => setFolderPrompt(false)}
          onSubmit={workspace.openFolderAt}
        />
      )}
      <input
        hidden
        ref={upload}
        type="file"
        accept=".circ"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) workspace.importFile(file);
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
              onFrequencyChange={(value) =>
                simulating.changeFrequency(view, value)
              }
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
                      navigationRequest.next();
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
              onFolder={workspace.onFolder}
              onRename={() => refreshWorkspace()}
              onOpen={workspace.openDocument}
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
              onSelect={(t) => editing.startPlacing(view, t)}
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
                          navigationRequest.next();
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
                  onFit={requestFit}
                  zoom={zoom}
                  onZoom={requestZoom}
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
                  setSelection={(s) => editing.inspect(view, s)}
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
                  onPlace={(revision, change) =>
                    editing.placeComponent(doc, circuit.name, revision, change)
                  }
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
                onClick={() => editing.applySource(source)}
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
