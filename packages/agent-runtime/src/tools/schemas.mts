/**
 * The circuit tools as the model sees them: name, label (shown in the
 * conversation), description and JSON Schema. Behaviour lives in the handler
 * modules; keep the two in step. `path` is always relative to the open folder
 * and names the .circ to work on; omitted, the tool works on the current
 * document (the one last opened or created this turn, else the one the user
 * is looking at).
 */
export type ToolName =
  | "open_circuit"
  | "create_circuit"
  | "define_circuit"
  | "inspect_circuit"
  | "render_circuit"
  | "describe_component"
  | "place_component"
  | "set_attributes"
  | "connect"
  | "move_components"
  | "delete_objects"
  | "arrange_circuit"
  | "simulate_circuit"
  | "trace_circuit"
  | "undo_edit"
  | "read_observation";

export interface ToolSpec {
  name: ToolName;
  /** Chinese label the conversation shows for this activity. */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}

const str = (extra: Record<string, unknown> = {}) => ({
  type: "string",
  ...extra,
});
const int = (extra: Record<string, unknown> = {}) => ({
  type: "integer",
  ...extra,
});
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
  ...extra,
});
const array = (items: unknown, extra: Record<string, unknown> = {}) => ({
  type: "array",
  items,
  ...extra,
});
const PATH = str({
  description:
    'The .circ file, relative to the open folder with / separators (e.g. "cpu.circ" or "lib/alu.circ"). Omit to use the current document.',
});
const CIRCUIT = str({
  minLength: 1,
  maxLength: 256,
  description:
    "Exact circuit definition name. Omit for the current circuit, else the main one.",
});
const GRID = { multipleOf: 10 };
const LOCATION = object(
  {
    x: int({ minimum: 0, maximum: 6000, ...GRID }),
    y: int({ minimum: 0, maximum: 6000, ...GRID }),
  },
  ["x", "y"],
);
const ATTRIBUTES = {
  type: "object",
  additionalProperties: str({ maxLength: 65536 }),
  maxProperties: 128,
  description:
    "Native attribute names and values exactly as describe_component reports them.",
};
const PORT = object({ component: str(), port: int({ minimum: 0 }) }, [
  "component",
  "port",
]);
const UNSIGNED = int({ minimum: 0, maximum: 4294967295 });

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  open_circuit: {
    name: "open_circuit",
    label: "打开电路",
    description:
      "Open a .circ file from the folder in the shared canvas and make it the current document, optionally showing one definition. Returns the document id, revision and its circuit names.",
    parameters: object({ path: PATH, circuit: CIRCUIT }, ["path"]),
  },
  create_circuit: {
    name: "create_circuit",
    label: "新建电路",
    description:
      "Create a new empty .circ file in the folder (parent directories must exist), open it and make it the current document. The file starts with one empty definition named main.",
    parameters: object({ path: PATH }, ["path"]),
  },
  define_circuit: {
    name: "define_circuit",
    label: "管理电路定义",
    description:
      "Add, rename or remove circuit definitions in a file, or choose its main circuit. A definition used as a subcircuit elsewhere cannot be removed. Returns the definition list afterwards.",
    parameters: object({
      path: PATH,
      add: array(str({ minLength: 1, maxLength: 256 }), { maxItems: 32 }),
      rename: array(
        object({ from: CIRCUIT, to: str({ minLength: 1, maxLength: 256 }) }, [
          "from",
          "to",
        ]),
        { maxItems: 32 },
      ),
      remove: array(str({ minLength: 1, maxLength: 256 }), { maxItems: 32 }),
      main: str({
        minLength: 1,
        maxLength: 256,
        description: "Definition to make the main circuit.",
      }),
    }),
  },
  inspect_circuit: {
    name: "inspect_circuit",
    label: "查看电路",
    description:
      "Read one definition as the native Logisim runtime loads it. One view per call: no filter for the overview (bounds, counts, first component page, pins, tunnels, state elements, width conflicts); componentIds for details of named parts (ports with positions, widths, directions, bit nets); componentDirectory for a byte-budgeted page of all parts continued by cursor; portConnections for what the listed ports connect to; includeWires (+wireOffset/wireLimit) for wire geometry; layoutContext for the organization inventory arrange_circuit takes; layoutReview for readability measures. Component ids are anchor positions c<x>_<y> (m for negative, _2 for a second part on the same anchor); wire ids and cursors belong to the revision they came from.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      componentIds: array(str(), { maxItems: 64 }),
      componentDirectory: object({
        maxBytes: int({ minimum: 1024, maximum: 32000 }),
        cursor: str({ minLength: 1, maxLength: 80 }),
      }),
      portConnections: object(
        {
          ports: array(
            object({ componentId: str(), port: int({ minimum: 0 }) }, [
              "componentId",
              "port",
            ]),
            { minItems: 1, maxItems: 24 },
          ),
          maxBytes: int({ minimum: 1024, maximum: 32000, default: 24000 }),
          cursor: str({ maxLength: 80 }),
        },
        ["ports"],
      ),
      includeWires: { type: "boolean" },
      wireOffset: int({ minimum: 0 }),
      wireLimit: int({ minimum: 1, maximum: 256 }),
      layoutContext: object(
        {
          pinnedComponentIds: array(str({ maxLength: 64 }), { maxItems: 2048 }),
          panelBelowY: int({ minimum: -100000, maximum: 100000 }),
          keepTunnels: array(str({ maxLength: 128 }), { maxItems: 256 }),
          localiseConstants: { type: "boolean" },
        },
        [],
        {
          description:
            "Compact layout inventory and net graph for planning an organization. Supply {} for defaults; use the same options when arranging. Not combined with other filters.",
        },
      ),
      layoutReview: object({}, [], {
        description:
          "This definition's readability measures as the native runtime loads it (lower reads more easily) and the measures that are not zero. Supply {}.",
      }),
    }),
  },
  render_circuit: {
    name: "render_circuit",
    label: "查看电路图面",
    description:
      "Render one definition as a PNG image, fitted to its contents unless a viewport is given. Look at it when judging readability; re-render after changes.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      viewport: object(
        {
          x: int({ minimum: -10000000, maximum: 10000000 }),
          y: int({ minimum: -10000000, maximum: 10000000 }),
          width: int({ minimum: 1, maximum: 10000000 }),
          height: int({ minimum: 1, maximum: 10000000 }),
          scale: { type: "number", minimum: 0.05, maximum: 32 },
        },
        ["x", "y", "width", "height", "scale"],
      ),
    }),
  },
  describe_component: {
    name: "describe_component",
    label: "查阅原生元件",
    description:
      "Describe a native component as this file's runtime would place it: its default attributes with allowed values, its body bounds and its ports relative to the anchor. Omit library when the tool name is unique across the file's libraries; the empty string library selects this file's own subcircuits. Supply attributes to see how they change ports (e.g. width or inputs).",
    parameters: object(
      {
        path: PATH,
        circuit: CIRCUIT,
        library: str({ maxLength: 1024 }),
        tool: str({ minLength: 1, maxLength: 1024 }),
        attributes: {
          type: "object",
          additionalProperties: str({ maxLength: 4096 }),
        },
      },
      ["tool"],
    ),
  },
  place_component: {
    name: "place_component",
    label: "放置元件",
    description:
      "Place native components or subcircuit instances at grid anchors. Each part becomes addressable as c<x>_<y> right away. Write only the attributes that differ from the defaults describe_component reports. Fails on a body overlap or an occupied anchor and names the first conflict.",
    parameters: object(
      {
        path: PATH,
        circuit: CIRCUIT,
        components: array(
          object(
            {
              factory: str({
                minLength: 1,
                maxLength: 1024,
                description:
                  "Exact native tool name or subcircuit definition name.",
              }),
              library: str({
                maxLength: 1024,
                description:
                  'Library id from the file; "" for subcircuits; omit when the name is unique.',
              }),
              location: LOCATION,
              attributes: ATTRIBUTES,
            },
            ["factory", "location"],
          ),
          { minItems: 1, maxItems: 80 },
        ),
      },
      ["components"],
    ),
  },
  set_attributes: {
    name: "set_attributes",
    label: "修改元件属性",
    description:
      "Change component attributes only: width, label, facing, trigger, value, select bits, ROM/RAM contents (Logisim hex image text) and so on. Positions and wires are changed with move_components, connect and delete_objects.",
    parameters: object(
      {
        path: PATH,
        circuit: CIRCUIT,
        edits: array(
          object(
            {
              componentId: str(),
              attributes: { ...ATTRIBUTES, minProperties: 1 },
            },
            ["componentId", "attributes"],
          ),
          { minItems: 1, maxItems: 240 },
        ),
      },
      ["edits"],
    ),
  },
  connect: {
    name: "connect",
    label: "连接电路",
    description:
      "Wire ports together. Each connection joins the nets of two ports with one orthogonal wire that may branch off any wire already on either net; it goes around component bodies, never touches another net's ports or wire ends, and crosses other wires only at right angles (Logisim leaves those unconnected). Ports already on one net are skipped, ports of different widths are refused, and the call fails with NO_ROUTE (drawing nothing) when no path fits. wires draws given polylines as they are. Optionally removes listed wire segments and places new parts first. Port numbers come from inspect_circuit or describe_component.",
    parameters: object(
      {
        path: PATH,
        circuit: CIRCUIT,
        removeWireIds: array(str({ minLength: 1, maxLength: 128 }), {
          maxItems: 512,
          uniqueItems: true,
          description:
            "Wire ids from the same inspection; removed before routing.",
        }),
        additions: array(
          object(
            {
              factory: str({ minLength: 1, maxLength: 1024 }),
              library: str({ maxLength: 1024 }),
              location: LOCATION,
              attributes: ATTRIBUTES,
            },
            ["factory", "location"],
          ),
          {
            maxItems: 80,
            description:
              "Parts placed before routing; address them as c<x>_<y> in connections.",
          },
        ),
        connections: array(object({ from: PORT, to: PORT }, ["from", "to"]), {
          maxItems: 240,
        }),
        wires: array(
          object(
            {
              points: array(
                object({ x: int(GRID), y: int(GRID) }, ["x", "y"]),
                { minItems: 2, maxItems: 64 },
              ),
            },
            ["points"],
          ),
          {
            maxItems: 240,
            description:
              "Polylines drawn exactly as given, each point a corner; segments must be horizontal or vertical. An end on a port or on another wire joins it.",
          },
        ),
      },
      [],
    ),
  },
  move_components: {
    name: "move_components",
    label: "调整电路布局",
    description:
      "Move components, either to final positions (positions) or all by one delta (componentIds + delta). Wires on moved ports follow them, bent around other ports and wires; a move that would change what is connected is refused with nothing moved. Ids change with the position: a part moved to (x,y) is now c<x>_<y>.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      positions: array(
        object(
          {
            componentId: str(),
            x: int({ minimum: 0, maximum: 6000, ...GRID }),
            y: int({ minimum: 0, maximum: 6000, ...GRID }),
          },
          ["componentId", "x", "y"],
        ),
        { minItems: 1, maxItems: 240 },
      ),
      componentIds: array(str(), { minItems: 1, maxItems: 2048 }),
      delta: object(
        {
          x: int({ minimum: -6000, maximum: 6000, ...GRID }),
          y: int({ minimum: -6000, maximum: 6000, ...GRID }),
        },
        ["x", "y"],
      ),
    }),
  },
  delete_objects: {
    name: "delete_objects",
    label: "删除对象",
    description:
      "Delete components and/or wire segments by id from the same inspection. Deleting a component leaves its wires; list them too when they should go.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      componentIds: array(str(), { maxItems: 2048 }),
      wireIds: array(str(), { maxItems: 512 }),
    }),
  },
  arrange_circuit: {
    name: "arrange_circuit",
    label: "整理布局与连线",
    description:
      "Re-lay out one definition from its netlist and apply it only if it reads more clearly. Parts go in columns by signal flow (input Pins left in their order, output Pins right, a carry chain stepping left to right); a net reaching several ports of one column gets one trunk with short taps; Tunnels stand at the ports of nets the sheet already draws with Tunnels, of controls reaching a dozen ports, and of connections a wire cannot reach cleanly. Every other definition stays byte-identical and the netlist is proven equivalent before anything is applied. The result is applied only when it reads more clearly than the current drawing (lower readability score: crossings, bends, close parallel wires, wires over bodies or grazing ports, labels on wires, overlaps); otherwise applied is false, the file is unchanged and worse names what would have got worse. To lay a large sheet out by function, first read inspect_circuit({layoutContext:{}}) and supply organization: {groups:[{id,label,row,componentIds}], namedLinks?, localSignals?, stages?, annotations?}: each group becomes a box under its numbered heading (real Text), groups of one row stand side by side in the given order, rows stack from the top, and nets between rows become Tunnels. Pinned parts, kept tunnels and the panel row stay where they are. Look at the result with render_circuit and refine the organization rather than the coordinates.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      keepTunnels: array(str({ maxLength: 128 }), {
        maxItems: 256,
        description:
          "Tunnel labels to keep as tunnels instead of wiring their nets.",
      }),
      pinnedComponentIds: array(str({ maxLength: 64 }), {
        maxItems: 2048,
        description:
          "Parts that stay where they are; they cannot be in a group. Interface pins are ordinary parts: leave them unpinned to let the layout place them.",
      }),
      localiseConstants: {
        type: "boolean",
        description:
          "Give each consumer of a Constant its own copy on its port (default true).",
      },
      panelBelowY: int({
        minimum: -100000,
        maximum: 100000,
        description:
          "Only for sheets with a fixed control panel on top: every part whose top edge is above this y stays in place and cannot be grouped. Omit it otherwise (a panel is detected only on sheets of 40 or more parts); a value below the whole drawing freezes everything.",
      }),
      organization: object(
        {
          groups: array(
            object(
              {
                id: str({ minLength: 1, maxLength: 64 }),
                label: str({ minLength: 1, maxLength: 80 }),
                row: int({
                  minimum: 0,
                  maximum: 64,
                  description:
                    "Reading row from the top; keep the principal data path in one row.",
                }),
                componentIds: array(str({ maxLength: 64 }), {
                  minItems: 1,
                  maxItems: 2048,
                }),
              },
              ["id", "label", "row", "componentIds"],
            ),
            { minItems: 1, maxItems: 64 },
          ),
          namedLinks: array(
            object(
              {
                componentId: str(),
                port: int({ minimum: 0 }),
                label: str({ minLength: 1, maxLength: 128 }),
              },
              ["componentId", "port", "label"],
            ),
            { maxItems: 256 },
          ),
          localSignals: array(str(), { maxItems: 256 }),
          stages: array(
            object(
              {
                id: str({ minLength: 1, maxLength: 64 }),
                label: str({ minLength: 1, maxLength: 80 }),
                groups: array(str(), { minItems: 1 }),
                mainPath: array(str(), { minItems: 1 }),
                row: int({ minimum: 0, maximum: 64 }),
              },
              ["id", "label", "groups", "mainPath"],
            ),
            { minItems: 1, maxItems: 32 },
          ),
          annotations: array(
            object(
              {
                componentId: str(),
                role: str({ enum: ["heading", "overview"] }),
                groupId: str(),
              },
              ["componentId", "role"],
            ),
            { maxItems: 2048 },
          ),
        },
        ["groups"],
        {
          description:
            "Functional organization of this definition's parts (ids from the same inspection), not coordinates.",
        },
      ),
    }),
  },
  simulate_circuit: {
    name: "simulate_circuit",
    label: "检查输入输出",
    description:
      "Propagate input pin vectors through one definition in an isolated runtime, each from fresh state, and compare output pins named in expected. Pins are addressed by label. Combinational checks only; use trace_circuit for clocked behaviour. Does not touch the user's live simulation.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      vectorsFile: str({
        description:
          "JSON file of vectors relative to the folder; supply this or vectors.",
      }),
      vectors: array(
        object(
          {
            inputs: { type: "object", additionalProperties: UNSIGNED },
            expected: { type: "object", additionalProperties: UNSIGNED },
          },
          ["inputs"],
        ),
        { minItems: 1, maxItems: 1024 },
      ),
    }),
  },
  trace_circuit: {
    name: "trace_circuit",
    label: "观察时钟执行",
    description:
      "Run one definition for a number of ticks in an isolated runtime from fresh state and sample watched ports after every tick. Drive input pins by label with inputs (initial values), inputClocks (periodic toggles), inputEvents (value at a tick) and buttonEvents; optionally pulse resetButton first and preload a ROM with program. Rows page with rowStart/rowLimit. A tick is one propagation step, not a clock cycle; unknown bits are not zero.",
    parameters: object(
      {
        path: PATH,
        circuit: CIRCUIT,
        ticks: int({ minimum: 1, maximum: 10000 }),
        inputs: { type: "object", additionalProperties: UNSIGNED },
        inputClocks: array(
          object(
            {
              name: str(),
              firstTick: int({ minimum: 0, maximum: 10000 }),
              lastTick: int({ minimum: 0, maximum: 10000 }),
              highTicks: int({ minimum: 1, maximum: 10000 }),
              lowTicks: int({ minimum: 1, maximum: 10000 }),
            },
            ["name"],
          ),
          { maxItems: 16 },
        ),
        inputEvents: array(
          object({ tick: int({ minimum: 0 }), name: str(), value: UNSIGNED }, [
            "tick",
            "name",
            "value",
          ]),
          { maxItems: 1000 },
        ),
        buttonEvents: array(
          object(
            {
              component: str(),
              tick: int({ minimum: 0 }),
              pressed: { type: "boolean" },
            },
            ["component", "tick", "pressed"],
          ),
          { maxItems: 1000 },
        ),
        resetButton: str(),
        watches: array(
          object({ name: str(), component: str(), port: int({ minimum: 0 }) }, [
            "component",
            "port",
          ]),
          { minItems: 1, maxItems: 24 },
        ),
        rowStart: int({ minimum: 0 }),
        rowLimit: int({ minimum: 1, maximum: 256 }),
        program: object(
          {
            component: str(),
            words: array(UNSIGNED, { minItems: 1, maxItems: 4096 }),
          },
          ["component", "words"],
        ),
      },
      ["ticks", "watches"],
    ),
  },
  undo_edit: {
    name: "undo_edit",
    label: "撤销修改",
    description:
      "Undo the latest edit of a document (yours or the user's). A call of an editing tool is one edit, or two for a connect with additions or removals (those, then the wires). Returns the view afterwards with the title of what was undone.",
    parameters: object({ path: PATH }),
  },
  read_observation: {
    name: "read_observation",
    label: "读取留存观察",
    description:
      "List the observations the user kept from live simulation of a document, or read one by id: its revision, instance path, clock state, watched signals and a page of component states. These are frozen moments the user saw, not a new execution.",
    parameters: object({
      path: PATH,
      observationId: str(),
      componentIds: array(str(), { maxItems: 16 }),
      offset: int({ minimum: 0 }),
      limit: int({ minimum: 1, maximum: 16 }),
    }),
  },
};
