import { fileURLToPath } from "node:url";
// Each readability measure against a fixture that shows it:
// fixtures/readability/<measure>.circ holds two definitions, "before" (the
// problem) and "after" (the same parts drawn cleanly; open the file to see
// both), and <measure>.focus.json the host's observation of each.
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { compareReadability, readability } from "../src/index.mts";
import type { Focus, READABILITY_WEIGHTS } from "../src/index.mts";

type Measure = keyof typeof READABILITY_WEIGHTS;
const here = fileURLToPath(new URL("./fixtures/readability/", import.meta.url));
const observed = (name: string): { before: Focus; after: Focus } =>
  JSON.parse(readFileSync(here + name + ".focus.json", "utf8"));

const CASES: [file: string, measure: Measure, count: number][] = [
  // a wire 10 px beside a wire of another net
  ["close-parallels", "closeParallels", 1],
  // a wire straight across a gate it does not connect to
  ["wire-over-body", "wireOverBody", 1],
  // a wire 10 px from a gate's output, where the eye reads a junction
  ["port-grazes", "portGrazes", 1],
  // a wire through an output pin's label
  ["labels-on-wires", "labelsOnWires", 1],
  // a detour of four corners where a straight wire does
  ["bends", "bends", 4],
  // two gates on top of each other; after, bodies grazing by 5 px (normal
  // between neighbouring grid cells, not an overlap)
  ["overlaps", "overlaps", 1],
  // a gate on a pin's label
  ["label-overlaps", "labelOverlaps", 1],
  // an output pin facing away from its driver, the wire entering its body
  ["pins-off-side", "pinsOffSide", 1],
];

describe("readability", () => {
  for (const [file, measure, count] of CASES)
    it(`counts ${measure} (${file}.circ)`, () => {
      const { before, after } = observed(file);
      const messy = readability(before);
      const clean = readability(after);
      assert.equal(messy[measure], count);
      assert.equal(clean[measure], 0);
      // Only this measure differs: the clean drawing reads more clearly, and
      // the messy one would be refused in its place, naming the measure.
      assert.deepEqual(compareReadability(messy, clean), {
        clearer: true,
        worse: [],
        better: [measure],
      });
      assert.deepEqual(compareReadability(clean, messy), {
        clearer: false,
        worse: [measure],
        better: [],
      });
    });
});
