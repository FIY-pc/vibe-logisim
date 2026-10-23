import type { ReactNode } from "react";

/** A button that shows only an icon; its title is also its accessible name. */
export function IconButton({
  title,
  icon,
  onClick,
  disabled = false,
}: {
  title: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </button>
  );
}
