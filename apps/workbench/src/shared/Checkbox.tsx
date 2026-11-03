import { Checkbox as ThemesCheckbox } from "@radix-ui/themes";

/** A check box drawn by the app. Put it inside a `<label>` with its text, or
 * name it with `label`. */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <ThemesCheckbox
      size="1"
      className={className ? `checkbox ${className}` : "checkbox"}
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      disabled={disabled}
      aria-label={label}
    />
  );
}
