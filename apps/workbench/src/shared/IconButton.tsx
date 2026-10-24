import type { ReactNode } from "react";
import { tip } from "./Tooltips";

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
  return (
    <button
      className="icon-button"
      {...tip(title, shortcut)}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </button>
  );
}
