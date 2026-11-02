import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { nativeGrader } from "../src/native-grader.mts";
const classPath = process.env.CLASSROOM_TEST_GRADER_CP;
test(
  "annotations and custom appearance preserve full-adder grading without allowing external visual content",
  { skip: !classPath },
  async () => {
    const grade = nativeGrader({
      java: process.env.CLASSROOM_TEST_GRADER_JAVA || "java",
      classPath: classPath!,
    });
    const source = await fs.readFile(
      "packages/showcase/public/assets/full-adder.circ",
      "utf8",
    );
    const tests = Array.from({ length: 8 }, (_, n) => {
      const A = n >> 2,
        B = (n >> 1) & 1,
        Cin = n & 1;
      return {
        id: String(n),
        title: String(n),
        hidden: n > 5,
        inputs: { A, B, Cin },
        expected: { S: (A + B + Cin) % 2, Cout: Number(A + B + Cin >= 2) },
      };
    });
    const annotated = source
      .replace(
        '<main name="main"/>',
        '<lib desc="#Base" name="base"/><main name="main"/>',
      )
      .replace(
        '<circuit name="main">',
        '<circuit name="main"><comp lib="base" name="Text" loc="(100,50)"><a name="text" val="全加器实验说明"/></comp>',
      );
    const appearance =
      '<appear><rect x="50" y="50" width="100" height="60" fill="none" stroke="#000000"/><circ-anchor x="147" y="77" width="6" height="6" facing="east"/></appear>';
    const styled = source.replace(
      '<circuit name="main">',
      '<circuit name="main">' + appearance,
    );
    for (const [name, xml] of [
      ["plain", source],
      ["text", annotated],
      ["appearance", styled],
      [
        "both",
        annotated.replace(
          '<circuit name="main">',
          '<circuit name="main">' + appearance,
        ),
      ],
    ]) {
      const result = await grade({ xml, circuit: "main", tests });
      assert.equal(result.rows.length, 8, name);
      result.rows.forEach((r, i) =>
        assert.deepEqual(
          { S: r.outputs.S.value, Cout: r.outputs.Cout.value },
          tests[i].expected,
          name,
        ),
      );
    }
    for (const extra of [
      '<appear><image href="file:///private.png"/></appear>',
      '<rect x="0" y="0" width="10" height="10"/>',
      '<appear><comp lib="0" name="Pin" loc="(0,0)"/></appear>',
    ])
      await assert.rejects(
        grade({
          xml: source.replace(
            '<circuit name="main">',
            '<circuit name="main">' + extra,
          ),
          circuit: "main",
          tests,
        }),
        /电路无法评测/,
      );
  },
);
test(
  "real Logisim grader evaluates the full truth table and rejects external libraries and recursive subcircuits",
  { skip: !classPath },
  async () => {
    const grade = nativeGrader({
      java: process.env.CLASSROOM_TEST_GRADER_JAVA || "java",
      classPath: classPath!,
    });
    const xml = await fs.readFile(
      "packages/showcase/public/assets/full-adder.circ",
      "utf8",
    );
    const tests = Array.from({ length: 8 }, (_, n) => {
      const b = n.toString(2).padStart(3, "0").split("").map(Number),
        sum = b.reduce((a, b) => a + b, 0);
      return {
        id: String(n),
        title: String(n),
        hidden: n > 1,
        inputs: { A: b[0], B: b[1], Cin: b[2] },
        expected: { S: sum % 2, Cout: Number(sum >= 2) },
      };
    });
    const result = await grade({ xml, circuit: "main", tests });
    assert.equal(result.rows.length, 8);
    result.rows.forEach((r, i) => {
      assert.equal(r.outputs.S.value, tests[i].expected.S);
      assert.equal(r.outputs.Cout.value, tests[i].expected.Cout);
    });
    await assert.rejects(
      grade({
        xml: xml.replace('desc="#Wiring"', 'desc="file#private.circ"'),
        circuit: "main",
        tests,
      }),
      /电路无法评测/,
    );
    await assert.rejects(
      grade({
        xml: xml.replace(
          'desc="#Wiring"',
          'desc="&#106;ar#private.jar#evil.Class"',
        ),
        circuit: "main",
        tests,
      }),
      /电路无法评测/,
    );
    await assert.rejects(
      grade({
        xml: xml.replace(
          '<circuit name="main">',
          '<circuit name="main"><comp name="main" loc="(0,0)"/>',
        ),
        circuit: "main",
        tests,
      }),
      /电路无法评测/,
    );
    await assert.rejects(
      grade({
        xml: '<!DOCTYPE project [<!ENTITY f SYSTEM "file:///etc/passwd">]><project>&f;</project>',
        circuit: "main",
        tests,
      }),
      /电路无法评测/,
    );
  },
);
