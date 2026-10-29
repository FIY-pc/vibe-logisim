/**
 * The circuit tools as the model sees them: name, label (shown in the
 * conversation), description and JSON Schema (the arguments are validated
 * against it). A description says what the tool does, takes and returns;
 * behaviour lives in the handler modules. `path` is relative to the open
 * folder; omitted, a tool works on the current document (the one last opened
 * or created this turn, else the one the user is looking at).
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

const str = (description?: string) => ({
  type: "string",
  ...(description ? { description } : {}),
});
const int = (extra: Record<string, unknown> = {}) => ({
  type: "integer",
  ...extra,
});
const bool = { type: "boolean" };
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
  description?: string,
) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
  ...(description ? { description } : {}),
});
const array = (items: unknown, maxItems?: number, description?: string) => ({
  type: "array",
  items,
  ...(maxItems ? { maxItems } : {}),
  ...(description ? { description } : {}),
});
const map = (values: unknown, description?: string) => ({
  type: "object",
  additionalProperties: values,
  ...(description ? { description } : {}),
});

const PATH = str();
const CIRCUIT = str();
const COORDINATE = int({ multipleOf: 10 });
const LOCATION = object({ x: COORDINATE, y: COORDINATE }, ["x", "y"]);
const ATTRIBUTES = map(
  str(),
  "Native attribute names and values, only those that differ from the defaults.",
);
const PART = object(
  {
    factory: str("Native component name, or a definition of this file."),
    library: str(
      'Library id; "" for a definition of this file; omit when the name is unique.',
    ),
    location: LOCATION,
    attributes: ATTRIBUTES,
  },
  ["factory", "location"],
);
const PORT = object({ component: str(), port: int() }, ["component", "port"]);
const UNSIGNED = int();
const IDS = array(str(), 2048);
const PAGE = {
  maxBytes: int({ minimum: 1024, maximum: 32000 }),
  cursor: str(),
};
const LAYOUT_OPTIONS = {
  pinnedComponentIds: array(str(), 2048, "Parts that stay where they are."),
  panelBelowY: int({
    description:
      "Parts whose top edge is above this y stay where they are; omitted, a panel on top is detected on sheets of 40 or more parts.",
  }),
  keepTunnels: array(str(), 256, "Tunnel labels that stay Tunnels."),
  localiseConstants: {
    ...bool,
    description:
      "Give each port a Constant drives its own copy (default true).",
  },
};

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  open_circuit: {
    name: "open_circuit",
    label: "打开电路",
    description:
      "Open a .circ file of the folder (or switch to it when it is open) and make it the current document. Returns its id, revision, libraries and definitions with their component and wire counts.",
    parameters: object({ path: PATH, circuit: CIRCUIT }, ["path"]),
  },
  create_circuit: {
    name: "create_circuit",
    label: "新建电路",
    description:
      "Create a .circ file with one empty definition named main (the parent directory must exist), open it and make it the current document.",
    parameters: object({ path: PATH }, ["path"]),
  },
  define_circuit: {
    name: "define_circuit",
    label: "管理电路定义",
    description:
      "Add, rename or remove definitions of a file, or set its main one. A definition used as a subcircuit cannot be removed. Returns the definitions afterwards.",
    parameters: object({
      path: PATH,
      add: array(str(), 32),
      rename: array(object({ from: str(), to: str() }, ["from", "to"]), 32),
      remove: array(str(), 32),
      main: str(),
    }),
  },
  inspect_circuit: {
    name: "inspect_circuit",
    label: "查看电路",
    description:
      "Read one definition as the native Logisim runtime loads it, one view per call. No filter: bounds, counts, pins, tunnels, state elements, width conflicts and a first page of components. componentIds: those parts' attributes with allowed values and their ports with position, width, direction and bit nets. componentDirectory: every part, a page per call. portConnections: what the listed ports connect to. includeWires: wire ids and geometry, paged by wireOffset and wireLimit. layoutContext: the parts, contacts and net graph arrange_circuit's organization refers to. layoutReview: the readability measures arrange_circuit compares (lower reads more easily) and the ones that are not zero.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      componentIds: array(str(), 64),
      componentDirectory: object(PAGE),
      portConnections: object(
        {
          ports: array(
            object({ componentId: str(), port: int() }, [
              "componentId",
              "port",
            ]),
            24,
          ),
          ...PAGE,
        },
        ["ports"],
      ),
      includeWires: bool,
      wireOffset: int(),
      wireLimit: int({ minimum: 1, maximum: 256 }),
      layoutContext: object(
        Object.fromEntries(
          Object.entries(LAYOUT_OPTIONS).map(([key, value]) => {
            const { description: _, ...schema } = value as Record<
              string,
              unknown
            >;
            return [key, schema];
          }),
        ),
        [],
        "{} for the defaults; the options as arrange_circuit takes them.",
      ),
      layoutReview: object({}),
    }),
  },
  render_circuit: {
    name: "render_circuit",
    label: "查看电路图面",
    description:
      "Render one definition as a PNG image, fitted to its contents unless a viewport is given. Returns the image and its viewport.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      viewport: object(
        {
          x: int(),
          y: int(),
          width: int({ minimum: 1 }),
          height: int({ minimum: 1 }),
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
      "A native component as this file's runtime places it: default attributes with allowed values, body bounds and ports relative to the anchor. With attributes, the ports those values give.",
    parameters: object(
      {
        path: PATH,
        circuit: CIRCUIT,
        tool: str("Native component name, or a definition of this file."),
        library: PART.properties.library,
        attributes: map(str()),
      },
      ["tool"],
    ),
  },
  place_component: {
    name: "place_component",
    label: "放置元件",
    description:
      "Place components or subcircuit instances with their anchors at grid points; each is addressable as c<x>_<y> at once. Places nothing and names the first conflict on a body overlap or an occupied anchor.",
    parameters: object(
      { path: PATH, circuit: CIRCUIT, components: array(PART, 80) },
      ["components"],
    ),
  },
  set_attributes: {
    name: "set_attributes",
    label: "修改元件属性",
    description:
      'Change component attributes: width, label, facing, trigger, value, select bits, ROM/RAM "contents" (Logisim hex image text) and so on.',
    parameters: object(
      {
        path: PATH,
        circuit: CIRCUIT,
        edits: array(
          object({ componentId: str(), attributes: ATTRIBUTES }, [
            "componentId",
            "attributes",
          ]),
          240,
        ),
      },
      ["edits"],
    ),
  },
  connect: {
    name: "connect",
    label: "连接电路",
    description:
      "Wire ports together. Each connection draws one orthogonal wire joining the two ports' nets, branching from either net's wires, around bodies, touching no other net's ports or wire ends and crossing other wires only at right angles. Ports already on one net are skipped and ports of different widths refused; NO_ROUTE draws nothing. wires draws polylines as given (an end on a port or wire joins it). removeWireIds and additions are applied first, as a separate edit.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      removeWireIds: array(str(), 512),
      additions: array(PART, 80),
      connections: array(object({ from: PORT, to: PORT }, ["from", "to"]), 240),
      wires: array(
        object(
          {
            points: array(
              object({ x: COORDINATE, y: COORDINATE }, ["x", "y"]),
              64,
            ),
          },
          ["points"],
        ),
        240,
        "Polylines of horizontal and vertical segments, one point per corner.",
      ),
    }),
  },
  move_components: {
    name: "move_components",
    label: "调整电路布局",
    description:
      "Move components, either to final positions (positions) or all by one delta (componentIds + delta), as Logisim's select tool moves them: a moved port keeps what it touched connected through wires stretched or added around other parts, and a port dropped onto a wire or another port connects there. A port with no route back is left unconnected; the reply lists those places (before the move) in unconnected. Ids change with the position: a part moved to (x,y) is now c<x>_<y>.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      positions: array(
        object({ componentId: str(), x: COORDINATE, y: COORDINATE }, [
          "componentId",
          "x",
          "y",
        ]),
        240,
      ),
      componentIds: IDS,
      delta: LOCATION,
    }),
  },
  delete_objects: {
    name: "delete_objects",
    label: "删除对象",
    description:
      "Delete components and wire segments by id. A deleted component's wires stay unless listed.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      componentIds: IDS,
      wireIds: array(str(), 512),
    }),
  },
  arrange_circuit: {
    name: "arrange_circuit",
    label: "整理布局与连线",
    description:
      "Lay one definition out again from its netlist: parts in columns by signal flow, input pins left, output pins right, wires with Tunnels where the sheet uses them, for controls reaching many ports and where a wire cannot reach cleanly. With organization, each group is a box under its numbered heading, groups of a row side by side, rows from the top, nets between rows as Tunnels. Applied only when the netlist is proven equivalent and the readability score drops; every other definition stays byte-identical. Returns applied, the readability before and after and the measures that got better or worse. The organization fields are explained in the reference arrangement.md.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      ...LAYOUT_OPTIONS,
      organization: object(
        {
          groups: array(
            object(
              {
                id: str(),
                label: str(),
                row: int({ minimum: 0, maximum: 64 }),
                componentIds: IDS,
              },
              ["id", "label", "row", "componentIds"],
            ),
            64,
          ),
          namedLinks: array(
            object({ componentId: str(), port: int(), label: str() }, [
              "componentId",
              "port",
              "label",
            ]),
            256,
          ),
          localSignals: array(str(), 256),
          stages: array(
            object(
              {
                id: str(),
                label: str(),
                groups: array(str()),
                mainPath: array(str()),
                row: int({ minimum: 0, maximum: 64 }),
              },
              ["id", "label", "groups", "mainPath"],
            ),
            32,
          ),
          annotations: array(
            object(
              {
                componentId: str(),
                role: { type: "string", enum: ["heading", "overview"] },
                groupId: str(),
              },
              ["componentId", "role"],
            ),
            2048,
          ),
        },
        ["groups"],
      ),
    }),
  },
  simulate_circuit: {
    name: "simulate_circuit",
    label: "检查输入输出",
    description:
      "Propagate input vectors through one definition in an isolated runtime, each from fresh state, and compare the output pins named in expected. Pins are addressed by label. Not the user's live simulation.",
    parameters: object({
      path: PATH,
      circuit: CIRCUIT,
      vectorsFile: str(
        "JSON file of vectors, relative to the folder, instead of vectors.",
      ),
      vectors: array(
        object({ inputs: map(UNSIGNED), expected: map(UNSIGNED) }, ["inputs"]),
        1024,
      ),
    }),
  },
  trace_circuit: {
    name: "trace_circuit",
    label: "观察时钟执行",
    description:
      "Run one definition for ticks in an isolated runtime from fresh state and sample the watched ports after every tick. Input pins by label: inputs (initial values), inputClocks (periodic toggles), inputEvents (a value at a tick); buttonEvents press buttons; resetButton is pulsed first; program preloads a ROM. Rows page with rowStart and rowLimit. A tick is one propagation step. Not the user's live simulation.",
    parameters: object(
      {
        path: PATH,
        circuit: CIRCUIT,
        ticks: int({ minimum: 1, maximum: 10000 }),
        inputs: map(UNSIGNED),
        inputClocks: array(
          object(
            {
              name: str(),
              firstTick: int(),
              lastTick: int(),
              highTicks: int({ minimum: 1 }),
              lowTicks: int({ minimum: 1 }),
            },
            ["name"],
          ),
          16,
        ),
        inputEvents: array(
          object({ tick: int(), name: str(), value: UNSIGNED }, [
            "tick",
            "name",
            "value",
          ]),
          1000,
        ),
        buttonEvents: array(
          object({ component: str(), tick: int(), pressed: bool }, [
            "component",
            "tick",
            "pressed",
          ]),
          1000,
        ),
        resetButton: str(),
        watches: array(
          object({ name: str(), component: str(), port: int() }, [
            "component",
            "port",
          ]),
          24,
        ),
        rowStart: int(),
        rowLimit: int({ minimum: 1, maximum: 256 }),
        program: object({ component: str(), words: array(UNSIGNED, 4096) }, [
          "component",
          "words",
        ]),
      },
      ["ticks", "watches"],
    ),
  },
  undo_edit: {
    name: "undo_edit",
    label: "撤销修改",
    description:
      "Undo the latest edit of a document, yours or the user's. An editing call is one edit; connect with removeWireIds or additions is two. Returns the title of what was undone.",
    parameters: object({ path: PATH }),
  },
  read_observation: {
    name: "read_observation",
    label: "读取留存观察",
    description:
      "List the moments the user kept from live simulation of a document, or read one by observationId: its revision, instance path, clock state, watched signals and a page of component states.",
    parameters: object({
      path: PATH,
      observationId: str(),
      componentIds: array(str(), 16),
      offset: int(),
      limit: int({ minimum: 1, maximum: 16 }),
    }),
  },
};
