import { IconButton as ThemesIconButton } from "../design/ui";
import type { ReactNode } from "react";
import { Kbd, Tooltip } from "@radix-ui/themes";
import { usePortalContainer } from "./layer";

/** A button that shows only an icon; its title is its hint and its accessible
 * name, with the shortcut drawn beside the hint. */
export function IconButton({
  title,
  shortcut,
  icon,
  onClick,
  disabled = false,
}: {
  title: string;
  shortcut?: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [anchor, container] = usePortalContainer<HTMLButtonElement>();
  return (
    <Tooltip
      container={container}
      content={
        <>
          {title}
          {shortcut && (
            <>
              {" "}
              <Kbd size="1">{shortcut}</Kbd>
            </>
          )}
        </>
      }
    >
      <ThemesIconButton
        ref={anchor}
        type="button"
        variant="ghost"
        color="gray"
        aria-label={title}
        onClick={onClick}
        disabled={disabled}
      >
        {icon}
      </ThemesIconButton>
    </Tooltip>
  );
}
