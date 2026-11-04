import type { RefCallback } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { field, type Update } from "../shared/setter";

/** Panel sizes and section states of the workspace frame, persisted across launches. */
export const layoutDefaults = {
  rail: 260,
  review: 400,
  fileShare: 0.32,
  navigatorShare: 0.3,
  filesCollapsed: false,
  navigatorCollapsed: false,
  inspectorCollapsed: false,
};
export type Layout = typeof layoutDefaults;
export type Side = "rail" | "review";
export const layoutLimits = { rail: [224, 420], review: [320, 820] };
export const railSections = [
  "filesCollapsed",
  "navigatorCollapsed",
  "inspectorCollapsed",
] as const;
const layoutKey = "vibe.workspace.layout";

function savedLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) || "null");
    if (!saved) return { ...layoutDefaults };
    const positive = (value: unknown, fallback: number) =>
      Number.isFinite(Number(value)) && Number(value) > 0
        ? Number(value)
        : fallback;
    const fileShare = positive(saved.fileShare, layoutDefaults.fileShare);
    const navigatorShare = positive(
      saved.navigatorShare,
      layoutDefaults.navigatorShare,
    );
    return {
      ...layoutDefaults,
      rail: positive(saved.rail, layoutDefaults.rail),
      review: positive(saved.review, layoutDefaults.review),
      ...(fileShare + navigatorShare < 1 ? { fileShare, navigatorShare } : {}),
      filesCollapsed: saved.filesCollapsed === true,
      navigatorCollapsed: saved.navigatorCollapsed === true,
      inspectorCollapsed:
        saved.inspectorCollapsed === true &&
        !(saved.filesCollapsed && saved.navigatorCollapsed),
    };
  } catch {
    return { ...layoutDefaults };
  }
}

export type ReviewTab = "chat" | "connections" | "changes";
export type ResourceTab = "files" | "components";

export interface ShellState {
  layout: Layout;
  /** Narrow windows show the rail and the review panel as drawers. */
  narrow: boolean;
  /** Which side panels are shown in a wide window. */
  visible: Record<Side, boolean>;
  /** The open drawer in a narrow window. */
  drawer: Side | null;
  /** The review panel's tab. */
  right: ReviewTab;
  /** The rail's resource tab. */
  resourceTab: ResourceTab;
  /** Host operations awaiting acknowledgement; see `busy`. */
  pending: number;
  setLayout(layout: Update<Layout>): void;
  setSide(side: Side, shown: Update<boolean>): void;
  closeDrawers(): void;
  revealFiles(): void;
  revealNavigator(): void;
  revealInspector(): void;
  /** Ref for the workspace element: measures it while mounted. */
  workspaceRef: RefCallback<HTMLDivElement>;
  setRight(right: Update<ReviewTab>): void;
  setResourceTab(tab: Update<ResourceTab>): void;
  /** Runs a host operation while counting it in `pending`, which disables
   * conflicting controls and guards page unload. */
  busy<T>(action: () => Promise<T>): Promise<T>;
}

export const showExplorer = (state: ShellState) =>
  state.narrow ? state.drawer === "rail" : state.visible.rail;
export const showRight = (state: ShellState) =>
  state.narrow ? state.drawer === "review" : state.visible.review;

export function createShellStore() {
  return createStore<ShellState>()((set, get) => {
    const measure = () => {
      const narrow = window.innerWidth <= 1000;
      // Crossing the narrow breakpoint closes any drawer.
      set((state) => ({
        narrow,
        drawer: narrow === state.narrow ? state.drawer : null,
      }));
    };
    const reveal = (section: (typeof railSections)[number]) => {
      set((state) => ({ layout: { ...state.layout, [section]: false } }));
      get().setSide("rail", true);
    };
    return {
      layout: savedLayout(),
      narrow: window.innerWidth <= 1000,
      visible: { rail: true, review: true },
      drawer: null,
      right: "chat",
      resourceTab: "files",
      pending: 0,
      setLayout: field(set, "layout"),
      setSide: (side, shown) => {
        const state = get();
        const open = side === "rail" ? showExplorer(state) : showRight(state);
        const value = typeof shown === "function" ? shown(open) : shown;
        if (state.narrow) set({ drawer: value ? side : null });
        else set({ visible: { ...state.visible, [side]: value } });
      },
      closeDrawers: () => set({ drawer: null }),
      revealFiles: () => reveal("filesCollapsed"),
      revealNavigator: () => reveal("navigatorCollapsed"),
      revealInspector: () => reveal("inspectorCollapsed"),
      workspaceRef: (node) => {
        if (!node) return;
        const resize = measure;
        window.addEventListener("resize", resize);
        resize();
        return () => {
          window.removeEventListener("resize", resize);
        };
      },
      setRight: field(set, "right"),
      setResourceTab: field(set, "resourceTab"),
      busy: async <T>(action: () => Promise<T>) => {
        set((state) => ({ pending: state.pending + 1 }));
        try {
          return await action();
        } finally {
          set((state) => ({ pending: state.pending - 1 }));
        }
      },
    };
  });
}

/** Writes the layout now and after every change; returns the unsubscribe. */
export function persistLayout(shell: StoreApi<ShellState>) {
  const write = (layout: Layout) => {
    try {
      localStorage.setItem(layoutKey, JSON.stringify(layout));
    } catch {}
  };
  write(shell.getState().layout);
  return shell.subscribe((state, previous) => {
    if (state.layout !== previous.layout) write(state.layout);
  });
}
