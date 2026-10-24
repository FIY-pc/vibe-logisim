/**
 * Scripted turn: a large edit on the definition the user is looking at,
 * chosen from observations only, so it runs on any project. Reads the
 * definition, places an AND gate and an output pin beside it, wires two
 * existing one-bit outputs into the gate and the gate to the pin, moves the
 * gate, then arranges the whole definition and compares the netlist
 * signature before and after. A failed call ends the turn with its error.
 *
 *   node scripts/workbench/scripted-model.mts --port 8903 --script scripts/workbench/turns/large-edit.mts
 *
 * "不整理" in the question stops before arranging.
 */
import type { Exchange, Script, Step } from "../scripted-model.mts";

const round = (v: number) => Math.round(v / 10) * 10;
const inspect = (args: Record<string, unknown> = {}): Step["tool"] => ({
  name: "inspect_circuit",
  args,
});

let phase = "read";
let signature = "";
let unchanged = false;
let pages: any[] = [];

function plan(overview: any) {
  const parts = pages.flatMap((page) => page.components ?? []);
  const outputs = parts
    .filter((c: any) => !["Pin", "Tunnel", "Constant"].includes(c.factory))
    .flatMap((c: any) =>
      c.ends
        .filter((e: any) => e.direction === "output" && e.width === 1)
        .map((e: any) => ({ component: c.componentId, port: e.index, at: e.location })),
    )
    .sort((a: any, b: any) => b.at.x - a.at.x);
  const a = outputs[0];
  const b = outputs.find((o: any) => o.component !== a?.component);
  if (!a || !b) return null;
  const box = overview.bounds;
  let x = round(box.x + box.width + 120),
    y = round(box.y + box.height / 2);
  if (x + 200 > 6000) {
    x = round(box.x + box.width / 2);
    y = round(box.y + box.height + 120);
  }
  return { a, b, gate: { x, y }, pin: { x: x + 150, y } };
}
let chosen: ReturnType<typeof plan> = null;

const script: Script = ({ question, calls }) => {
  const last: Exchange | undefined = calls.at(-1);
  if (!last) {
    phase = "read";
    pages = [];
    return { text: "先读一遍当前电路。", tool: inspect() };
  }
  if (last.error)
    return { text: `${last.name} 失败：${last.error.code} ${last.error.message}` };
  const r = last.result;
  switch (phase) {
    case "read": {
      pages.push(r);
      if (r.page?.nextCursor)
        return {
          tool: inspect({ componentDirectory: { maxBytes: 32000, cursor: r.page.nextCursor } }),
        };
      chosen = plan(calls[0].result);
      if (!chosen) return { text: "这个电路里找不到两个一位输出端口，没法演示连线。" };
      phase = "place";
      const { gate, pin } = chosen;
      return {
        text: `电路有 ${calls[0].result.counts.components} 个元件，在右侧加一个与门和输出引脚。`,
        tool: {
          name: "place_component",
          args: {
            components: [
              { factory: "AND Gate", location: gate, attributes: { facing: "east" } },
              { factory: "Pin", location: pin, attributes: { output: "true", facing: "west", label: "probe" } },
            ],
          },
        },
      };
    }
    case "place": {
      phase = "connect";
      const { a, b, gate, pin } = chosen!;
      const g = `c${gate.x}_${gate.y}`;
      return {
        text: "把两个已有输出接到与门，再接到引脚。",
        tool: {
          name: "connect",
          args: {
            connections: [
              { from: { component: a.component, port: a.port }, to: { component: g, port: 1 } },
              { from: { component: b.component, port: b.port }, to: { component: g, port: 2 } },
              { from: { component: g, port: 0 }, to: { component: `c${pin.x}_${pin.y}`, port: 0 } },
            ],
          },
        },
      };
    }
    case "connect": {
      phase = "move";
      const { gate } = chosen!;
      return {
        text: "把与门往下挪 40。",
        tool: {
          name: "move_components",
          args: { componentIds: [`c${gate.x}_${gate.y}`], delta: { x: 0, y: 40 } },
        },
      };
    }
    case "move":
      phase = "before";
      return { text: "记下整理前的网表。", tool: inspect() };
    case "before":
      signature = r.netlistSignature?.sha256 ?? "";
      if (question.includes("不整理"))
        return { text: `连线和移动完成，网表签名 ${signature.slice(0, 12)}。` };
      phase = "arrange";
      return { text: "整理整个电路的布局。", tool: { name: "arrange_circuit", args: {} } };
    case "arrange":
      phase = "after";
      return { text: "整理后再读一遍网表。", tool: inspect() };
    case "after": {
      phase = "render";
      const same = (unchanged = r.netlistSignature?.sha256 === signature);
      return {
        text: same ? "网表签名与整理前一致。" : `网表签名变了：${signature.slice(0, 12)} → ${String(r.netlistSignature?.sha256).slice(0, 12)}`,
        tool: { name: "render_circuit", args: {} },
      };
    }
    default:
      return {
        text: `大改动完成：放置、连线、移动、整理都已执行，网表签名在整理前后${unchanged ? "一致" : "不一致"}。`,
      };
  }
};
export default script;
