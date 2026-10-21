import type { RefCallback } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { field, type Update } from "./setter";

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
export const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(n, max));
const layoutKey = "vibe.workspace.layout";

function savedLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) || "null");
    if (!saved) return { ...layoutDefaults };
    return {
      ...layoutDefaults,
      rail: clamp(Number(saved.rail) || 260, 224, 420),
      review: clamp(Number(saved.review) || 400, 320, 820),
      fileShare: clamp(Number(saved.fileShare) || 0.32, 0.1, 0.8),
      navigatorShare: clamp(Number(saved.navigatorShare) || 0.3, 0.1, 0.8),
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
  /** Measured width of the workspace element. */
  width: number;
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
  changeWidth(side: Side, value: number): void;
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

/** Panel widths: requested widths shrink together when the window is too narrow. */
export function panelSizes(
  layout: Layout,
  visible: Record<Side, boolean>,
  width: number,
) {
  const extra = Math.max(
    0,
    width - 440 - (visible.rail ? 224 : 0) - (visible.review ? 320 : 0),
  );
  const requested =
    (visible.rail ? layout.rail - 224 : 0) +
    (visible.review ? layout.review - 320 : 0);
  const ratio = requested > extra ? extra / requested : 1;
  return {
    rail: 224 + (layout.rail - 224) * ratio,
    review: 320 + (layout.review - 320) * ratio,
  };
}

export function createShellStore() {
  return createStore<ShellState>()((set, get) => {
    const measure = (node: HTMLDivElement) => {
      const narrow = window.innerWidth <= 820;
      const width = node.clientWidth || window.innerWidth;
      // Crossing the narrow breakpoint closes any drawer.
      set((state) => ({
        narrow,
        width,
        drawer: narrow === state.narrow ? state.drawer : null,
      }));
    };
    const reveal = (section: (typeof railSections)[number]) => {
      set((state) => ({ layout: { ...state.layout, [section]: false } }));
      get().setSide("rail", true);
    };
    return {
      layout: savedLayout(),
      narrow: window.innerWidth <= 820,
      width: window.innerWidth,
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
      changeWidth: (side, value) =>
        set((state) => ({
          layout: {
            ...state.layout,
            [side]: clamp(value, layoutLimits[side][0], layoutLimits[side][1]),
          },
        })),
      revealFiles: () => reveal("filesCollapsed"),
      revealNavigator: () => reveal("navigatorCollapsed"),
      revealInspector: () => reveal("inspectorCollapsed"),
      workspaceRef: (node) => {
        if (!node) return;
        const resize = () => measure(node);
        window.addEventListener("resize", resize);
        const observer = new ResizeObserver(resize);
        observer.observe(node);
        resize();
        return () => {
          window.removeEventListener("resize", resize);
          observer.disconnect();
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
