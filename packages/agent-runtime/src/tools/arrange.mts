/**
 * arrange_circuit: re-lay out one definition with @vibe-logisim/arranger in a
 * worker thread, observe the result through the native runtime without
 * applying it (host `observeXml`), prove the netlist equivalent, and replace
 * the document's XML only when the layout reads more clearly than the
 * drawing it replaces. A rejected or less clear layout never touches the file.
 */
import {
  compareReadability,
  READABILITY_NAMES,
  resolveUnknownWidths,
  verifyArrangement,
} from "@vibe-logisim/arranger";
import { CircuitToolError } from "./errors.mts";
import { arrangeInWorker } from "./layout.mts";
import type { ToolContext } from "./context.mts";

const ARRANGE_OPTIONS = [
  "organization",
  "pinnedComponentIds",
  "keepTunnels",
  "localiseConstants",
  "panelBelowY",
];

export async function arrangeCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  const source = await context.host.call<{ xml: string }>({
    op: "source",
    id: document.id,
    revision: document.revision,
  });
  const before = await context.observe(document, circuit);
  // The arranger reads a present key as given, so absent options stay absent.
  const options = Object.fromEntries(
    ARRANGE_OPTIONS.filter(
      (k) => args[k] !== undefined && args[k] !== null,
    ).map((k) => [k, args[k]]),
  );
  const outcome = await arrangeInWorker(
    { xml: source.xml, circuit, focus: before.raw.focus, options },
    60_000,
  );
  context.assertCurrent();
  // What the arranged file loads as, observed before anything is applied.
  const after = await context.host.call<any>({
    op: "observeXml",
    id: document.id,
    revision: document.revision,
    circuit,
    xml: outcome.xml,
  });
  context.assertCurrent();
  if (!after?.focus)
    throw new CircuitToolError(
      "EXACT_OBSERVER_FAILED",
      "整理结果无法载入，没有应用。",
      {
        retryable: true,
        hint: "重新整理；若仍失败，检查原电路能否在 Logisim 中打开。",
      },
    );
  // The worker resolved widths on its own copy of the observation.
  resolveUnknownWidths(before.raw.focus);
  const checks = verifyArrangement(
    {
      circuit,
      source: source.xml,
      focus: before.raw.focus,
      xml: outcome.xml,
      report: outcome.report,
      placement: new Map(outcome.placement),
      keptWires: outcome.keptWires as any,
      panelBelowY: outcome.panelBelowY,
      fixedComponentIds: new Set(outcome.fixedComponentIds),
    },
    after.focus,
  );
  const readability = {
    before: checks.readabilityBefore,
    after: checks.readabilityAfter,
  };
  const comparison = compareReadability(
    checks.readabilityBefore,
    checks.readabilityAfter,
  );
  const named = (metrics: (keyof typeof READABILITY_NAMES)[]) =>
    metrics.map((m) => READABILITY_NAMES[m]);
  if (!comparison.clearer)
    return {
      ...context.identity(document, circuit),
      applied: false,
      arrangement: outcome.report,
      readability,
      worse: named(comparison.worse),
      note:
        `整理出的布局不比现在清楚（可读性得分 ${checks.readabilityBefore.score} → ${checks.readabilityAfter.score}，越低越清楚` +
        (comparison.worse.length
          ? `；${named(comparison.worse).join("、")}会变多`
          : "") +
        "），没有应用，文件没有改动。",
    };
  const applied = await context.edit(document, circuit, [
    { kind: "replace", xml: outcome.xml, title: "整理布局" },
  ]);
  return {
    ...context.identity(applied.change, circuit),
    title: applied.result.title,
    applied: true,
    arrangement: outcome.report,
    readability,
    better: named(comparison.better),
    worse: named(comparison.worse),
    netlist: {
      equivalent: true,
      groupsCompared: checks.netGroupsCompared,
      invalidBundles: 0,
    },
    note:
      "连通性已按网表逐端口组核对（含探针等位宽随网络而定的端口，不是仿真）；作为子电路的引脚排列不变；" +
      "文件里其他电路一个字节都没改；可读性得分越低越清楚。",
  };
}
