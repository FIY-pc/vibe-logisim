import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";

/** The product has one theme, including portalled menus and dialogs. */
export function WorkbenchTheme({ children }: { children: ReactNode }) {
  return (
    <Theme
      appearance="light"
      accentColor="indigo"
      grayColor="slate"
      radius="medium"
      scaling="100%"
      className="workbench-theme"
    >
      {children}
    </Theme>
  );
}
