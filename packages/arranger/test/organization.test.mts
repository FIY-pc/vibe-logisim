// What the caller sees before arranging: the placement graph it organizes,
// and how an explicit organization comes back annotated.
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  arrange,
  CircuitToolError,
  organizationContext,
  verifyArrangement,
} from "../src/index.mts";
import type { CircuitToolError as ToolError } from "../src/index.mts";

const here = new URL("./fixtures/", import.meta.url).pathname;
const file = (name: string): string => readFileSync(here + name, "utf8");

const XML = file("adder.circ");

// Source Text is listed apart; Pins, placed parts and the probe are members.
const ORGANIZATION = {
  groups: [
    {
      id: "sum",
      label: "Sum path",
      row: 0,
      componentIds: ["c300_150", "c380_150"],
    },
    {
      id: "carry",
      label: "Carry out",
      row: 0,
      componentIds: ["c600_330", "c460_250"],
    },
    {
      id: "ports",
      label: "Ports",
      row: 1,
      componentIds: [
        "c100_100",
        "c100_180",
        "c100_300",
        "c700_250",
        "c700_330",
      ],
    },
  ],
};

function texts(xml: string): string[] {
  return [
    ...xml.matchAll(
      /name="Text"[^>]*>[\s\S]{0,200}?<a name="text" val="([^"]*)"/g,
    ),
  ].map((m) => m[1]);
}

describe("organizationContext", () => {
  it("lists members, nets and annotations", () => {
    const context = organizationContext(
      XML,
      "main",
      JSON.parse(file("adder-main.focus.json")),
      {},
    );
    assert.equal(context.components.length, 9);
    assert.equal(context.nets.length, 8);
    assert.deepEqual(context.fixedComponentIds, []);
    assert.deepEqual(
      context.annotations.map((a: any) => [a.componentId, a.text]),
      [["c380_60", "full adder"]],
    );
    // Tunnels and source Text never become members.
    const members = new Set(context.components.map((c: any) => c.componentId));
    for (const id of ["c270_160", "c300_160", "c100_180_2", "c380_60"])
      assert.ok(!members.has(id), id);
    const probe = context.components.find(
      (c: any) => c.componentId === "c380_150",
    );
    assert.equal(probe.factory, "Probe");
    assert.equal(context.defaultInterfaceOrderProtected, true); // no <appear>: instances order their ports by pin position
  });
});

describe("grouped organization", () => {
  it("places groups in their rows and numbers their headings", async () => {
    const result = await arrange({
      xml: XML,
      circuit: "main",
      focus: JSON.parse(file("adder-main.focus.json")),
      options: { organization: ORGANIZATION },
    });
    const groups = result.report.layoutGroups;
    assert.deepEqual(
      groups.map((g: any) => [g.id, g.row, g.componentIds]),
      ORGANIZATION.groups.map((g) => [g.id, g.row, g.componentIds]),
    );
    assert.deepEqual(texts(result.xml), [
      "full adder",
      "01  Sum path",
      "02  Carry out",
      "03  Ports",
    ]);
    // Row 1 sits below row 0; groups in one row do not overlap.
    assert.ok(groups[2].y > groups[0].y + groups[0].height / 2);
    assert.ok(groups[0].x + groups[0].width <= groups[1].x + groups[1].width);
    const after = JSON.parse(JSON.stringify(result.focus));
    for (const part of after.components) {
      const [dx, dy] = result.placement.get(part.componentId) ?? [0, 0];
      part.location = { x: part.location.x + dx, y: part.location.y + dy };
      for (const end of part.ends)
        end.location = { x: end.location.x + dx, y: end.location.y + dy };
    }
    verifyArrangement(result, after);
  });

  it("reports members it could organize", async () => {
    const error = await arrange({
      xml: XML,
      circuit: "main",
      focus: JSON.parse(file("adder-main.focus.json")),
      options: { organization: { groups: [ORGANIZATION.groups[0]] } },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof CircuitToolError);
    assert.equal((error as ToolError).code, "INVALID_LAYOUT_ORGANIZATION");
    assert.equal(
      (error as ToolError).message,
      "分组遗漏元件: c100_100, c100_180, c100_300, c460_250, c600_330, c700_250, c700_330",
    );
    assert.ok((error as ToolError).hint);
  });

  it("says why a member cannot be grouped", async () => {
    const refused = (options: Record<string, unknown>) =>
      arrange({
        xml: XML,
        circuit: "main",
        focus: JSON.parse(file("adder-main.focus.json")),
        options: { organization: ORGANIZATION, ...options },
      }).then(
        () => null,
        (e: unknown) => (e as ToolError).message,
      );
    // A pin above the panel line is frozen, not a bad id.
    assert.equal(
      await refused({ panelBelowY: 100 }),
      "分组引用的元件 c100_100 在固定的面板里（panelBelowY=100：上边缘在这条线之上的元件原地不动），要布局它就去掉 panelBelowY 或把它改小",
    );
    assert.equal(
      await refused({ pinnedComponentIds: ["c300_150"] }),
      "分组引用的元件 c300_150 在 pinnedComponentIds 里，原地不动的元件不分组",
    );
    const groups = ORGANIZATION.groups.map((g) => ({ ...g }));
    groups[0] = { ...groups[0], componentIds: ["c300_150", "c999_999"] };
    assert.equal(
      await arrange({
        xml: XML,
        circuit: "main",
        focus: JSON.parse(file("adder-main.focus.json")),
        options: { organization: { groups } },
      }).then(
        () => null,
        (e: unknown) => (e as ToolError).message,
      ),
      "分组引用的元件 c999_999 不存在（元件 ID 以当前 inspect_circuit 的结果为准）",
    );
  });
});
