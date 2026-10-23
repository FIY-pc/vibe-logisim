import { createRef, type ReactNode, type RefObject } from "react";
import { createStore } from "zustand/vanilla";
import type { ConnectionFocus } from "./connectivity";
import type {
  CatalogGroup,
  CatalogTool,
  Document,
  Tool,
} from "../shared/types";
import type { PlacementState } from "./usePlacement";
import { createCounter, type Counter } from "../shared/counter";
import { field, type Update } from "../shared/setter";

/** Selected object ids. They apply only in the view scope they were chosen in
 * (document, revision and circuit), so any revision change clears them. */
export interface Selected {
  scope: string;
  ids: string[];
}
/** The XML source dialog's draft of one document revision. */
export interface SourceDraft {
  xml: string;
  id: string;
  name: string;
  revision: string;
  circuit: string;
  error?: string;
}
/** An object to reveal on the canvas; a new token reveals it again. */
export interface FocusTarget {
  documentId: string;
  revision: string;
  circuit: string;
  id: string;
  token: number;
}
export type FindMode = "component" | "circuit";

export interface EditorState {
  /** The shown circuit of the active document. A missing name shows the first circuit. */
  circuitName: string;
  tool: Tool;
  /** The catalog tool being placed. */
  place: CatalogTool | null;
  /** The component catalog of the shown circuit. */
  catalog: CatalogGroup[];
  /** The component palette's filter. */
  search: string;
  selected: Selected;
  /** Changes whenever the canvas should fit its content. */
  fitToken: number;
  /** The canvas zoom, as the canvas reports it. */
  zoom: number;
  /** Zoom steps requested from the toolbar. */
  zoomRequest: { token: number; factor: number };
  /** Deletions requested from the toolbar; the canvas commits them with its mask. */
  deleteRequest: { token: number; ids: string[] };
  /** The canvas's connection focus, by view scope. */
  canvasObservation: { scope: string; focus: ConnectionFocus | null };
  source: SourceDraft | null;
  /** Signal paths the canvas renders into the review panel's connections tab. */
  signalView: ReactNode;
  /** The circuit list's filter. */
  circuitSearch: string;
  showGrid: boolean;
  /** Whether an arrangement of the shown circuit is running. */
  arranging: boolean;
  /** The open find dialog. */
  find: FindMode | null;
  focusTarget: FocusTarget | null;
  /** Whether the new-circuit prompt is open. */
  circuitPrompt: boolean;
  /** Whether the rename-circuit prompt is open. */
  renameCircuit: boolean;
  /** The circuit whose interface editor is open. */
  interfaceTarget: { doc: Document; circuit: string } | null;
  /** Bumped by every navigation. Edits, source reads and simulation actions
   * that started before a navigation do not apply their results after it. */
  navigation: Counter;
  /** Bumped by every source read and by Escape: only the latest read opens. */
  sourceRequest: Counter;
  /** The component palette's search input. */
  searchInput: RefObject<HTMLInputElement | null>;
  /** The circuit list's search input. */
  circuitSearchInput: RefObject<HTMLInputElement | null>;
  /** The placement as last rendered, for the rotate shortcut. Not reactive. */
  placement: { current: PlacementState | null };
  setCircuitName(name: Update<string>): void;
  setTool(tool: Update<Tool>): void;
  setPlace(place: Update<CatalogTool | null>): void;
  setCatalog(catalog: Update<CatalogGroup[]>): void;
  setSearch(search: Update<string>): void;
  setSelected(selected: Update<Selected>): void;
  requestFit(): void;
  setZoom(zoom: Update<number>): void;
  requestZoom(factor: number): void;
  requestDelete(ids: string[]): void;
  setCanvasObservation(
    observation: Update<EditorState["canvasObservation"]>,
  ): void;
  setSource(source: Update<SourceDraft | null>): void;
  setSignalView(view: ReactNode): void;
  setCircuitSearch(search: Update<string>): void;
  setShowGrid(shown: Update<boolean>): void;
  setArranging(running: Update<boolean>): void;
  setFind(find: Update<FindMode | null>): void;
  setFocusTarget(target: Update<FocusTarget | null>): void;
  setCircuitPrompt(open: Update<boolean>): void;
  setRenameCircuit(open: Update<boolean>): void;
  setInterfaceTarget(target: Update<EditorState["interfaceTarget"]>): void;
}

export function createEditorStore() {
  return createStore<EditorState>()((set) => ({
    circuitName: "main",
    tool: "select",
    place: null,
    catalog: [],
    search: "",
    selected: { scope: "", ids: [] },
    fitToken: 0,
    zoom: 1,
    zoomRequest: { token: 0, factor: 1 },
    deleteRequest: { token: 0, ids: [] },
    canvasObservation: { scope: "", focus: null },
    source: null,
    signalView: null,
    circuitSearch: "",
    showGrid: false,
    arranging: false,
    find: null,
    focusTarget: null,
    circuitPrompt: false,
    renameCircuit: false,
    interfaceTarget: null,
    navigation: createCounter(),
    sourceRequest: createCounter(),
    searchInput: createRef<HTMLInputElement>(),
    circuitSearchInput: createRef<HTMLInputElement>(),
    placement: { current: null },
    setCircuitName: field(set, "circuitName"),
    setTool: field(set, "tool"),
    setPlace: field(set, "place"),
    setCatalog: field(set, "catalog"),
    setSearch: field(set, "search"),
    setSelected: field(set, "selected"),
    requestFit: () => set((state) => ({ fitToken: state.fitToken + 1 })),
    setZoom: field(set, "zoom"),
    requestZoom: (factor) =>
      set((state) => ({
        zoomRequest: { token: state.zoomRequest.token + 1, factor },
      })),
    requestDelete: (ids) =>
      set((state) => ({
        deleteRequest: { token: state.deleteRequest.token + 1, ids },
      })),
    setCanvasObservation: field(set, "canvasObservation"),
    setSource: field(set, "source"),
    setSignalView: (signalView) => set({ signalView }),
    setCircuitSearch: field(set, "circuitSearch"),
    setShowGrid: field(set, "showGrid"),
    setArranging: field(set, "arranging"),
    setFind: field(set, "find"),
    setFocusTarget: field(set, "focusTarget"),
    setCircuitPrompt: field(set, "circuitPrompt"),
    setRenameCircuit: field(set, "renameCircuit"),
    setInterfaceTarget: field(set, "interfaceTarget"),
  }));
}
