/* Helpers shared by the floating layers drawn by the app: menus, lists,
 * popovers and tooltips. */
import { useEffect, useRef, useState } from "react";
import { returnFocusTo } from "./dialog";

/** Where a floating layer opened from an element must mount: inside the
 * nearest `<dialog>` when the element is in one (anything portaled to
 * `<body>` is inert while a modal dialog is open), otherwise `<body>`. The
 * returned ref goes on the element; the container is known once it mounts. */
export function usePortalContainer<T extends HTMLElement>() {
  const anchor = useRef<T>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(
      anchor.current?.closest<HTMLElement>("dialog") ?? document.body,
    );
  }, []);
  return [anchor, container ?? undefined] as const;
}

/** A command that opened a dialog or moved focus on purpose keeps it there;
 * otherwise focus goes back to where the layer was opened from. A dialog
 * opened this way returns focus to `opener` when it closes. */
export function keepMovedFocus(event: Event, opener: HTMLElement | null) {
  const active = document.activeElement;
  if (!active || active === document.body) return;
  event.preventDefault();
  const dialog = active.closest("dialog");
  if (dialog && opener) returnFocusTo(dialog, opener);
}

/** Keys pressed in a floating layer belong to it: they must not reach the
 * handlers of the components it was opened from (React passes portal events
 * up the component tree) nor the window's shortcuts. */
export function keepKeys(event: { stopPropagation(): void }) {
  event.stopPropagation();
}
