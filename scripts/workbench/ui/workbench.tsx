import type { ReactNode } from "react";
import {
  useOwnWorkbench,
  WorkbenchProvider,
} from "../../../apps/workbench/src/workbench/provider";

/** Provides a workbench that is never started, for components rendered outside App. */
export function Workbench({ children }: { children: ReactNode }) {
  return (
    <WorkbenchProvider value={useOwnWorkbench()}>{children}</WorkbenchProvider>
  );
}
