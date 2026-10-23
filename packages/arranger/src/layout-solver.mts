// Run the group solver. The graph crosses a JSON boundary both ways, so the
// solver sees and returns plain data only, and the caller's graph is never
// touched.
import { layoutGroups } from "./elk-layout.mts";
import type { SolverInput } from "./elk-layout.mts";
import type { Report } from "./schematic-layout.mts";
import { CircuitToolError } from "./tool-errors.mts";

export async function solveGroups(graph: Report): Promise<Report> {
  let result: unknown;
  try {
    result = await layoutGroups(
      JSON.parse(JSON.stringify(graph)) as SolverInput,
    );
  } catch (error) {
    const text = [...`${(error as Error | undefined)?.stack || error}\n`];
    throw new CircuitToolError(
      "LAYOUT_RUNTIME_FAILED",
      "布局运行失败：" + text.slice(-2000).join(""),
    );
  }
  return JSON.parse(JSON.stringify(result));
}
