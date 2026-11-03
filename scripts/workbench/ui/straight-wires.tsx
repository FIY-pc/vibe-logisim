import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Canvas } from "../../../apps/workbench/src/editor/Canvas";
import { straightWireGroups } from "../../../apps/workbench/src/editor/geometry";
import { buildScene } from "../../../apps/workbench/src/editor/paint";
import type {
  Circuit,
  Document,
  Edit,
  Tool,
} from "../../../apps/workbench/src/shared/types";

const line = (id: string, x1: number, y1: number, x2: number, y2: number) => ({
  id,
  from: { x: x1, y: y1 },
  to: { x: x2, y: y2 },
});
const main = (wires: Circuit["wires"]): Circuit => ({
  name: "main",
  components: [],
  wires,
});
const picture = (wires: Circuit["wires"]) =>
  buildScene(main(wires), () => null, new Set());
const straight = [
  line("w0", 0, 100, 100, 100),
  line("w1", 200, 100, 100, 100), // Reversed file order/direction is valid.
  line("w2", 200, 100, 300, 100),
];
const expectGroup = (
  groups: Map<string, string[]>,
  id: string,
  wanted: string[],
) => assert.deepEqual([...groups.get(id)!].sort(), [...wanted].sort());

export async function verifyStraightWires() {
  let groups = straightWireGroups(picture(straight));
  for (const wire of straight) expectGroup(groups, wire.id, ["w0", "w1", "w2"]);
  groups = straightWireGroups(
    picture(
      straight.map((w) => ({
        ...w,
        from: { x: w.from.y, y: w.from.x },
        to: { x: w.to.y, y: w.to.x },
      })),
    ),
  );
  expectGroup(groups, "w1", ["w0", "w1", "w2"]);

  // Bends must remain individually selectable, even within one wire gesture.
  const bend = line("bend", 300, 100, 300, 200);
  groups = straightWireGroups(picture([...straight, bend]));
  expectGroup(groups, "w2", ["w0", "w1", "w2"]);
  expectGroup(groups, "bend", ["bend"]);

  // A branch at an otherwise invisible break stops selection on both sides.
  groups = straightWireGroups(
    picture([...straight, line("branch", 100, 100, 100, 200)]),
  );
  expectGroup(groups, "w0", ["w0"]);
  expectGroup(groups, "w1", ["w1", "w2"]);
  expectGroup(groups, "branch", ["branch"]);
  // A wire passing through the shared endpoint is also a real junction.
  groups = straightWireGroups(
    picture([...straight, line("through", 100, 50, 100, 150)]),
  );
  expectGroup(groups, "w0", ["w0"]);
  expectGroup(groups, "w1", ["w1", "w2"]);
  // A crossing away from endpoints does not join or split the selected run.
  groups = straightWireGroups(
    picture([...straight, line("crossing", 50, 50, 50, 150)]),
  );
  expectGroup(groups, "w0", ["w0", "w1", "w2"]);
  expectGroup(groups, "crossing", ["crossing"]);
  const scene = picture(straight);
  scene.ports.push({ x: 100, y: 100 });
  groups = straightWireGroups(scene);
  expectGroup(groups, "w0", ["w0"]);
  expectGroup(groups, "w1", ["w1", "w2"]);

  // Exercise real pointer selection, perpendicular dragging and deletion.
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const oldCommand = (globalThis as any).__command;
  (globalThis as any).__command = async (request: any) => {
    if (request.op === "movePreview")
      return { removed: [], added: [], unconnected: [] };
    return { focus: { components: [], wires: [], wireBundles: [] } };
  };
  const circuit = main([...straight, bend]);
  const doc: Document = {
    id: "straight-wires",
    name: "straight.circ",
    revision: "r1",
    paletteIdentity: "straight-wires",
    libraries: [],
    main: "main",
    path: null,
    dirty: false,
    canUndo: false,
    canRedo: false,
    circuits: [circuit],
  };
  const edits: Edit[] = [];
  const errors: unknown[] = [];
  let selected: string[] = [];
  function Harness({ tool = "select" }: { tool?: Tool }) {
    const [selection, setSelection] = useState<string[]>([]);
    selected = selection;
    return (
      <Canvas
        doc={doc}
        circuit={circuit}
        tool={tool}
        selection={selection}
        setSelection={setSelection}
        place={null}
        placement={{
          tool: null,
          template: null,
          attributes: {},
          loading: false,
          error: "",
          repeat: true,
          setRepeat: () => {},
          change: () => {},
          rotate: () => {},
        }}
        onPlace={async () => ({ revision: "r1" })}
        onCancelPlace={() => {}}
        edit={async (edit) => {
          edits.push(edit);
        }}
        live={null}
        pending={[]}
        pressed={null}
        onPoke={() => {}}
        onPress={() => {}}
        onRelease={() => {}}
        onError={(e) => errors.push(e)}
        fitToken={0}
        onOpenMemory={() => {}}
        onEnterCircuit={() => {}}
      />
    );
  }
  const pointer = async (
    type: string,
    x: number,
    y: number,
    shiftKey = false,
  ) => {
    const [vx, vy, vw] = container
      .querySelector("svg[viewBox]")!
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number);
    const scale = 600 / vw;
    await act(async () => {
      container.querySelector(".canvas")!.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: (x - vx) * scale,
          clientY: (y - vy) * scale,
          shiftKey,
        }),
      );
    });
  };
  try {
    await act(async () => root.render(<Harness />));
    for (const x of [50, 150, 250]) {
      await pointer("pointerdown", x, 100);
      await pointer("pointerup", x, 100);
      assert.deepEqual([...selected].sort(), ["w0", "w1", "w2"]);
      assert.equal(container.querySelectorAll(".selection-outline").length, 1);
    }
    await pointer("pointerdown", 50, 100);
    await pointer("pointermove", 70, 120);
    await pointer("pointerup", 70, 120);
    assert.equal(edits.length, 1);
    const move = edits[0];
    assert.equal(move.kind, "move");
    if (move.kind !== "move") throw new Error("Expected a move");
    assert.deepEqual([...move.ids].sort(), ["w0", "w1", "w2"]);
    assert.deepEqual(move.delta, { x: 0, y: 20 });
    await act(async () => {
      container
        .querySelector(".canvas")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
        );
    });
    const deletion = edits[1];
    assert.equal(deletion.kind, "delete");
    if (deletion.kind !== "delete") throw new Error("Expected a deletion");
    assert.deepEqual([...deletion.ids].sort(), ["w0", "w1", "w2"]);
    await pointer("pointerdown", 300, 150);
    await pointer("pointerup", 300, 150);
    assert.deepEqual(selected, ["bend"]);
    await pointer("pointerdown", 150, 100, true);
    await pointer("pointerup", 150, 100, true);
    assert.deepEqual([...selected].sort(), ["bend", "w0", "w1", "w2"]);
    assert.equal(container.querySelectorAll(".selection-outline").length, 2);
    // The reported gesture: click, move, click, move, double-click. It must
    // submit one path; the document's straight-waypoint tests check that this
    // exact path becomes one wire, while the bent variant stays two wires.
    for (const [x, y] of [
      [200, 100],
      [100, 200],
    ]) {
      edits.length = 0;
      await act(async () =>
        root.render(<Harness key={`${x},${y}`} tool="wire" />),
      );
      await pointer("pointerdown", 0, 100);
      await pointer("pointerup", 0, 100);
      await pointer("pointermove", 100, 100);
      await pointer("pointerdown", 100, 100);
      await pointer("pointerup", 100, 100);
      await pointer("pointermove", x, y);
      await pointer("pointerdown", x, y);
      await pointer("pointerup", x, y);
      await pointer("pointerdown", x, y);
      await pointer("pointerup", x, y);
      await pointer("dblclick", x, y);
      assert.deepEqual(edits, [
        {
          kind: "wire",
          points: [
            { x: 0, y: 100 },
            { x: 100, y: 100 },
            { x, y },
          ],
        },
      ]);
    }
    // Retracing a clicked segment must shorten both the preview and the edit.
    const p = (x: number, y: number) => ({ x, y });
    const cases = [
      {
        clicks: [p(0, 100), p(100, 100)],
        end: p(50, 100),
        expected: [p(0, 100), p(50, 100)],
      },
      {
        clicks: [p(0, 100), p(100, 100)],
        end: p(50, 150),
        expected: [p(0, 100), p(50, 100), p(50, 150)],
      },
      {
        clicks: [p(0, 100), p(100, 100)],
        end: p(0, 100),
        expected: [p(0, 100)],
      },
      {
        clicks: [p(0, 100), p(100, 100)],
        end: p(-50, 100),
        expected: [p(0, 100), p(-50, 100)],
      },
      {
        clicks: [p(100, 100), p(0, 100)],
        end: p(50, 150),
        expected: [p(100, 100), p(50, 100), p(50, 150)],
      },
      {
        clicks: [p(0, 0), p(0, 100)],
        end: p(0, 50),
        expected: [p(0, 0), p(0, 50)],
      },
      {
        clicks: [p(0, 100), p(50, 100), p(100, 100)],
        end: p(20, 100),
        expected: [p(0, 100), p(20, 100)],
      },
      {
        clicks: [p(0, 0), p(0, 100), p(100, 100)],
        end: p(50, 100),
        expected: [p(0, 0), p(0, 100), p(50, 100)],
      },
    ];
    for (const [i, { clicks, end, expected }] of cases.entries()) {
      for (const finish of ["enter", "double-click", "drag"]) {
        edits.length = 0;
        await act(async () =>
          root.render(<Harness key={`retrace-${i}-${finish}`} tool="wire" />),
        );
        for (const [index, click] of clicks.entries()) {
          await pointer("pointermove", click.x, click.y);
          await pointer("pointerdown", click.x, click.y);
          if (finish !== "drag" || index < clicks.length - 1)
            await pointer("pointerup", click.x, click.y);
        }
        await pointer("pointermove", end.x, end.y);
        assert.equal(
          container.querySelector("polyline")!.getAttribute("points"),
          expected.map(({ x, y }) => `${x},${y}`).join(" "),
          `preview ${i} ${finish}`,
        );
        if (finish === "drag") {
          await pointer("pointerup", end.x, end.y);
        } else if (finish === "double-click") {
          for (let click = 0; click < 2; click++) {
            await pointer("pointerdown", end.x, end.y);
            await pointer("pointerup", end.x, end.y);
          }
          await pointer("dblclick", end.x, end.y);
        } else {
          await act(async () => {
            container
              .querySelector(".canvas")!
              .dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
              );
          });
        }
        assert.deepEqual(
          edits,
          expected.length > 1 ? [{ kind: "wire", points: expected }] : [],
          `commit ${i} ${finish}`,
        );
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as any).__command = oldCommand;
  }
  console.log(
    "PASS: straight wires select, move and delete across invisible breaks; bends, branches and ports remain boundaries",
  );
}
