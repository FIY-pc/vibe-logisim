/* Focus handoff for project commands and dialogs during the Themes migration. */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { IconButton } from "@radix-ui/themes";

const openers = new WeakMap<HTMLElement, HTMLElement>();
export const modalSelector = 'dialog[open],[aria-modal="true"]';

/** Sends focus to `opener` once `dialog` closes. Menus use it: the item that
 * opened the dialog is gone by the time the dialog closes, so focus goes back
 * to the menu's trigger instead. */
export function returnFocusTo(dialog: HTMLElement, opener: HTMLElement) {
  openers.set(dialog, opener);
}

/** Project commands open controlled dialogs without a persistent Dialog.Trigger. */
export function useDialogFocus() {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // During migration a child dialog can still be launched from a native top layer.
  const [container] = useState(
    () =>
      document.activeElement?.closest<HTMLDialogElement>("dialog[open]") ??
      undefined,
  );
  return {
    ref,
    container,
    onOpenAutoFocus(event: Event) {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const start = ref.current?.querySelector<HTMLElement>("[data-autofocus]");
      if (start) {
        event.preventDefault();
        start.focus();
        if (start instanceof HTMLInputElement) start.select();
      }
    },
    onCloseAutoFocus(event: Event) {
      const target =
        (ref.current && openers.get(ref.current)) || opener.current;
      if (target?.isConnected) {
        event.preventDefault();
        target.focus();
      }
    },
  };
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
    <IconButton
      type="button"
      variant="ghost"
      color="gray"
      size="2"
      aria-label={label}
      data-tip="关闭"
      data-tip-key="Esc"
      disabled={disabled}
      onClick={onClick}
    >
      <X size={16} aria-hidden="true" />
    </IconButton>
  );
}
