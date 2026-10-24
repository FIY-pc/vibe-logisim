// Behaviour of arrange() and verifyArrangement() on two small circuits. The
// fixtures are hand-built Logisim files plus the observer's reading of them;
// the arrangement is checked structurally here, and equivalence to the
// original netlist is proved by the engine's own verification.
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  arrange,
  CircuitToolError,
  outsideUnchanged,
  readability,
  resolveUnknownWidths,
  verifyArrangement,
} from "../src/index.mts";
import type {
  Arrangement,
  CircuitToolError as ToolError,
  Focus,
} from "../src/index.mts";

const here = new URL("./fixtures/", import.meta.url).pathname;
const file = (name: string): string => readFileSync(here + name, "utf8");
const observation = (name: string): Focus => JSON.parse(file(name));

const XML = file("adder.circ");
const MAIN = observation("adder-main.focus.json");
const HALF = observation("adder-half.focus.json");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// The native observation after the arrangement: every part and port moved by
// the placement offset, the wires re-read by the caller. Net identity is the
// engine's claim to have kept, so this synthesizes exactly that.
function moved(arrangement: Arrangement): Focus {
  const after = clone(arrangement.focus);
  for (const part of after.components) {
    const [dx, dy] = arrangement.placement.get(part.componentId) ?? [0, 0];
    part.location = { x: part.location.x + dx, y: part.location.y + dy };
    for (const end of part.ends)
      end.location = { x: end.location.x + dx, y: end.location.y + dy };
  }
  return after;
}

function rejects(run: () => unknown, code: string, message?: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(
      error instanceof CircuitToolError,
      `expected CircuitToolError, got ${String(error)}`,
    );
    assert.equal((error as ToolError).code, code);
    if (message !== undefined)
      assert.equal((error as ToolError).message, message);
    return true;
  });
}

describe("arrange", () => {
  it("places every part and reroutes the target definition only", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "main",
      focus: clone(MAIN),
    });
    assert.equal(result.placement.size, 10);
    assert.ok(outsideUnchanged(XML, result.xml, "main"));
    assert.notEqual(result.xml, XML);
    // The other definition is untouched, down to its bytes.
    assert.equal(
      result.xml.slice(0, result.xml.indexOf('<circuit name="main">')),
      XML.slice(0, XML.indexOf('<circuit name="main">')),
    );
    const rest = (text: string): string =>
      text.slice(text.indexOf("</circuit>"));
    assert.equal(rest(result.xml), rest(XML));
  });

  it("is deterministic", async () => {
    const a = await arrange({ xml: XML, circuit: "main", focus: clone(MAIN) });
    const b = await arrange({ xml: XML, circuit: "main", focus: clone(MAIN) });
    assert.equal(a.xml, b.xml);
    assert.deepEqual([...a.placement], [...b.placement]);
  });

  it("emits orthogonal wires on the grid", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "main",
      focus: clone(MAIN),
    });
    const body = result.xml.slice(result.xml.indexOf('<circuit name="main">'));
    const wires = [
      ...body.matchAll(
        /<wire from="\((-?\d+),(-?\d+)\)" to="\((-?\d+),(-?\d+)\)"\/>/g,
      ),
    ];
    assert.ok(wires.length > 0);
    for (const [, x1, y1, x2, y2] of wires) {
      assert.ok(
        x1 === x2 || y1 === y2,
        `diagonal wire (${x1},${y1})-(${x2},${y2})`,
      );
      assert.ok(
        Number(x1) % 10 === 0 && Number(y1) % 10 === 0,
        "wire off the grid",
      );
    }
  });

  it("keeps parts other than tunnels and constants", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "main",
      focus: clone(MAIN),
    });
    const counts = (text: string): Map<string, number> => {
      const out = new Map<string, number>();
      for (const [, name] of text.matchAll(
        /<comp lib="\d+" loc="\([^"]*\)" name="([^"]*)"/g,
      ))
        if (name !== "Tunnel" && name !== "Text")
          out.set(name, (out.get(name) ?? 0) + 1);
      return out;
    };
    const body = (text: string): string => {
      const start = text.indexOf('<circuit name="main">');
      return text.slice(start, text.indexOf("</circuit>", start));
    };
    assert.deepEqual(counts(body(result.xml)), counts(body(XML)));
  });

  it("rearranging a subcircuit definition keeps its interface", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "half",
      focus: clone(HALF),
    });
    assert.equal(result.placement.size, 6);
    assert.ok(outsideUnchanged(XML, result.xml, "half"));
    verifyArrangement(result, moved(result));
  });
});

