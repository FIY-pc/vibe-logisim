import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DELAY = 600,
  SKIP = 400,
  GAP = 6,
  EDGE = 6,
  ID = "app-tooltip";

/** Props that give an element a hint. The first line of `text` is the hint
 * itself and later lines explain it; `shortcut` is drawn beside the first
 * line. Hints use `data-tip` rather than `title`, whose tooltip each web view
 * draws in its own platform style. */
export const tip = (
  text: string | false | null | undefined,
  shortcut?: string | null,
) =>
  text
    ? { "data-tip": text, ...(shortcut ? { "data-tip-key": shortcut } : {}) }
    : {};

/** Props for a label cut short with an ellipsis: its full text shows as a
 * hint only while it does not fit. */
export const fullText = (text: string | false | null | undefined) =>
  text ? { "data-tip": text, "data-tip-overflow": "" } : {};

/** Whether an element, or a descendant, is clipped along its line. */
const clipped = (element: Element) =>
  [element, ...element.querySelectorAll("*")].some(
    (node) => node.scrollWidth - node.clientWidth > 1,
  );

interface Shown {
  anchor: Element;
  text: string;
  shortcut: string | null;
  /** A hint inside a modal dialog must render inside it to stay on top. */
  container: Element;
}

const NAVIGATION = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);
const anchorOf = (target: EventTarget | null) =>
  target instanceof Element ? target.closest("[data-tip]") : null;
const within = (element: Element, event: PointerEvent) => {
  const box = element.getBoundingClientRect();
  return (
    event.clientX >= box.left &&
    event.clientX <= box.right &&
    event.clientY >= box.top &&
    event.clientY <= box.bottom
  );
};
const typing = (node: Element) =>
  node.matches(
    "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
  );

/** The window's one tooltip. Hovering an element with `data-tip` shows its
 * hint after a pause (at once when moving between hints), keyboard focus
 * shows it too, and any press, key, scroll or wheel hides it. The hint sits
 * under its element and flips above near the bottom edge. */
export function Tooltips() {
  const [shown, setShown] = useState<Shown | null>(null);
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let anchor: Element | null = null,
      visible = false,
      timer = 0,
      cooled = 0,
      pressed: Element | null = null,
      watcher: MutationObserver | null = null,
      described: Element | null = null,
      navigated = 0;
    const read = (target: Element): Shown | null => {
      const text = target.getAttribute("data-tip");
      if (target.hasAttribute("data-tip-overflow") && !clipped(target))
        return null;
      return text
        ? {
            anchor: target,
            text,
            shortcut: target.getAttribute("data-tip-key"),
            container: target.closest("dialog[open]") || document.body,
          }
        : null;
    };
    const describe = (target: Element | null, text = "") => {
      if (described && described.getAttribute("aria-describedby") === ID)
        described.removeAttribute("aria-describedby");
      described = null;
      // Screen readers hear the hint unless it only repeats the name.
      if (
        target &&
        !target.hasAttribute("aria-describedby") &&
        text !== target.getAttribute("aria-label") &&
        text !== target.textContent?.trim()
      ) {
        target.setAttribute("aria-describedby", ID);
        described = target;
      }
    };
    const hide = () => {
      window.clearTimeout(timer);
      if (visible) cooled = performance.now();
      visible = false;
      anchor = null;
      watcher?.disconnect();
      watcher = null;
      describe(null);
      setShown(null);
    };
    const show = (target: Element) => {
      const next = read(target);
      if (!next || !target.isConnected) return hide();
      visible = true;
      describe(target, next.text);
      setShown(next);
      // Follow the element while its hint is up: new text, or gone.
      watcher?.disconnect();
      watcher = new MutationObserver(() => {
        if (!target.isConnected) return hide();
        const update = read(target);
        if (!update) return hide();
        setShown((old) =>
          old &&
          old.text === update.text &&
          old.shortcut === update.shortcut &&
          old.container === update.container
            ? old
            : update,
        );
      });
      watcher.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-tip", "data-tip-key"],
      });
    };
    const schedule = (target: Element) => {
      if (target === anchor) return;
      hide();
      anchor = target;
      // Moving straight from one hint to the next shows it without a pause.
      if (performance.now() - cooled < SKIP) show(target);
      else timer = window.setTimeout(() => show(target), DELAY);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = anchorOf(event.target);
      // A pressed element keeps its hint hidden until the pointer really
      // leaves it; a menu opening over it only redirects the events.
      if (pressed && target !== pressed && !within(pressed, event))
        pressed = null;
      if (event.buttons || !target || target === pressed) {
        if (anchor && target !== anchor) hide();
        return;
      }
      schedule(target);
    };
    const out = (event: PointerEvent) => {
      if (!event.relatedTarget) hide();
    };
    const press = () => {
      pressed = anchor;
      hide();
    };
    const key = (event: KeyboardEvent) => {
      navigated = NAVIGATION.has(event.key) ? performance.now() : 0;
      hide();
    };
    // Only focus the user moved shows a hint, not focus handed back by a
    // closing menu or dialog.
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || typing(target)) return;
      if (performance.now() - navigated > 300) return;
      const owner = anchorOf(target);
      if (owner) schedule(owner);
    };
    const scroll = (event: Event) => {
      const moved = event.target;
      if (
        anchor &&
        (moved === document ||
          (moved instanceof Node && moved.contains(anchor)))
      )
        hide();
    };
    const blur = (event: FocusEvent) => {
      if (
        anchor &&
        event.target instanceof Node &&
        anchor.contains(event.target)
      )
        hide();
    };
    const options = { capture: true, passive: true };
    document.addEventListener("pointerover", over, options);
    document.addEventListener("pointerout", out, options);
    document.addEventListener("pointerdown", press, options);
    document.addEventListener("keydown", key, options);
    document.addEventListener("wheel", hide, options);
    document.addEventListener("scroll", scroll, options);
    document.addEventListener("focusin", focus, options);
    document.addEventListener("focusout", blur, options);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", over, options);
      document.removeEventListener("pointerout", out, options);
      document.removeEventListener("pointerdown", press, options);
      document.removeEventListener("keydown", key, options);
      document.removeEventListener("wheel", hide, options);
      document.removeEventListener("scroll", scroll, options);
      document.removeEventListener("focusin", focus, options);
      document.removeEventListener("focusout", blur, options);
      window.removeEventListener("blur", hide);
    };
  }, []);
  useLayoutEffect(() => {
    const tooltip = node.current;
    if (!shown || !tooltip) return;
    const box = shown.anchor.getBoundingClientRect(),
      width = tooltip.offsetWidth,
      height = tooltip.offsetHeight,
      right = document.documentElement.clientWidth - EDGE,
      bottom = document.documentElement.clientHeight - EDGE;
    let top = box.bottom + GAP;
    if (top + height > bottom) top = box.top - GAP - height;
    tooltip.style.left = `${Math.round(Math.max(EDGE, Math.min(box.left + box.width / 2 - width / 2, right - width)))}px`;
    tooltip.style.top = `${Math.round(Math.max(EDGE, Math.min(top, bottom - height)))}px`;
    tooltip.style.visibility = "visible";
  });
  if (!shown) return null;
  const [head, ...rest] = shown.text.split("\n");
  return createPortal(
    <div ref={node} id={ID} role="tooltip" className="app-tooltip">
      <div className="app-tooltip-head">
        <span>{head}</span>
        {shown.shortcut && <kbd>{shown.shortcut}</kbd>}
      </div>
      {rest.length > 0 && (
        <div className="app-tooltip-detail">{rest.join("\n")}</div>
      )}
    </div>,
    shown.container,
  );
}
