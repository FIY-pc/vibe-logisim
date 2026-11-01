import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stories, timeline, type Story } from "../demo/timeline.ts";

test("recorded native full-adder frames cover the complete truth table", async () => {
  const data = JSON.parse(
    await readFile(
      new URL("../public/assets/demo-recording.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(data.schema, 1);
  assert.equal(data.circuit.components.length, data.symbols.length);
  assert.equal(data.cases.length, 8);
  assert.deepEqual(
    data.cases.map((c: any) => c.inputs),
    Array.from({ length: 8 }, (_, n) => n.toString(2).padStart(3, "0")),
  );
  const pins = data.circuit.components.filter((c: any) => c.name === "Pin");
  assert.deepEqual(pins.map((c: any) => c.attributes.label).sort(), [
    "A",
    "B",
    "Cin",
    "Cout",
    "S",
  ]);
  for (const c of data.cases) {
    const total = [...c.inputs].reduce(
      (n: number, bit: string) => n + Number(bit),
      0,
    );
    assert.equal(c.sum, String(total % 2));
    assert.equal(c.cout, String(Number(total >= 2)));
    assert.equal(
      Object.keys(c.picture.components).length,
      data.circuit.components.length,
    );
    assert.ok(Object.keys(c.picture.wires).length >= data.circuit.wires.length);
    for (const component of data.circuit.components)
      assert.ok(c.picture.components[component.id].length);
  }
});

test("seeking, replaying and switching scenarios leave no stale construction or verification state", () => {
  for (const key of Object.keys(stories) as Story[]) {
    const initial = timeline(key, 0),
      final = timeline(key, stories[key].duration);
    assert.equal(initial.complete, false);
    assert.equal(initial.userVisible, false);
    assert.equal(initial.tested, 0);
    assert.equal(final.complete, true);
    assert.equal(final.parts, 1);
    assert.equal(final.wires, 1);
    assert.equal(final.caseIndex, 6);
    assert.equal(final.tested, key === "explain" ? 0 : 8);
    assert.deepEqual(timeline(key, -100), initial);
    assert.deepEqual(timeline(key, stories[key].duration + 100), final);
    assert.deepEqual(timeline(key, 0), initial);
    for (let time = 0; time <= stories[key].duration; time += 50) {
      const state = timeline(key, time);
      assert.ok(
        state.parts >= 0 &&
          state.parts <= 1 &&
          state.wires >= 0 &&
          state.wires <= 1,
      );
      assert.ok(state.caseIndex >= 0 && state.caseIndex < 8);
      assert.equal(state.complete, time === stories[key].duration);
    }
  }
  const wiring = timeline("build", 5500);
  assert.equal(wiring.parts, 1);
  assert.ok(wiring.wires > 0 && wiring.wires < 1);
  assert.equal(wiring.live, false);
  assert.equal(timeline("explain", 4000).highlight, true);
  assert.equal(timeline("verify", 7900).tested, 8);
});