describe("verifyArrangement", () => {
  it("accepts the arrangement's own netlist", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "main",
      focus: clone(MAIN),
    });
    const after = moved(result);
    resolveUnknownWidths(after);
    const checks = verifyArrangement(result, after);
    assert.equal(checks.netGroupsCompared, 8);
    assert.equal(checks.interfaceChecked, "default");
    assert.equal(result.panelBelowY, null);
    assert.equal(result.keptWires.length, 0);
  });

  it("names a net whose connectivity changed", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "main",
      focus: clone(MAIN),
    });
    const after = moved(result);
    const port =
      after.components.find((c) => c.factoryName === "OR Gate") ??
      after.components[0];
    const driven = port.ends.find((e) => e.netBits && e.netBits.length > 0);
    assert.ok(driven, "fixture has a wired port");
    driven!.netBits = [{ bit: 0, netId: "swapped" }];
    rejects(
      () => verifyArrangement(result, after),
      "ARRANGE_NOT_EQUIVALENT",
      "整理结果的连通性与原电路不一致（丢失 1 组、新增 0 组、无效线束 0），已丢弃。",
    );
  });

  it("rejects an invalid wire bundle", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "main",
      focus: clone(MAIN),
    });
    const after = moved(result);
    assert.ok(after.wireBundles && after.wireBundles.length > 0);
    after.wireBundles![0] = { ...after.wireBundles![0], valid: false };
    rejects(() => verifyArrangement(result, after), "ARRANGE_NOT_EQUIVALENT");
  });

  it("rejects an edit outside the target definition", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "main",
      focus: clone(MAIN),
    });
    result.xml = result.xml.replace(
      "</project>",
      '<circuit name="extra"><wire from="(0,0)" to="(10,0)"/></circuit></project>',
    );
    rejects(
      () => verifyArrangement(result, moved(result)),
      "ARRANGE_NOT_EQUIVALENT",
      "整理改动了目标电路之外的内容，已丢弃。",
    );
  });

  it("rejects a changed pin arrangement", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "half",
      focus: clone(HALF),
    });
    const before = result.xml.slice(
      result.xml.indexOf('<circuit name="half">'),
    );
    const pin = before.match(
      /<comp lib="\d+" loc="\((\d+),(\d+)\)" name="Pin">[\s\S]*?<\/comp>/,
    )!;
    assert.ok(pin, "fixture has a Pin in half");
    result.xml = result.xml.replace(
      pin[0],
      pin[0].replace(
        `(${pin[1]},${pin[2]})`,
        `(${pin[1]},${Number(pin[2]) + 10})`,
      ),
    );
    rejects(
      () => verifyArrangement(result, moved(result)),
      "ARRANGE_INTERFACE_CHANGED",
    );
  });
});

// Gate-level circuits as a scripted model first draws them: parts where it
// placed them, wires routed one connection at a time.
describe("signal-flow layout", () => {
  for (const name of ["full-adder", "mux4"])
    it(`draws ${name} inputs left, gates in columns, outputs right`, async () => {
      const xml = file(`${name}.circ`);
      const drawn = observation(`${name}.focus.json`);
      const result = await arrange({
        xml,
        circuit: "main",
        focus: clone(drawn),
      });
      assert.equal(result.report.engine, "flow");
      const parts = result.predicted!.components;
      const output = (c: (typeof parts)[number]) =>
        c.attributes.some((a) => a.name === "output" && a.standard === "true");
      const pins = parts.filter((c) => c.factoryName === "Pin");
      const gates = parts.filter((c) => c.factoryName !== "Pin");
      const left = Math.min(...gates.map((c) => c.bounds.x));
      const right = Math.max(...gates.map((c) => c.bounds.x + c.bounds.width));
      for (const pin of pins)
        if (output(pin)) assert.ok(pin.bounds.x > right, pin.componentId);
        else assert.ok(pin.bounds.x + pin.bounds.width < left, pin.componentId);
      const after = readability(result.predicted!);
      for (const measure of [
        "overlaps",
        "labelOverlaps",
        "wireOverBody",
        "portGrazes",
        "labelsOnWires",
        "closeParallels",
        "pinsOffSide",
      ] as const)
        assert.equal(after[measure], 0, measure);
      assert.ok(after.score < readability(clone(drawn)).score / 2);
      const again = await arrange({
        xml,
        circuit: "main",
        focus: clone(drawn),
      });
      assert.equal(again.xml, result.xml);
    });
});
