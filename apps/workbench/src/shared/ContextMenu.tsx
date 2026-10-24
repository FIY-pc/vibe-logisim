import { useRef, type ReactElement, type ReactNode } from "react";
import * as Context from "@radix-ui/react-context-menu";
import { MenuScope } from "./Menu";
import { keepKeys, keepMovedFocus, usePortalContainer } from "./layer";

/** A menu drawn by the app at the pointer when `children` is right-clicked
 * or long-pressed (a `contextmenu` event dispatched on it from the keyboard
 * opens it at the event's point). `content` uses the shared items from
 * `Menu.tsx`. `children` must be one element that accepts a ref; its own
 * `onContextMenu` runs first and keeps the menu shut by preventing the
 * default. */
export function ContextMenu({
  children,
  content,
  disabled = false,
  onOpenChange,
}: {
  children: ReactElement;
  content: ReactNode;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [anchor, container] = usePortalContainer<HTMLElement>();
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Context.Root
      onOpenChange={(open) => {
        if (open) {
          const focused = document.activeElement;
          opener.current = focused instanceof HTMLElement ? focused : null;
        }
        onOpenChange?.(open);
      }}
    >
      <Context.Trigger ref={anchor} asChild disabled={disabled}>
        {children}
      </Context.Trigger>
      <Context.Portal container={container}>
        <Context.Content
          className="menu-content"
          collisionPadding={8}
          loop
          onCloseAutoFocus={(event) => keepMovedFocus(event, opener.current)}
          onKeyDown={keepKeys}
        >
          <MenuScope kind="context" container={container}>
            {content}
          </MenuScope>
        </Context.Content>
      </Context.Portal>
    </Context.Root>
  );
}
