import {
  createWheelStepBuffer,
  mapEditingWheel,
  mapPresentationKey,
} from "ooxml-ui/pptx";

const controls =
  'input,textarea,select,button,a,[role="button"],[role="textbox"],[contenteditable]:not([contenteditable="false"])';
const navigationKeys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

interface Navigation {
  enabled: boolean;
  page: number;
  count: number;
  viewport: HTMLElement | null;
  slide: HTMLElement | null;
  goTo(page: number): void;
}

/** Scope reading gestures to this canvas, leaving forms, links and the rest of the workbench alone. */
export function bindPresentationNavigation(
  canvas: HTMLElement,
  current: () => Navigation,
): () => void {
  const isControl = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest(controls);
  const hasSelection = () => {
    const selection = canvas.ownerDocument.getSelection();
    return (
      selection &&
      !selection.isCollapsed &&
      (canvas.contains(selection.anchorNode) ||
        canvas.contains(selection.focusNode))
    );
  };
  const keydown = (event: KeyboardEvent) => {
    const state = current();
    if (
      !state.enabled ||
      event.defaultPrevented ||
      isControl(event.target) ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (event.shiftKey && event.key !== " ") ||
      hasSelection() ||
      !navigationKeys.has(event.key)
    )
      return;
    const action =
      event.key === " " && event.shiftKey
        ? ({ action: "previous" } as const)
        : mapPresentationKey(event);
    const destination = {
      next: state.page + 1,
      previous: state.page - 1,
      first: 1,
      last: state.count,
    }[action.action as "next" | "previous" | "first" | "last"];
    if (destination === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) state.goTo(destination);
  };
  const pointerdown = (event: PointerEvent) => {
    if (event.button === 0 && !isControl(event.target))
      canvas.focus({ preventScroll: true });
  };
  let buffer = createWheelStepBuffer();
  let lastWheel = -Infinity;
  let direction = 0;
  let consumed = false;
  const wheel = (event: WheelEvent) => {
    const state = current();
    if (
      !state.enabled ||
      event.defaultPrevented ||
      isControl(event.target) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      Math.abs(event.deltaY) <= Math.abs(event.deltaX)
    )
      return;
    const nextDirection = Math.sign(event.deltaY);
    // Trackpad momentum belongs to the same gesture, not a queue of page turns.
    if (event.timeStamp - lastWheel > 180 || nextDirection !== direction) {
      buffer = createWheelStepBuffer();
      consumed = false;
    }
    lastWheel = event.timeStamp;
    direction = nextDirection;
    const viewport = state.viewport?.getBoundingClientRect();
    const slide = state.slide?.getBoundingClientRect();
    if (!viewport || !slide) return;
    const canScroll =
      direction > 0
        ? slide.bottom > viewport.bottom + 1
        : slide.top < viewport.top - 1;
    const mapped = mapEditingWheel(event, buffer, canScroll);
    if (mapped.intent === "scroll") {
      // After inspecting a zoomed page, start a fresh gesture to leave it.
      consumed = true;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (consumed) return;
    if (mapped.intent === "next-slide" || mapped.intent === "previous-slide") {
      consumed = true;
      state.goTo(state.page + (mapped.intent === "next-slide" ? 1 : -1));
    }
  };
  canvas.addEventListener("keydown", keydown);
  canvas.addEventListener("pointerdown", pointerdown, true);
  // A native non-passive listener can cancel paging without cancelling Ctrl+wheel zoom.
  canvas.addEventListener("wheel", wheel, { capture: true, passive: false });
  return () => {
    canvas.removeEventListener("keydown", keydown);
    canvas.removeEventListener("pointerdown", pointerdown, true);
    canvas.removeEventListener("wheel", wheel, true);
  };
}
