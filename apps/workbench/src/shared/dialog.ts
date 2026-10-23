/* Modal dialogs drawn with the platform `<dialog>` element. */
import { useEffect, useRef } from "react";

const openers = new WeakMap<HTMLDialogElement, HTMLElement>();

/** Sends focus to `opener` once `dialog` closes. Menus use it: the item that
 * opened the dialog is gone by the time the dialog closes, so focus goes back
 * to the menu's trigger instead. */
export function returnFocusTo(dialog: HTMLDialogElement, opener: HTMLElement) {
  openers.set(dialog, opener);
}

/** Shows the dialog on the returned ref as a modal while the component is
 * mounted. When it unmounts, focus goes back to the control it was opened
 * from, unless something else has taken focus meanwhile. */
export function useModal() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const focused = document.activeElement;
    const opener =
      focused instanceof HTMLElement && focused !== document.body
        ? focused
        : null;
    node.showModal();
    return () => {
      const target = openers.get(node) ?? opener;
      node.close();
      const now = document.activeElement;
      if (
        target?.isConnected &&
        (!now || now === document.body || node.contains(now))
      )
        target.focus();
    };
  }, []);
  return dialog;
}
