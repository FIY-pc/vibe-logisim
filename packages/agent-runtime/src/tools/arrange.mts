/**
 * arrange_circuit: re-lay out one definition with @vibe-logisim/arranger in a
 * worker thread, re-observe the result through the native runtime, prove
 * the netlist equivalent and only then replace the document's XML.
 */
import {
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
  "columnGap",
  "maxLayerSpan",
  "tunnelSpan",
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
  // TODO(arrange): the host has no "observe this XML without applying it"
  // request any more. Until it does, apply the replacement, observe the new
  // revision and undo when verification fails. Add `{"op":"observeXml"}` to
  // the host (crates/workbench-host/src/api/document.rs, agent-callable) and
  // verify before applying; then drop the undo path below.
  const applied = await context.edit(document, circuit, [
    { kind: "replace", xml: outcome.xml },
  ]);
  const after = await context.observe(applied.result.view, circuit);
  if (!after.raw?.focus) {
    await context.host.call({
      op: "undo",
      id: document.id,
      revision: applied.result.revision,
    });
    throw new CircuitToolError(
      "EXACT_OBSERVER_FAILED",
      "整理结果无法载入，已撤销",
      {
        retryable: true,
        hint: "重新整理；若仍失败，检查原电路能否在 Logisim 中打开。",
      },
    );
  }
  // The worker resolved widths on its own copy of the observation.
  resolveUnknownWidths(before.raw.focus);
  let checks;
  try {
    checks = verifyArrangement(
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
      after.raw.focus,
    );
  } catch (error) {
    const undone = await context.host.call<any>({
      op: "undo",
      id: document.id,
      revision: applied.result.revision,
    });
    context.emit({
      type: "document-changed",
      document: undone.view,
      expectedBaseRevision: applied.result.revision,
    });
    throw error;
  }
  return {
    ...context.identity(applied.result.view, circuit),
    title: applied.result.title,
    arrangement: outcome.report,
    readability: {
      before: outcome.readabilityBefore,
      after: outcome.readabilityAfter,
    },
    netlist: {
      equivalent: true,
      groupsCompared: checks.netGroupsCompared,
      invalidBundles: 0,
    },
    note:
      "连通性已按网表逐端口组核对（含探针等位宽随网络而定的端口，不是仿真）；作为子电路的引脚排列不变；" +
      "文件里其他电路一个字节都没改。可用 render_circuit 看图，可调整 organization 的功能分组与阅读行序或连线参数后重新整理；不满意可用 undo_edit 撤销。",
  };
}
