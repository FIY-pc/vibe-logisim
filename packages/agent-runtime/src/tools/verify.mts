/**
 * Behaviour checks in an isolated runtime: simulate_circuit (vectors through
 * a definition from fresh state) and trace_circuit (ticks with watched
 * ports). Neither touches the user's live simulation. The stimulus helpers
 * turn the model's clocks and events into the host's InputEvent list.
 */
import * as fs from "node:fs/promises";
import { CircuitToolError } from "./errors.mts";
import type { ToolContext } from "./context.mts";
import type { InputEvent } from "../generated/InputEvent.ts";

/** inputs + inputClocks + inputEvents → the host's per-tick input events, sorted by tick. */
export function stimulus(args: Record<string, any>): InputEvent[] {
  const ticks = args.ticks ?? 1;
  const events: InputEvent[] = [];
  const eventNames = new Set((args.inputEvents ?? []).map((e: any) => e.name));
  const seen = new Set<string>();
  for (const clock of args.inputClocks ?? []) {
    const name = clock.name;
    if (seen.has(name) || eventNames.has(name))
      throw new CircuitToolError(
        "INVALID_ARGUMENT",
        "时钟与输入事件不能同时驱动同一个引脚：" + name,
      );
    seen.add(name);
    const high = clock.highTicks ?? 1;
    const low = clock.lowTicks ?? 1;
    const first = clock.firstTick ?? 1;
    const last = clock.lastTick ?? ticks;
    let value = args.inputs?.[name] ?? 0;
    for (let tick = first; tick <= ticks; tick += 1) {
      if (tick > last) break;
      if (tick > first) {
        const phase = (tick - first) % (high + low);
        value = phase < high ? 1 : 0;
      }
      events.push({ tick, input: name, value });
    }
  }
  for (const e of args.inputEvents ?? [])
    events.push({ tick: e.tick, input: e.name, value: e.value });
  return events.sort((a, b) => a.tick - b.tick);
}

/** One page of trace rows; the whole result when it fits. */
export function boundedRows(result: any, rowStart: number, rowLimit: number) {
  const samples = result.samples || [];
  if (samples.length <= rowLimit && rowStart === 0) return result;
  const rows = samples.slice(rowStart, rowStart + rowLimit);
  return {
    ...result,
    samples: rows,
    rowCount: samples.length,
    rowStart,
    rowsTruncated: rowStart > 0 || rowStart + rows.length < samples.length,
  };
}

/** Bundles whose ports disagree on width: the usual cause of X outputs. */
export function widthConflicts(focus: any) {
  const bad = (focus?.wireBundles || []).filter((b: any) => b.valid === false);
  if (!bad.length) return null;
  const portsAt = new Map<string, any[]>();
  for (const c of focus.components || [])
    for (const end of c.ends || []) {
      const key = `${end.location.x},${end.location.y}`;
      const list = portsAt.get(key) ?? [];
      list.push({
        component: c.componentId,
        factory: c.factoryName,
        label: c.selector?.label ?? null,
        port: end.index,
        width: end.width,
      });
      portsAt.set(key, list);
    }
  return {
    count: bad.length,
    bundles: bad.slice(0, 6).map((b: any) => {
      const touching = (b.points || []).flatMap(
        (p: any) => portsAt.get(`${p.x},${p.y}`) ?? [],
      );
      return {
        bundleId: b.bundleId ?? b.id ?? null,
        portWidths: [...new Set(touching.map((p: any) => p.width))].sort(),
        ports: touching.slice(0, 12),
        points: (b.points || []).slice(0, 8),
      };
    }),
    hint: "同一线束接了不同位宽的端口，仿真会输出 X。检查列出的 Tunnel 标签是否被不同位宽的信号复用，或导线端点是否落在别的端口上。",
  };
}

export async function simulateCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  let vectors = args.vectors;
  if (!vectors?.length && args.vectorsFile) {
    const file = context.absolute(args.vectorsFile);
    try {
      vectors = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error: any) {
      throw new CircuitToolError(
        "INVALID_ARGUMENT",
        "测试向量文件无法读取：" + error.message,
        {
          hint: "文件应是 [{inputs:{…}, expected:{…}}] 形式的 JSON。",
        },
      );
    }
    if (Array.isArray(vectors?.vectors)) vectors = vectors.vectors;
  }
  if (!Array.isArray(vectors) || !vectors.length)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "simulate_circuit 需要 vectors。",
      {
        hint: "给出 [{inputs:{…}, expected:{…}}] 形式的测试向量。",
      },
    );
  const result = await context.host.call<any>({
    op: "simulate",
    id: document.id,
    revision: document.revision,
    circuit,
    vectors: vectors.map((v: any) => ({
      inputs: v.inputs ?? {},
      expected: v.expected ?? {},
    })),
  });
  const { raw } = await context.observe(document, circuit);
  const conflicts = widthConflicts(raw.focus);
  return {
    ...context.identity(document, circuit),
    ...result,
    ...(conflicts ? { widthConflicts: conflicts } : {}),
  };
}

export async function traceCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  if (!args.watches?.length)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "trace_circuit 需要 watches。",
      {
        hint: "给出要观察的元件 id 和端口编号。",
      },
    );
  const result = await context.host.call<any>({
    op: "trace",
    id: document.id,
    revision: document.revision,
    circuit,
    ticks: args.ticks ?? 1,
    inputs: args.inputs ?? {},
    events: stimulus(args),
    buttons: args.buttonEvents ?? [],
    reset: args.resetButton ?? undefined,
    program: args.program ?? undefined,
    watches: args.watches.map((w: any) => ({
      component: w.component,
      port: w.port,
      name: w.name ?? `${w.component}:${w.port}`,
    })),
  });
  return {
    ...context.identity(document, circuit),
    ...boundedRows(result, args.rowStart ?? 0, args.rowLimit ?? 64),
  };
}
