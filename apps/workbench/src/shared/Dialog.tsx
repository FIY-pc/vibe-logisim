/* Modal dialogs drawn with the platform `<dialog>` element. */
import { useEffect, useRef } from "react";
import { X } from "lucide-react";

const openers = new WeakMap<HTMLDialogElement, HTMLElement>();

/** Sends focus to `opener` once `dialog` closes. Menus use it: the item that
 * opened the dialog is gone by the time the dialog closes, so focus goes back
 * to the menu's trigger instead. */
export function returnFocusTo(dialog: HTMLDialogElement, opener: HTMLElement) {
  openers.set(dialog, opener);
}

/** Shows the dialog on the returned ref as a modal while the component is
 * mounted. Focus starts on the element marked `data-autofocus` (an input's
 * text is selected), otherwise on the dialog itself: the platform would pick
 * the first control, usually the close button. When the component unmounts,
 * focus goes back to the control the dialog was opened from, unless
 * something else has taken focus meanwhile. */
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
    const start = node.querySelector<HTMLElement>("[data-autofocus]");
    if (start) {
      start.focus();
      if (start instanceof HTMLInputElement) start.select();
    } else {
      node.tabIndex = -1;
      node.focus();
    }
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

/** The close button at the end of a dialog's header. */
export function DialogClose({
  label = "关闭",
  disabled = false,
  onClick,
}: {
  label?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="dialog-close"
      aria-label={label}
      data-tip="关闭"
      data-tip-key="Esc"
      disabled={disabled}
      onClick={onClick}
    >
      <X size={16} aria-hidden="true" />
    </button>
  );
}
