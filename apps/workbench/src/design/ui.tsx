import type { ComponentProps } from "react";
import {
  Button as RadixButton,
  IconButton as RadixIconButton,
  TextField as RadixTextField,
  TextArea as RadixTextArea,
  Text as RadixText,
  Heading as RadixHeading,
} from "@radix-ui/themes";

/** Product controls share Themes' size 2 (32px / 14px). Business views choose
 * the action and emphasis, not a new density or palette for each control. */
type ControlProps<T> = Omit<T, "size" | "color"> & {
  color?: "gray" | "red";
};
export function Button(props: ControlProps<ComponentProps<typeof RadixButton>>) {
  return <RadixButton {...props} size="2" />;
}
export function IconButton(props: ControlProps<ComponentProps<typeof RadixIconButton>>) {
  return <RadixIconButton variant="ghost" color="gray" {...props} size="2" />;
}
function TextFieldRoot(props: Omit<ComponentProps<typeof RadixTextField.Root>, "size">) {
  return <RadixTextField.Root {...props} size="2" />;
}
export const TextField = { Root: TextFieldRoot, Slot: RadixTextField.Slot };
export function TextArea(props: Omit<ComponentProps<typeof RadixTextArea>, "size">) {
  return <RadixTextArea {...props} size="2" />;
}

/** Only metadata is smaller than normal text. Headings get their scale from
 * their semantic role, so a field label cannot silently become a page title. */
export function Text({ kind = "body", ...props }: Omit<ComponentProps<typeof RadixText>, "size" | "color"> & {
  kind?: "body" | "meta";
  color?: "gray" | "red";
}) {
  return <RadixText {...props} size={kind === "meta" ? "1" : "2"} />;
}
export function Heading({ kind = "section", ...props }: Omit<ComponentProps<typeof RadixHeading>, "size" | "color"> & {
  kind?: "section" | "dialog";
}) {
  return <RadixHeading {...props} size={kind === "dialog" ? "5" : "3"} />;
}
