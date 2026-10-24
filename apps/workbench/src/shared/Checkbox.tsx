import * as Primitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";

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
    <Primitive.Root
      className={className ? `checkbox ${className}` : "checkbox"}
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      disabled={disabled}
      aria-label={label}
    >
      <Primitive.Indicator className="checkbox-mark">
        <Check size={11} strokeWidth={3} aria-hidden="true" />
      </Primitive.Indicator>
    </Primitive.Root>
  );
}
