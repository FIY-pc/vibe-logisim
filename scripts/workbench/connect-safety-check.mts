import assert from "node:assert/strict";
import { connect } from "../../packages/agent-runtime/src/tools/edit.mts";

const document = { id: "demo", revision: "r0", path: "demo.circ" };
const component = (componentId: string, x: number, netId: string) => ({
  componentId,
  factory: "Pin",
  bounds: { x, y: 100, width: 0, height: 0 },
  ends: [
    {
      index: 0,
      width: 1,
      location: { x, y: 100 },
      netBits: [{ bit: 0, netId }],
    },
  ],
});
const view = (joined = false) => ({
  view: {
    circuit: {
      components: [
        component("c100_100", 100, "a"),
        component("c200_100", 200, joined ? "a" : "b"),
      ],
      bundles: [],
      wires: [],
    },
  },
});
let writes = 0,
  previews = 0,
  accepted: any[] = [];
const context: any = {
  target: async () => ({ document, circuit: "main" }),
  observe: async () => view(),
  preview: async (_doc: any, _circuit: any, edits: any[]) => {
    previews++;
    return view(edits.some((e) => e.kind === "wire"));
  },
  assertCurrent() {},
  identity: () => ({}),
  edit: async (_doc: any, _circuit: any, edits: any[]) => {
    writes++;
    accepted = edits;
    const result = {
      title: "batch",
      circuit: "main",
      selection: { components: [], wires: ["w0"] },
    };
    return { result, results: [result], change: document };
  },
};
await assert.rejects(
  connect(context, {
    removeWireIds: ["w0"],
    connections: [
      {
        from: { component: "missing", port: 0 },
        to: { component: "c200_100", port: 0 },
      },
    ],
  }),
  (e: any) => e.code === "PORT_NOT_FOUND",
);
assert.equal(writes, 0);
await connect(context, {
  removeWireIds: ["w0"],
  connections: [
    {
      from: { component: "c100_100", port: 0 },
      to: { component: "c200_100", port: 0 },
    },
  ],
});
assert.equal(writes, 1);
assert.deepEqual(
  accepted.map((e) => e.kind),
  ["delete", "wire"],
);
context.preview = async () => view();
await assert.rejects(
  connect(context, {
    removeWireIds: ["w0"],
    connections: [
      {
        from: { component: "c100_100", port: 0 },
        to: { component: "c200_100", port: 0 },
      },
    ],
  }),
  (e: any) => e.code === "ROUTE_CHANGED_NETS",
);
assert.equal(writes, 1);
assert.ok(previews >= 3);
console.log(
  "Verified failed connection leaves no edits, successful connection is one batch, and rejected netlists never commit.",
);
