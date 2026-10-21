import { createContext, useContext, useState, type ReactNode } from "react";
import { createWorkbench, type Workbench } from "./createWorkbench";

const WorkbenchContext = createContext<Workbench | null>(null);

export function WorkbenchProvider({
  value,
  children,
}: {
  value: Workbench;
  children: ReactNode;
}) {
  return <WorkbenchContext value={value}>{children}</WorkbenchContext>;
}

export function useWorkbench(): Workbench {
  const workbench = useContext(WorkbenchContext);
  if (!workbench) throw new Error("useWorkbench needs a WorkbenchProvider");
  return workbench;
}

/** Creates one workbench for the calling component's lifetime. */
export function useOwnWorkbench(): Workbench {
  const [workbench] = useState(createWorkbench);
  return workbench;
}
