/* Focus handoff for project commands and dialogs during the Themes migration. */
import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { Dialog as ThemesDialog, IconButton } from "@radix-ui/themes";
import "./Dialog.css";

const openers = new WeakMap<HTMLElement, HTMLElement>();
export const modalSelector = 'dialog[open],[aria-modal="true"]';

/** Records the persistent control behind a menu or dialog. */
export function returnFocusTo(layer: HTMLElement, opener: HTMLElement) {
  openers.set(layer, opener);
}

/** Resolve menu items before their menu unmounts. Submenus point to their
 * parent trigger; context menus register their origin explicitly. */
export function focusOrigin(element: Element | null): HTMLElement | null {
  let target = element instanceof HTMLElement ? element : null;
  const seen = new Set<HTMLElement>();
  while (target && !seen.has(target)) {
    seen.add(target);
    const menu = target.closest<HTMLElement>('[role="menu"]');
    if (!menu) break;
    const id = menu.getAttribute("aria-labelledby");
    const origin =
      openers.get(menu) ?? (id ? menu.ownerDocument.getElementById(id) : null);
    if (!(origin instanceof HTMLElement)) break;
    target = origin;
  }
  return target === document.body ? null : target;
}

/** Project commands open controlled dialogs without a persistent Dialog.Trigger. */
export function useDialogFocus() {
  const ref = useRef<HTMLDivElement>(null);
  const opened = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(
    focusOrigin(document.activeElement),
  );
  // During migration a child dialog can still be launched from a native top layer.
  const [container] = useState(
    () =>
      document.activeElement?.closest<HTMLDialogElement>("dialog[open]") ??
      undefined,
  );
  return {
    ref,
    container,
    "aria-modal": true as const,
    onOpenAutoFocus(event: Event) {
      opened.current = ref.current;
      // Editors may focus in a child layout effect before Radix opens its scope.
      if (!ref.current?.contains(document.activeElement))
        opener.current = focusOrigin(document.activeElement);
      const start = ref.current?.querySelector<HTMLElement>("[data-autofocus]");
      if (start) {
        event.preventDefault();
        start.focus();
        if (start instanceof HTMLInputElement) start.select();
      }
    },
    onCloseAutoFocus(event: Event) {
      const redirected = opened.current && openers.get(opened.current);
      const target = redirected?.isConnected ? redirected : opener.current;
      if (target?.isConnected) {
        event.preventDefault();
        target.focus();
      }
    },
  };
}

type DialogFrameProps = Omit<ThemesDialog.ContentProps, "title"> & {
  title: ReactNode;
  open?: boolean;
  onClose: () => void;
  closeDisabled?: boolean;
  closeLabel?: string;
  footer?: ReactNode;
};

/** Controlled project dialogs share layout; Radix owns layering and focus trapping.
 * Mount conditionally or pass open. Keep draft/confirmation decisions in onClose. */
export function DialogFrame({
  title,
  open = true,
  onClose,
  closeDisabled = false,
  closeLabel,
  footer,
  children,
  className = "",
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onPointerDownOutside,
  onKeyDown,
  ...props
}: DialogFrameProps) {
  const focus = useDialogFocus();
  return (
    <ThemesDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !closeDisabled) onClose();
      }}
    >
      <ThemesDialog.Content
        {...focus}
        aria-describedby={undefined}
        maxHeight="calc(100dvh - 48px)"
        {...props}
        className={`dialog-frame ${className}`}
        onOpenAutoFocus={(event) => {
          focus.onOpenAutoFocus(event);
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (!event.defaultPrevented) focus.onCloseAutoFocus(event);
        }}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (closeDisabled) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          onPointerDownOutside?.(event);
          // Match native modal behavior: only an explicit close or Escape dismisses.
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          event.stopPropagation();
        }}
      >
        <header className="dialog-header">
          <ThemesDialog.Title className="dialog-title" mb="0">{title}</ThemesDialog.Title>
          <DialogClose
            label={closeLabel}
            disabled={closeDisabled}
            onClick={onClose}
          />
        </header>
        {children}
        {footer != null && <DialogFooter>{footer}</DialogFooter>}
      </ThemesDialog.Content>
    </ThemesDialog.Root>
  );
}

export function DialogBody({
  scroll = true,
  className = "",
  ...props
}: ComponentPropsWithoutRef<"div"> & { scroll?: boolean }) {
  return (
    <div
      {...props}
      className={`dialog-body ${className}`}
      data-scroll={scroll}
    />
  );
}

export function DialogFooter({
  className = "",
  ...props
}: ComponentPropsWithoutRef<"footer">) {
  return <footer {...props} className={`dialog-footer ${className}`} />;
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
    const opener = focusOrigin(document.activeElement);
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
      const redirected = openers.get(node);
      const target = redirected?.isConnected ? redirected : opener;
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
      style={{ marginInlineStart: "auto" }}
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
