import {
  createContext,
  useContext,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Button,
  ContextMenu as Context,
  DropdownMenu as Dropdown,
  Flex,
  IconButton,
  Text,
} from "@radix-ui/themes";
import { Ellipsis } from "lucide-react";
import { keepKeys, keepMovedFocus, usePortalContainer } from "./layer";
import "./Menu.css";

/** The kind of menu the shared items below render into. Radix keeps a
 * drop-down's items and a context menu's items apart, so each item asks. */
type Kind = "dropdown" | "context";
const KindContext = createContext<Kind>("dropdown");
/** Sub-menus mount where their root menu mounted. */
const ContainerContext = createContext<HTMLElement | undefined>(undefined);

/** Provides the item kind and container to a menu's content. */
export function MenuScope({
  kind,
  container,
  children,
}: {
  kind: Kind;
  container: HTMLElement | undefined;
  children: ReactNode;
}) {
  return (
    <KindContext.Provider value={kind}>
      <ContainerContext.Provider value={container}>
        {children}
      </ContainerContext.Provider>
    </KindContext.Provider>
  );
}

/** A menu drawn by the app, opened from a button: the ellipsis by default.
 * Positioned against the button and flipped to stay on screen; Escape, a
 * click outside or a command closes it and focus returns to the button;
 * arrow keys, Home/End and typing move between commands. */
export function Menu({
  label,
  children,
  trigger,
  title,
  disabled = false,
  align = "end",
  className,
  tabIndex,
  triggerRef,
  open,
  onOpenChange,
}: {
  /** The button's accessible name, and its tooltip for the ellipsis. */
  label: string;
  children: ReactNode;
  /** What the button shows instead of the ellipsis; include `label`'s text. */
  trigger?: ReactNode;
  title?: string;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  className?: string;
  /** -1 inside widgets that manage their own tab stop, like a tree. */
  tabIndex?: number;
  /** Also receives the button, e.g. to focus it after a dialog. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [anchor, container] = usePortalContainer<HTMLButtonElement>();
  const Trigger = trigger === undefined ? IconButton : Button;
  return (
    <Dropdown.Root open={open} onOpenChange={onOpenChange}>
      <Dropdown.Trigger>
        <Trigger
          ref={(node) => {
            anchor.current = node;
            if (triggerRef) triggerRef.current = node;
          }}
          type="button"
          size="1"
          variant="ghost"
          color="gray"
          className={["menu-trigger", className].filter(Boolean).join(" ")}
          aria-label={label}
          data-tip={title ?? (trigger === undefined ? label : undefined)}
          disabled={disabled}
          tabIndex={tabIndex}
        >
          {trigger ?? <Ellipsis size={15} aria-hidden="true" />}
        </Trigger>
      </Dropdown.Trigger>
      <Dropdown.Content
        container={container}
        className="app-menu-content"
        size="1"
        align={align}
        collisionPadding={8}
        loop
        onCloseAutoFocus={(event) => keepMovedFocus(event, anchor.current)}
        onKeyDown={keepKeys}
      >
        <MenuScope kind="dropdown" container={container}>
          {children}
        </MenuScope>
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

const textOf = (node: ReactNode) =>
  typeof node === "string" ? node : undefined;

/** One command. Commands that open a dialog or a file picker end their text
 * with "…"; commands that act at once do not. */
export function MenuItem({
  children,
  icon,
  shortcut,
  trailing,
  disabled = false,
  danger = false,
  title,
  onSelect,
}: {
  children: ReactNode;
  icon?: ReactNode;
  /** The key binding's label, shown right-aligned. */
  shortcut?: string | null;
  /** Shown at the end instead of a shortcut, e.g. an external-link mark. */
  trailing?: ReactNode;
  disabled?: boolean;
  /** Destructive commands. */
  danger?: boolean;
  title?: string;
  onSelect?: (event: Event) => void;
}) {
  const Item =
    useContext(KindContext) === "context" ? Context.Item : Dropdown.Item;
  return (
    <Item
      color={danger ? "red" : undefined}
      shortcut={shortcut ?? undefined}
      disabled={disabled}
      data-tip={title}
      textValue={textOf(children)}
      onSelect={onSelect}
    >
      {icon && (
        <Flex flexShrink="0" aria-hidden="true">
          {icon}
        </Flex>
      )}
      <Text className="menu-label" truncate>
        {children}
      </Text>
      {trailing && (
        <Flex ml="auto" flexShrink="0">
          {trailing}
        </Flex>
      )}
    </Item>
  );
}

/** A setting that is on or off, with the Themes check indicator. */
export function MenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
  shortcut,
  disabled = false,
  title,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  shortcut?: string | null;
  disabled?: boolean;
  title?: string;
}) {
  const context = useContext(KindContext) === "context";
  const Item = context ? Context.CheckboxItem : Dropdown.CheckboxItem;
  return (
    <Item
      checked={checked}
      shortcut={shortcut ?? undefined}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      disabled={disabled}
      data-tip={title}
      textValue={textOf(children)}
    >
      <Text className="menu-label" truncate>
        {children}
      </Text>
    </Item>
  );
}

export function MenuSeparator() {
  const Separator =
    useContext(KindContext) === "context"
      ? Context.Separator
      : Dropdown.Separator;
  return <Separator />;
}

/** A heading inside a menu; not a command. */
export function MenuLabel({ children }: { children: ReactNode }) {
  const Label =
    useContext(KindContext) === "context" ? Context.Label : Dropdown.Label;
  return <Label className="menu-heading">{children}</Label>;
}

/** A command that opens a further menu to its side. */
export function MenuSub({
  label,
  icon,
  disabled = false,
  children,
}: {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  const kind = useContext(KindContext);
  const container = useContext(ContainerContext);
  const Components = kind === "context" ? Context : Dropdown;
  return (
    <Components.Sub>
      <Components.SubTrigger disabled={disabled} textValue={label}>
        {icon && (
          <Flex flexShrink="0" aria-hidden="true">
            {icon}
          </Flex>
        )}
        <Text className="menu-label" truncate>
          {label}
        </Text>
      </Components.SubTrigger>
      <Components.SubContent
        container={container}
        className="app-menu-content"
        collisionPadding={8}
        loop
        onKeyDown={keepKeys}
      >
        {children}
      </Components.SubContent>
    </Components.Sub>
  );
}
