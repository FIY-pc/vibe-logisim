"""Re-place and physically wire a tunnel-only circuit into a readable schematic.

Methodology (this is the part an LLM should not improvise per wire):

1. The observed netlist is the specification. Every port belongs to a net
   (the observer's per-bit netIds). Nothing below may change which ports share
   a net; that is verified after emission by re-observing the result.
2. Two kinds of objects: a *fixed panel* (the course's Pins, Probes, displays,
   text, anything the caller pins) that must not move, and the *body* that is
   free to be re-placed. Panel<->body links stay tunnels; body<->body links
   become wires.
3. Net classes: globals (huge fan-out: clock/reset/run) stay tunnels, as any
   human schematic does; constant drivers (Constant, Ground, Power) get a
   private copy next to each consumer instead of a tunnel; everything else is
   wired.
4. Placement is a layered drawing (Sugiyama): layer = longest path from
   sources in the signal-flow DAG with register outputs starting a new layer
   (a pipeline stage), barycenter sweeps to reduce crossings, parts wired
   output to input across neighbouring columns aligned into blocks so those
   wires are straight, then tight grid-snapped coordinate assignment in
   sub-columns of bounded height.
5. Routing is global and ordered: short nets first, then longer ones detour
   around them, using the grid A* router that already knows Logisim's rules
   (never end or bend on foreign copper, never pass through a foreign port,
   prefer a cell of clearance); nets that found no way through are routed
   again first.

Connectivity contract (what makes the result provably equivalent):

- Body copper is rebuilt from scratch; only copper that touches the panel and
  no body port survives. Every real port of a net that is not joined by new
  copper is joined by a labelled Tunnel instead: the net's own label when the
  author gave it one, otherwise a label synthesised from the Pin/part it
  serves (unique within the definition). A hand-drawn net with no label is
  therefore never lost -- it is wired, and if the router cannot reach one of
  its ports that port gets a Tunnel that still names the same net.
- A panel port whose copper was rebuilt gets a Tunnel of the same label on the
  panel side, so the fixed panel never needs to move.
- A port of unknown width (a Probe) belongs to the net of the copper it
  stands on, like any other port (resolve_unknown_widths).
- Circuits that use this one see the same instance: a custom appearance's
  ports follow their Pins; without one, the Pins of each facing keep their
  order, which is what the default appearance is built from
  (interface_signature). Only this definition is rewritten in the file.
"""
from __future__ import annotations

from collections import defaultdict
import copy
import math
import re
import xml.etree.ElementTree as ET
from xml.parsers import expat

from studio.domain.compaction import compact_x
from studio.domain.routing import Router, Partition

GRID = 10
PANEL_FACTORIES = {"Pin", "Probe", "Hex Digit Display", "LED", "Button", "Text", "Clock", "Pull Resistor", "RiscV Probe", "Counter", "D Flip-Flop", "Controlled Buffer", "NAND Gate"}
GLOBAL_FANOUT = 12          # >= this many ports: keep as tunnel (clock/reset/run)
CROSSINGS_PER_CONSUMER = 2  # a named net whose copper crosses more wires than this per consumer becomes Tunnels (hand-drawn: p90)
CROSSINGS_MIN = 6           # ... and at least this many
ABUT_MIN = 3                # parts joined by this many two-port nets whose ports line up are drawn port to port
SATELLITE_GAP = 30          # a Pin facing north (south) stands this far below (above) the port it feeds
SATELLITES = {"Pin", "Clock", "Probe", "Button", "LED", "Constant"}
CONSTANT_SOURCES = ("Constant", "Ground", "Power")   # one-port drivers of a fixed value: a private copy on every consumer port
ROW_GAP = 50                # vertical air between stacked components (registers carry 4 side pins + tunnels)
COLUMN_GAP = 160            # horizontal air between layers (routing channel)
MAX_STACK = 2400            # split a layer into sub-columns beyond this height
GAP_CAP = 200               # a column may grow by this much (plus STACK_SLACK) to line ports up with neighbours
STACK_SLACK = 1.4           # ... and by this factor of its compact height
CHANNEL_MIN = 60            # narrowest routing channel between two columns
CHANNEL_PER_WIRE = 8        # extra channel width per wire that passes through it
SUBCOLUMN_GAP = 120         # between sub-columns of one layer
PIPELINE_STAGES = ("IF", "ID", "EX", "EXE", "MEM", "MA", "WB")   # canonical stage prefixes (upper-cased)
TARGET_ASPECT = 1.5         # width/height the column packing aims at (hand-drawn HUST sheets: p50 1.5-1.8)
COLUMN_HEIGHT_MIN = 200     # a packed column is never shorter than this
STAGGER = 30                # x step between successive depths packed into one column
ROW_SNAP = 20               # a part moves at most this far to share a top with a part in another column
LEVEL_REACH = 100           # ... and this far to put a port level with the port it is wired to (a straight wire)
STORAGE = ("Register", "Counter", "D Flip-Flop", "J-K Flip-Flop", "S-R Flip-Flop", "T Flip-Flop", "Random")
# Students wrap a pipeline register in a subcircuit named after the stages it
# separates: IF/ID, ID-EX, 气泡EX/MEM, ◇MEM/WB ... (HUST corpus: 21/21 ID/EX
# definitions expose a clock pin). Such an instance is a stage boundary and
# belongs to the stage it feeds (the second name).
PIPELINE_REGISTER_RE = re.compile(r"^[◇◆●★☆\s]*(?:气泡)?(?:(IF|ID|EX|EXE|MEM|MA|WB)\s*[/_\-→>—–]\s*(IF|ID|EX|EXE|MEM|MA|WB)"
                                  r"|流水\s*(IF|ID|EX|EXE|MEM|MA|WB)|(IF|ID|EX|EXE|MEM|MA|WB)\s*(?:级)?(?:流水)?寄存器)(?![A-Za-z])", re.I)
COMPACT_GAP = 60            # air right of a part after compaction (hand-drawn: median gap to the right neighbour)
LAYER_SPLIT = 2.5           # a layer this many times taller than the column budget becomes side-by-side columns
FAN_COLUMNS = 4             # Pins level with the ports they are wired to stand at most this many abreast
# Hand-drawn sheets are no denser than this (bodies per million px², by body
# count: a small circuit gets more air than a CPU); compaction stops there.
DENSITY_MAX = ((12, 210), (20, 165), (100, 100), (math.inf, 75))
TUNNEL_SPAN = {1: 800, 2: 600, 3: 500}   # driver->consumer distance (px) above which a named net is tunnelled, by fan-out (corpus 50% points)
UNNAMED_SPAN_FACTOR = 2     # an unnamed net (label synthesised) is wired up to this multiple of the limit
CROSSING_COST = 100         # router cost of crossing a foreign wire during a re-layout (manual edits keep 24)
BEND_COST = 400             # ... and of a corner (manual edits keep 18): a reader minds a corner about four times a crossing
SHELF_WIDTH = 400           # a part at least this wide and 4x wider than tall goes on the shelf above the body
SHELF_GAP = 120             # between the shelf and the body
ROUTER_VISIT_CAP = 600000   # A* budget per route on a re-layout (sheets are wider than a manual edit)
SWEEPS = 24                 # barycenter sweeps (down, up, ...)
TRANSPOSE_ROUNDS = 12       # adjacent-swap rounds after the sweeps
PANEL_MIN_GAP = 40          # whitespace between the panel's last row and the body's first row
PANEL_MIN_PARTS = 12        # a panel is a substantial cluster (course templates: 60-80 parts)
PANEL_IO_SHARE = 0.6        # ... made mostly of I/O and annotation (course panels 0.74-0.9; a logic slice < 0.3)
# ... that shows or drives something for a person (course panels: 20-50 of
# these); a column of interface Pins above the logic of a helper circuit is
# its inputs, not a panel.
PANEL_DISPLAYS = {"Probe", "Hex Digit Display", "LED", "Button", "RiscV Probe", "7-Segment Display", "DotMatrix", "TTY",
                  "Keyboard", "Joystick", "DIP Switch"}
PANEL_MIN_DISPLAYS = 4
TEXT_ATTACH_DISTANCE = 60   # a Text this close to a body part is its caption and moves with it
LABEL_ABBREVIATIONS = {"Multiplexer": "MUX", "Demultiplexer": "DMX", "Decoder": "DEC", "Priority Encoder": "ENC", "Adder": "ADD",
                       "Subtractor": "SUB", "Multiplier": "MUL", "Divider": "DIV", "Negator": "NEG", "Comparator": "CMP", "Shifter": "SHL",
                       "Bit Extender": "EXT", "Splitter": "SPL", "Register": "REG", "Counter": "CNT", "ROM": "ROM", "RAM": "RAM",
                       "AND Gate": "AND", "OR Gate": "OR", "NOT Gate": "NOT", "NAND Gate": "NAND", "NOR Gate": "NOR", "XOR Gate": "XOR",
                       "XNOR Gate": "XNOR", "Buffer": "BUF", "Controlled Buffer": "CBUF", "D Flip-Flop": "DFF", "Constant": "CONST", "Clock": "CLK"}


def _loc(text):
    x, y = map(int, re.findall(r"-?\d+", text))
    return x, y


def _attr_of(element, name):
    """An attribute of a <comp> element as written in the file."""
    for a in element.findall("a"):
        if a.get("name") == name:
            return a.get("val")
    return None


def _text_width(text):
    """Rough width of a label in Logisim's default font (CJK about twice as wide)."""
    return sum(12 if ord(ch) > 0x2E80 else 7 for ch in text) + 10


def _estimated_geometry(element, x, y):
    """Boxes and ports of a component written by the layout itself (a
    Tunnel or Constant has no observation yet): Logisim draws a Tunnel's or
    Constant's body on the side opposite its facing, from the connection point."""
    name, facing = element.get("name"), _attr_of(element, "facing") or "east"
    if name == "Tunnel":
        w, h = _text_width(_attr_of(element, "label") or ""), 20
    elif name == "Constant":
        bits = int(_attr_of(element, "width") or 1)
        w, h = 16 + 10 * max(0, (bits + 3) // 4 - 2), 16
    elif name in ("Ground", "Power"):
        # drawn on the side it faces (14-15 px deep, 16 across)
        w, h = 16, 16
        facing = _OPPOSITE[facing]
    else:
        return [(x - 10, y - 10, x + 10, y + 10)], [(x, y)]
    if facing == "east":
        box = (x - w, y - h // 2, x, y + h // 2)
    elif facing == "west":
        box = (x, y - h // 2, x + w, y + h // 2)
    elif facing == "north":
        box = (x - w // 2, y, x + w // 2, y + h)
    else:
        box = (x - w // 2, y - h, x + w // 2, y)
    return [box], [(x, y)]


_OPPOSITE = {"east": "west", "west": "east", "north": "south", "south": "north"}


def _edge_of(component, idx):
    """The edge of the part's bounds its port idx is on (the nearest one)."""
    b, e = component["bounds"], component["ends"][idx]["location"]
    d = {"west": e["x"] - b["x"], "east": b["x"] + b["width"] - e["x"], "north": e["y"] - b["y"], "south": b["y"] + b["height"] - e["y"]}
    return min(d, key=d.get)


def _attr(component, name):
    for item in component["attributes"]:
        if item.get("name") == name:
            return item.get("value", item.get("standard"))
    return None


def _snap(value):
    return int(round(value / GRID)) * GRID


def _key(bits):
    """Identity of a port's net: the ordered (bit, thread) vector. Two ports are
    the same net only if bit i is the same thread for every i. The unordered
    set is not enough: a splitter re-combining IR[31:25]++IR[11:7] and a
    splitter selecting bits 7-11,25-31 carry the same threads in a different
    order, and wiring them together would short the threads."""
    return tuple((b["bit"], b["netId"]) for b in sorted(bits, key=lambda b: b["bit"]))


def _sanitize_label(text):
    text = re.sub(r"[^\w.\-]+", "_", str(text)).strip("_")
    return text[:32] or "NET"


class _UnionFind:
    def __init__(self):
        self.parent = {}

    def root(self, p):
        self.parent.setdefault(p, p)
        while self.parent[p] != p:
            self.parent[p] = self.parent[self.parent[p]]
            p = self.parent[p]
        return p

    def join(self, a, b):
        ra, rb = self.root(a), self.root(b)
        if ra != rb:
            self.parent[ra] = rb


def resolve_unknown_widths(focus):
    """Give ports of unknown width the net of the copper they stand on.

    The observer reports a port's net bits per declared bit, so a port whose
    width is only settled at run time -- a Probe, typically a panel display
    wired to a statistics Counter -- comes back with none. Such a port looks
    unconnected: a re-layout would delete its copper without replacing it and
    a netlist comparison would not notice. Logisim gives it the width of the
    bundle it touches, and so does this: the bits of the wire bundle through
    the port's point, else those of another port on the same point. Ends that
    touch nothing stay empty. Idempotent; returns the number of ends resolved."""
    at_point = {}
    for bundle in focus.get("wireBundles", []):
        bits = [b for b in bundle.get("bitNets", []) if b.get("netId")]
        if bits and bundle.get("valid", True):
            for p in bundle.get("points", []):
                at_point[(p["x"], p["y"])] = bits
    for c in focus["components"]:
        for e in c["ends"]:
            if e.get("netBits"):
                at_point.setdefault((e["location"]["x"], e["location"]["y"]), e["netBits"])
    resolved = 0
    for c in focus["components"]:
        for e in c["ends"]:
            if e.get("width") is None and not e.get("netBits"):
                bits = at_point.get((e["location"]["x"], e["location"]["y"]))
                if bits:
                    e["netBits"] = [{"bit": b["bit"], "netId": b["netId"]} for b in bits]
                    e["width"] = max(b["bit"] for b in bits) + 1
                    resolved += 1
    return resolved


def _facing(element):
    a = element.find("a[@name='facing']")
    return a.get("val") if a is not None else "east"


def _pin_order_key(facing):
    """Logisim's default appearance puts the Pins of one facing on one edge of
    the instance, in the order of their y (x for north- and south-facing Pins)."""
    if facing in ("north", "south"):
        return lambda p: (p[0], p[1])
    return lambda p: (p[1], p[0])


def interface_signature(circuit, identify=lambda p: p):
    """What an instance of this circuit looks like from outside, as far as
    moving its parts can change it. `circuit` is the <circuit> element;
    `identify` maps a Pin location to a stable identity (the original
    location, for a re-laid-out circuit).

    A custom appearance (<appear>) fixes every port on the instance and names
    its Pin by location: the pairs (port position, Pin). Without one, Logisim
    derives the instance from the Pins themselves: per facing, the Pins in
    order. Moving a Pin past another of the same facing swaps two ports in
    every circuit that uses this one, without changing a single connection
    inside it."""
    pins = [(_loc(e.get("loc")), _facing(e)) for e in circuit.findall("comp") if e.get("name") == "Pin"]
    appear = circuit.find("appear")
    if appear is not None:
        ports = []
        for port in appear.iter("circ-port"):
            try:
                p = tuple(int(v) for v in port.get("pin", "").split(","))
            except ValueError:
                p = None
            ports.append((port.get("x"), port.get("y"), identify(p) if p and len(p) == 2 else None))
        return ("custom", tuple(sorted(ports, key=str)), tuple(sorted((identify(p) for p, _f in pins), key=str)))
    groups = defaultdict(list)
    for p, f in pins:
        groups[f].append(p)
    return ("default", tuple(sorted((f, tuple(identify(p) for p in sorted(ps, key=_pin_order_key(f)))) for f, ps in groups.items())))


def _circuit_span(raw, name):
    """Byte offsets of <circuit name=...>...</circuit> in the UTF-8 file, or
    None (absent, or an empty element)."""
    parser = expat.ParserCreate()
    found, depth = {}, [0]

    def start(tag, attrs):
        depth[0] += 1
        if tag == "circuit" and depth[0] == 2 and attrs.get("name") == name and "start" not in found:
            found["start"] = parser.CurrentByteIndex

    def end(tag):
        if tag == "circuit" and depth[0] == 2 and "start" in found and "end" not in found:
            found["end"] = parser.CurrentByteIndex
        depth[0] -= 1

    parser.StartElementHandler, parser.EndElementHandler = start, end
    parser.Parse(raw, True)
    if "end" not in found or found["end"] == found["start"]:
        return None
    return found["start"], raw.index(b">", found["end"]) + 1


def splice_circuit(source, name, circuit):
    """The file text with only this <circuit> replaced by `circuit`. The XML
    declaration, libraries, options, toolbar and every other definition stay
    byte for byte what the author (or their Logisim) wrote."""
    tail, circuit.tail = circuit.tail, None
    try:
        text = ET.tostring(circuit, encoding="unicode").replace(" />", "/>")
    finally:
        circuit.tail = tail
    raw = source.encode("utf-8")
    span = _circuit_span(raw, name)
    if span is None:
        raise ValueError(f"circuit {name!r} not found in the source text")
    if b"\r\n" in raw[span[0]:span[1]]:
        text = text.replace("\n", "\r\n")
    return (raw[:span[0]] + text.encode("utf-8") + raw[span[1]:]).decode("utf-8")


class SchematicLayout:
    def __init__(self, xml_text, circuit_name, focus, *, pinned_ids=(), keep_tunnels=(), localise_constants=True, panel_below_y=None):
        self.source, self.circuit_name = xml_text, circuit_name
        self.tree = ET.ElementTree(ET.fromstring(xml_text))
        root = self.tree.getroot()
        self.circuit = next(c for c in root.findall("circuit") if c.get("name") == circuit_name)
        self.wiring_lib = next((lib.get("name") for lib in root.findall("lib") if lib.get("desc") == "#Wiring"), "0")
        resolved = resolve_unknown_widths(focus)
        self.focus = focus
        self.components = focus["components"]
        self.by_id = {c["componentId"]: c for c in self.components}
        self.pinned = set(pinned_ids)
        self.keep_tunnels = set(keep_tunnels)
        self.localise_constants = localise_constants
        self.report = {"nets": {}, "moved": 0, "wires": 0, "tunnelsRemoved": 0, "tunnelsKept": 0, "constantsPlaced": 0, "unrouted": [], "synthesizedLabels": [],
                       "portsWidthFromNet": resolved}
        self.column_gap = COLUMN_GAP
        # A named net that runs backwards (consumer left of its driver: write-
        # back, branch target, feedback) keeps its Tunnels, as in any hand-drawn
        # schematic; a forward net is wired unless it spans more than this many
        # columns. Unnamed nets are always wired (see _place).
        self.max_layer_span = 8
        self.crossing_cost = CROSSING_COST
        self.bend_cost = BEND_COST
        self.route_order = "short"           # short nets first (long ones detour around them) | "long"
        self.column_height = None            # packed-column height budget; None = from TARGET_ASPECT (see _pack_columns)
        self.stagger = STAGGER
        self.tunnel_span_scale = 1.0         # multiplies TUNNEL_SPAN (1.0 = corpus two-thirds points)
        self.row_gap = ROW_GAP
        self.balance, self.even_moves = "even", 0      # _balance rule of the drawing being made (see _arrange)
        self.channel_min = CHANNEL_MIN
        self.stack_slack = STACK_SLACK
        self.gap_cap = GAP_CAP
        self.sheet_gap = COMPACT_GAP            # least air between parts on the routed sheet (see _compact_sheet); 0 turns that off
        self.panel_below_y = panel_below_y if panel_below_y is not None else self._detect_panel()
        self.report["panelBelowY"] = self.panel_below_y
        self._bind_xml()

    def _detect_panel(self):
        """The fixed observation panel is the top band of the drawing that is
        made mostly of I/O and annotation and is separated from the body by a
        row of whitespace. Returns the y below which components are free to
        move; None = no panel (small circuits, or a panel interleaved with the
        body, whose Pins then take their natural place as sources and sinks).

        Composition, not size ratio or gap size, is the criterion: an 80-part
        panel over a 330-part CPU is still a panel, and a student who leaves
        60 px instead of the template's 250 px between panel and body has still
        drawn a panel. A sparse first stage of pure logic is body, and so is a
        column of interface Pins over the logic of a helper circuit: a panel
        shows something (probes, displays, buttons). A course page before the
        student has drawn anything is all panel; nothing on it moves."""
        real = sorted((c for c in self.components if c["factoryName"] != "Tunnel"), key=lambda c: c["bounds"]["y"])
        if len(real) < 40 or len({c["bounds"]["y"] for c in real}) < 4:
            return None
        bands, current, bottom = [], [], None
        for c in real:
            if current and c["bounds"]["y"] - bottom >= PANEL_MIN_GAP:
                bands.append((current, bottom))
                current, bottom = [], None
            current.append(c)
            bottom = max(bottom if bottom is not None else -10 ** 9, c["bounds"]["y"] + c["bounds"]["height"])
        bands.append((current, bottom))
        best, cluster = None, []
        for i, (band, bottom) in enumerate(bands):
            io_band = sum(1 for c in band if c["factoryName"] in PANEL_FACTORIES)
            if io_band < PANEL_IO_SHARE * len(band):
                break                       # a logic row: the body starts here
            cluster.extend(band)
            io = sum(1 for c in cluster if c["factoryName"] in PANEL_FACTORIES)
            shows = sum(1 for c in cluster if c["factoryName"] in PANEL_DISPLAYS)
            if len(cluster) >= PANEL_MIN_PARTS and io >= PANEL_IO_SHARE * len(cluster) and shows >= PANEL_MIN_DISPLAYS:
                below = bands[i + 1][0][0]["bounds"]["y"] if i + 1 < len(bands) else bottom + PANEL_MIN_GAP
                best = (bottom + below) // 2
        return best

    # ---- observation -> model -------------------------------------------------
    def _bind_xml(self):
        """Pair each observed component with its XML element by location+factory."""
        elements = defaultdict(list)
        for element in self.circuit.findall("comp"):
            elements[(_loc(element.get("loc")), element.get("name"))].append(element)
        self.element_of = {}
        for c in self.components:
            key = ((c["location"]["x"], c["location"]["y"]), c["factoryName"])
            candidates = elements.get(key) or elements.get((key[0], c.get("displayName")))
            if not candidates:
                # Subcircuit instances are named after the definition.
                candidates = [e for (loc, name), es in elements.items() if loc == key[0] for e in es]
            if not candidates:
                raise ValueError(f"cannot bind observed component {c['componentId']} at {key}")
            self.element_of[c["componentId"]] = candidates.pop(0)

    def _nets(self):
        nets = defaultdict(list)           # netKey -> [(componentId, endIndex)]
        bits_of = {}
        for c in self.components:
            for e in c["ends"]:
                bits = e.get("netBits") or []
                if not bits:
                    continue
                key = _key(bits)
                nets[key].append((c["componentId"], e["index"]))
                bits_of.setdefault(key, sorted(bits, key=lambda b: b["bit"]))
        return nets, bits_of

    def _is_panel(self, c):
        if c["componentId"] in self.pinned:
            return True
        if self.panel_below_y is not None:
            return c["bounds"]["y"] < self.panel_below_y
        # No detected panel: everything is body. Input/output Pins then take
        # their natural place as sources on the left and sinks on the right.
        return False

    def _is_storage(self, cid):
        c = self.by_id[cid]
        return c["factoryName"] in STORAGE or PIPELINE_REGISTER_RE.search(c["factoryName"] or "") is not None

    def _stage_prefix(self, cid):
        """The pipeline stage a register belongs to: the 'EX' of a label
        'EX.PC', or the second stage in a pipeline-register subcircuit's name
        ('ID/EX' starts EX). None when the register carries neither."""
        c = self.by_id[cid]
        label = _attr(c, "label") or ""
        if "." in label and label.split(".", 1)[0].isalpha():
            return label.split(".", 1)[0].upper()
        m = PIPELINE_REGISTER_RE.search(c["factoryName"] or "")
        if not m:
            return None
        return (m.group(2) or m.group(3) or m.group(4)).upper()

    def plan(self):
        nets, bits_of = self._nets()
        tunnels = {c["componentId"]: c for c in self.components if c["factoryName"] == "Tunnel"}
        labels_of_net = defaultdict(set)
        for key, ports in nets.items():
            for cid, _ in ports:
                if cid in tunnels and _attr(tunnels[cid], "label"):
                    labels_of_net[key].add(_attr(tunnels[cid], "label"))
        label_of_net = {key: sorted(labels)[0] for key, labels in labels_of_net.items()}
        body = [c for c in self.components if c["factoryName"] != "Tunnel" and not self._is_panel(c)]
        body_ids = {c["componentId"] for c in body}
        constants = {c["componentId"]: c for c in body if c["factoryName"] in CONSTANT_SOURCES}

        classes = {}
        for key, ports in nets.items():
            real = [(cid, idx) for cid, idx in ports if cid not in tunnels]
            body_ports = [(cid, idx) for cid, idx in real if cid in body_ids]
            drivers = [cid for cid, idx in real if cid in constants]
            if labels_of_net.get(key, set()) & self.keep_tunnels:
                classes[key] = "global"
            elif (self.localise_constants and len(drivers) == 1 and len(real) >= 2
                  and all(self.by_id[cid]["ends"][idx].get("direction") != "output" or cid in constants for cid, idx in real)):
                # one Constant, only consumers: each consumer gets a private
                # Constant on its port (a single consumer too -- a Constant two
                # columns away from the mux select it feeds is a long wire for nothing)
                classes[key] = "constant"
            elif len(real) >= GLOBAL_FANOUT:
                classes[key] = "global"
            elif len(body_ports) >= 2:
                classes[key] = "wire"
            else:
                classes[key] = "tunnel"
        self.nets, self.bits_of, self.classes, self.label_of_net, self.labels_of_net = nets, bits_of, classes, label_of_net, labels_of_net
        self.tunnels, self.body, self.constants, self.body_ids = tunnels, body, constants, body_ids
        self.copies = self._splitter_copies()
        self.fused, self.relocated = self._contact_groups(), {}
        for cid, (host, offset) in {**self._abutments(), **self._satellites()}.items():
            self.fused[cid] = self.fused.get(host, host)
            self.relocated[cid] = offset
        # Labels already used by any Tunnel of this definition (case-insensitive):
        # a synthesised label must not merge a net into an existing one.
        self.used_labels = {str(el.find("a[@name='label']").get("val")).lower() for el in self.circuit.findall("comp")
                            if el.get("name") == "Tunnel" and el.find("a[@name='label']") is not None}
        self.synthesized = {}
        self.abbr_counter = defaultdict(int)
        summary = defaultdict(int)
        for k, v in classes.items():
            summary[v] += 1
        self.report["nets"] = dict(summary)
        return classes

    def _splitter_copies(self):
        """Nets that reach several copies of one Splitter: split ends of
        Splitters whose combined ends hang on the same bus. Those ends are
        connected through the bus already, so every other port of the net
        needs copper to one copy only -- the one the author drew it nearest
        to -- and the net is drawn as one tree per copy. People split a bus
        again beside each part it feeds rather than run the bit wires of one
        Splitter across the sheet; joining the copies bit by bit undoes that.
        Returns {net: [(copy port, [ports it serves])]}."""
        bus_of = {}
        for key, ports in self.nets.items():
            for cid, idx in ports:
                if idx == 0 and self.by_id[cid]["factoryName"] == "Splitter" and self.classes.get(key) != "constant":
                    bus_of[cid] = key

        def at(port):
            loc = self.by_id[port[0]]["ends"][port[1]]["location"]
            return loc["x"], loc["y"]

        def centre(cid):
            b = self.by_id[cid]["bounds"]
            return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2

        def distance(a, b):
            (ax, ay), (bx, by) = centre(a), centre(b)
            return abs(ax - bx) + abs(ay - by)

        found = []
        for key, ports in self.nets.items():
            real = [(cid, idx) for cid, idx in ports if cid not in self.tunnels]
            if any(cid not in self.body_ids for cid, _idx in real):
                continue                    # a panel port: the net bridges by label (see _route)
            by_bus = defaultdict(list)
            for cid, idx in real:
                if idx > 0 and cid in bus_of:
                    by_bus[bus_of[cid]].append((cid, idx))
            group = max(by_bus.values(), key=len, default=[])
            if len(group) >= 2:
                found.append((key, real, group))
        # Each part the copies feed gets one copy for every bit of the bus
        # (a part fed some bits by one copy and some by another draws two
        # bundles that cross): the nearest free copy, nearest pairs first, as
        # long as copies are free; the author put each copy by its part.
        consumers = defaultdict(set)
        for key, real, group in found:
            copies_of = frozenset(cid for cid, _idx in group)
            consumers[copies_of].update(cid for cid, _idx in real if cid not in copies_of)
        pairing = {}
        for copies_of, parts in consumers.items():
            free, chosen = set(copies_of), {}
            for d, part, copy in sorted((distance(part, copy), part, copy) for part in parts for copy in copies_of):
                if part not in chosen and copy in free:
                    chosen[part] = copy
                    free.discard(copy)
            for part in parts:
                chosen.setdefault(part, min(copies_of, key=lambda c: (distance(part, c), c)))
            pairing[copies_of] = chosen
        copies = {}
        for key, real, group in found:
            copies_of = frozenset(cid for cid, _idx in group)
            served = {port: [] for port in group}
            copy_port = {cid: (cid, idx) for cid, idx in group}
            for port in real:
                if port not in served:
                    served[copy_port[pairing[copies_of][port[0]]]].append(port)
            copies[key] = [(port, rest) for port, rest in served.items() if rest]
        return copies

    def _contact_groups(self):
        """Parts drawn port to port on two or more ports -- a Splitter set on
        a decoder's outputs, a bus split right at a display -- are one rigid
        piece: moved apart, every shared port becomes a wire of its own (a
        decoder and its Splitter, 32 ports, drawn as 32 crossing wires).
        Returns {part: the part it moves with}. That host is a clocked part
        when there is one (it stays a stage boundary), else the largest part
        that is not a Splitter."""
        at = defaultdict(set)
        for c in self.body:
            if c["factoryName"] == "Text" or c["factoryName"] in CONSTANT_SOURCES:
                continue
            for e in c["ends"]:
                at[(e["location"]["x"], e["location"]["y"])].add(c["componentId"])
        shared = defaultdict(int)
        for cids in at.values():
            ordered = sorted(cids)
            for i, a in enumerate(ordered):
                for b in ordered[i + 1:]:
                    shared[(a, b)] += 1
        pieces = _UnionFind()
        members = set()
        for (a, b), n in shared.items():
            if n >= 2:
                pieces.join(a, b)
                members.update((a, b))
        by_piece = defaultdict(list)
        for cid in sorted(members):
            by_piece[pieces.root(cid)].append(cid)

        def rank(cid):
            b = self.by_id[cid]["bounds"]
            return (self._is_storage(cid), self.by_id[cid]["factoryName"] != "Splitter", b["width"] * b["height"], cid)

        fused = {}
        for cids in by_piece.values():
            host = max(cids, key=rank)
            fused.update({cid: host for cid in cids if cid != host})
        return fused

    def _abutments(self):
        """A Splitter joined to a part by ABUT_MIN or more two-port nets whose
        ports have the same spacing on one edge of the part -- its bit ends
        and a decoder's outputs, both 10 px apart -- is drawn port to port,
        the way people draw it: those nets then need no wire at all (moved
        apart, 32 of them run as a bundle across the sheet). The Splitter
        moves onto the part, never onto a port of another net nor into its
        body. Returns {Splitter: (part, (dx, dy) from where it was)}."""
        links = defaultdict(list)
        for key, ports in self.nets.items():
            real = [(cid, idx) for cid, idx in ports if cid not in self.tunnels]
            if self.classes.get(key) != "wire" or len(real) != 2 or real[0][0] == real[1][0]:
                continue
            if not all(cid in self.body_ids and cid not in self.fused and self.by_id[cid]["factoryName"] not in ("Text",) + CONSTANT_SOURCES for cid, _i in real):
                continue
            (a, i), (b, j) = sorted(real)
            links[(a, b)].append((i, j))

        def area(cid):
            b = self.by_id[cid]["bounds"]
            return b["width"] * b["height"]

        out, hosts = {}, set()
        for (a, b), pairs in sorted(links.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            if len(pairs) < ABUT_MIN:
                continue
            host, part = (a, b) if (area(a), a) >= (area(b), b) else (b, a)
            if part in out or part in hosts or host in out or self.by_id[part]["factoryName"] != "Splitter":
                continue                          # people butt a Splitter against a part, not two parts
            h, m = self.by_id[host], self.by_id[part]
            ports = [(i, j) if host == a else (j, i) for i, j in pairs]          # (host port, part port)
            offsets = {(h["ends"][hi]["location"]["x"] - m["ends"][mi]["location"]["x"],
                        h["ends"][hi]["location"]["y"] - m["ends"][mi]["location"]["y"]) for hi, mi in ports}
            if len(offsets) != 1 or len({_edge_of(h, hi) for hi, _mi in ports}) != 1:
                continue                          # not one edge of the host, or the spacings differ
            dx, dy = next(iter(offsets))
            hb, mb = h["bounds"], m["bounds"]
            over_x = min(hb["x"] + hb["width"], mb["x"] + dx + mb["width"]) - max(hb["x"], mb["x"] + dx)
            over_y = min(hb["y"] + hb["height"], mb["y"] + dy + mb["height"]) - max(hb["y"], mb["y"] + dy)
            if over_x >= GRID and over_y >= GRID:
                continue                          # the bodies would overlap
            nets_at = {(e["location"]["x"], e["location"]["y"]): _key(e.get("netBits") or []) for e in h["ends"]}
            if any(nets_at.get((e["location"]["x"] + dx, e["location"]["y"] + dy), _key(e.get("netBits") or [])) != _key(e.get("netBits") or [])
                   for e in m["ends"]):
                continue                          # a port would land on a port of another net
            out[part] = (host, (dx, dy))
            hosts.add(host)
        return out

    def _satellites(self):
        """One-port parts facing north or south (a Pin with its port on top)
        whose only wire runs to a port on the facing edge of one other part:
        they stand right below (or above) that port, the way people draw the
        address and enable Pins of a register file, instead of in the input
        column with a wire round the part. Several on one edge stand in a row
        in the order of their ports, moved sideways as little as their widths
        need. Returns {part: (host, (dx, dy) from where the author drew it)}."""
        net_of = {port: key for key, ports in self.nets.items() for port in ports}
        rows = defaultdict(list)
        for c in self.body:
            cid = c["componentId"]
            facing = _attr(c, "facing")
            if c["factoryName"] not in SATELLITES or len(c["ends"]) != 1 or facing not in ("north", "south") or cid in self.fused:
                continue
            key = net_of.get((cid, 0))
            if key is None or self.classes.get(key) != "wire":
                continue
            others = [(o, i) for o, i in self.nets[key] if o != cid and o not in self.tunnels]
            if len(others) != 1 or others[0][0] not in self.body_ids or self.by_id[others[0][0]]["factoryName"] in SATELLITES:
                continue
            host, idx = others[0]
            edge = _edge_of(self.by_id[host], idx)
            if edge == {"north": "south", "south": "north"}[facing]:
                rows[(host, edge)].append((self.by_id[host]["ends"][idx]["location"], cid))
        out = {}
        for (host, edge), row in rows.items():
            right = -math.inf
            for port, cid in sorted(row, key=lambda r: (r[0]["x"], r[1])):
                c = self.by_id[cid]
                own, b = c["ends"][0]["location"], c["bounds"]
                left_of, right_of = own["x"] - b["x"], b["x"] + b["width"] - own["x"]
                x = port["x"] if right == -math.inf else max(port["x"], GRID * math.ceil((right + GRID + left_of) / GRID))
                right = x + right_of
                y = port["y"] + (SATELLITE_GAP if edge == "south" else -SATELLITE_GAP)
                out[cid] = (host, (x - own["x"], y - own["y"]))
        return out

    def _fused_view(self):
        """by_id, nets, body, body_ids and copies as placement sees them: each
        fused piece (see _contact_groups) is its host with the members' union
        box and all their ports, a net inside one piece has one port."""
        by_id, remap = dict(self.by_id), {}
        for host in set(self.fused.values()):
            parts = [host] + sorted(p for p, h in self.fused.items() if h == host)

            def box(m):
                b = self.by_id[m]["bounds"]
                dx, dy = self.relocated.get(m, (0, 0))
                return {"x": b["x"] + dx, "y": b["y"] + dy, "width": b["width"], "height": b["height"]}

            boxes = [box(m) for m in parts]
            x0, y0 = min(b["x"] for b in boxes), min(b["y"] for b in boxes)
            x1, y1 = max(b["x"] + b["width"] for b in boxes), max(b["y"] + b["height"] for b in boxes)
            ends, seen = [], {}
            for m in parts:
                dx, dy = self.relocated.get(m, (0, 0))
                for e in self.by_id[m]["ends"]:
                    at = {"x": e["location"]["x"] + dx, "y": e["location"]["y"] + dy}
                    loc = (at["x"], at["y"], _key(e.get("netBits") or []))
                    if loc not in seen:            # ports drawn onto each other are one port of the piece
                        seen[loc] = len(ends)
                        ends.append(dict(e, index=len(ends), location=at))
                    remap[(m, e["index"])] = (host, seen[loc])
            by_id[host] = dict(self.by_id[host], bounds={"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}, ends=ends)
        nets = {}
        for key, ports in self.nets.items():
            mapped = []
            for port in ports:
                port = remap.get(port, port)
                if port not in mapped:
                    mapped.append(port)
            nets[key] = mapped
        body = [by_id[c["componentId"]] for c in self.body if c["componentId"] not in self.fused]
        copies = {key: [(remap.get(copy, copy), [remap.get(p, p) for p in served]) for copy, served in groups]
                  for key, groups in self.copies.items()}
        return by_id, nets, body, self.body_ids - set(self.fused), copies

    # ---- labels ------------------------------------------------------------------
    def _labels_for(self, key):
        """The label set that names a net: the author's Tunnel labels, else one
        synthesised label (Pin/Probe label > driver label[.port] > consumer
        label.port > factory abbreviation + ordinal), unique in the definition."""
        labels = self.labels_of_net.get(key)
        if labels:
            return sorted(labels)
        if key in self.synthesized:
            return [self.synthesized[key]]
        base = self._derive_label(key)
        label, k = base, 2
        while label.lower() in self.used_labels:
            label = f"{base}_{k}"
            k += 1
        self.used_labels.add(label.lower())
        self.synthesized[key] = label
        self.report["synthesizedLabels"].append(label)
        return [label]

    def _derive_label(self, key):
        ports = [(cid, idx) for cid, idx in self.nets[key] if cid not in self.tunnels]

        def port_word(c, idx):
            tip = c["ends"][idx].get("runtimeTooltip") or ""
            m = re.match(r"\s*([^\W\d_][\w]*)", tip)
            return m.group(1) if m else f"p{idx}"

        for cid, idx in ports:
            c = self.by_id[cid]
            if c["factoryName"] in ("Pin", "Probe", "LED", "Hex Digit Display", "Button") and _attr(c, "label"):
                return _sanitize_label(_attr(c, "label"))
        outputs = [(cid, idx) for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") == "output"]
        if any(self.by_id[cid]["factoryName"] == "Clock" for cid, idx in outputs):
            return "CLK"
        for cid, idx in outputs:
            c = self.by_id[cid]
            label = _attr(c, "label")
            if label:
                n_out = sum(1 for e in c["ends"] if e.get("direction") == "output")
                return _sanitize_label(label if n_out == 1 else f"{label}.{port_word(c, idx)}")
        for cid, idx in ports:
            c = self.by_id[cid]
            label = _attr(c, "label")
            if label and c["ends"][idx].get("direction") == "input":
                return _sanitize_label(f"{label}.{port_word(c, idx)}")
        cid, idx = (outputs or ports)[0]
        c = self.by_id[cid]
        abbr = LABEL_ABBREVIATIONS.get(c["factoryName"]) or re.sub(r"[^A-Za-z]", "", c["factoryName"])[:4].upper() or "NET"
        self.abbr_counter[abbr] += 1
        return f"{abbr}{self.abbr_counter[abbr]}"

    # ---- placement -------------------------------------------------------------
    def _graph(self, *, all_nets=False):
        """Directed signal flow among body components.

        With all_nets the graph includes nets that stay Tunnels (globals like
        the instruction word) so stage inference sees the real dependencies;
        clock/reset/enable style nets (fan-out >= GLOBAL_FANOUT of 1-bit inputs)
        are still skipped because they do not define data-flow order.
        Splitter ports are 'inout': a splitter is a pass-through node, so an
        edge is added from every driver on its nets to it and from it to every
        consumer on its nets.
        """
        body_ids = self.body_ids
        out_edges = defaultdict(set)
        for key, cls in self.classes.items():
            if cls == "constant":
                continue
            if not all_nets and cls != "wire":
                continue
            ports = [(cid, idx) for cid, idx in self.nets[key] if cid in body_ids]
            if len(ports) < 2:
                continue
            width = self.bits_of[key][-1]["bit"] + 1 if self.bits_of.get(key) else 1
            if cls == "global" and width == 1:
                continue
            srcs = [cid for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") == "output"]
            dsts = [cid for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") == "input"]
            pass_through = [cid for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") not in ("output", "input")]
            for s_ in srcs:
                for d in dsts + pass_through:
                    if s_ != d:
                        out_edges[s_].add(d)
            for p in pass_through:
                for d in dsts:
                    if p != d:
                        out_edges[p].add(d)
        return out_edges

    def _layers(self):
        """Signal-flow layering.

        Longest path from sources over the body graph (all nets, splitters as
        pass-through, back-edges cut by DFS) gives every part a depth.
        Registers are stage boundaries: stage(r) = longest register-to-register
        path; when registers carry stage prefixes (EX.*, MEM.*) the groups are
        ordered by median depth so bypass/feedback paths do not spread one
        stage over many columns. Layers:
            pre-register logic .......... its depth (0..K)
            register of stage s ......... K+1 + 2s
            logic driven by stage s ..... K+1 + 2s + 1
        Pure combinational circuits have no registers, so layer == depth.
        Text has no ports and is not layered (see _place).
        """
        out_edges = self._graph(all_nets=True)
        # A Constant whose only net is localised (a private copy lands on every
        # consumer port, see _route) has no place in the flow; it goes to the
        # footer with the loose Text instead of opening a column of its own.
        self.loose_constants = {cid for cid, c in self.constants.items()
                                if all(self.classes.get(self._net_key(e)) == "constant" for e in c["ends"] if e.get("netBits"))}
        ids = [c["componentId"] for c in self.body if c["factoryName"] != "Text" and c["componentId"] not in self.loose_constants]
        # Clocked state elements are stage boundaries. ROM/RAM read
        # asynchronously (address in, data out in the same cycle), so they are
        # combinational lookups inside a stage, not boundaries.
        storage = {cid for cid in ids if self._is_storage(cid)}
        prefix_of = {}
        for r in storage:
            pfx = self._stage_prefix(r)
            if pfx:
                prefix_of[r] = pfx
        indeg = {u: 0 for u in ids}
        for u, vs in out_edges.items():
            for v in vs:
                if v in indeg:
                    indeg[v] += 1
        # DFS from sources (registers first so feedback into them is the cut edge)
        state, order, forward = {}, [], defaultdict(set)
        def dfs(u):
            state[u] = 1
            for v in sorted(out_edges.get(u, ())):
                if v not in indeg or state.get(v) == 1:
                    continue
                forward[u].add(v)
                if v not in state:
                    dfs(v)
            state[u] = 2
            order.append(u)
        # Registers first, and among them the earliest pipeline stage first
        # (IF before ID before EX ...), so that the cycle IF -> ... -> WB -> IF
        # is cut on the write-back edge and not wherever component ids happen
        # to start the walk.
        canon = {name: i for i, name in enumerate(PIPELINE_STAGES)}
        def root_key(u):
            pfx = self._stage_prefix(u) if u in storage else None
            return (u not in storage, canon.get(pfx, len(canon)), indeg[u], u)
        roots = sorted(ids, key=root_key)
        for u in roots:
            if u not in state:
                dfs(u)
        depth = {u: 0 for u in ids}
        for u in reversed(order):
            for v in forward.get(u, ()):
                depth[v] = max(depth[v], depth[u] + 1)
        if len(set(prefix_of.values())) < 2:
            # No stage annotation (a single-cycle CPU, a counter, a datapath of
            # plain Registers): registers are ordinary nodes of the flow and
            # stand where their producers and consumers are -- chaining them as
            # register-to-register "stages" strings a single-cycle CPU's PC,
            # interrupt and status registers into a column each (15 columns for
            # 141 parts where the author used 6). The DFS above still cut the
            # cycles at registers, so write-back paths run right to left and
            # keep their labels (see _demote).
            self.stage_of = {}
            self._balance(depth, forward)
            return self._compact(depth)
        # register stages: longest register->register path over the cut DAG
        reach = defaultdict(set)
        for r in storage:
            seen, stack = set(), list(forward.get(r, ()))
            while stack:
                v = stack.pop()
                if v in seen:
                    continue
                seen.add(v)
                if v in storage:
                    reach[r].add(v)
                else:
                    stack.extend(forward.get(v, ()))
        stage = {r: 0 for r in storage}
        for u in reversed(order):
            if u in storage:
                for v in reach.get(u, ()):
                    stage[v] = max(stage[v], stage[u] + 1)
        if len(set(prefix_of.values())) >= 2:
            groups = defaultdict(list)
            for r, pfx in prefix_of.items():
                groups[pfx].append(stage[r])
            # Classic pipeline stage names order themselves (the write-back
            # edges into ID would otherwise put ID after WB); other prefixes by
            # median depth.
            canon = {name: i for i, name in enumerate(PIPELINE_STAGES)}
            if all(p_ in canon for p_ in groups):
                ordered = sorted(groups, key=lambda p_: canon[p_])
            else:
                ordered = sorted(groups, key=lambda p_: sorted(groups[p_])[len(groups[p_]) // 2])
            rank = {p_: i for i, p_ in enumerate(ordered)}
            medians = [sorted(groups[p_])[len(groups[p_]) // 2] for p_ in ordered]
            for r in storage:
                stage[r] = rank[prefix_of[r]] if r in prefix_of else sum(1 for m in medians if m < stage[r])
        # Every combinational node belongs to the earliest register stage that
        # drives it; inside the stage it keeps its longest-path depth from that
        # stage's registers (a single-cycle datapath is one stage with a deep
        # combinational chain: ROM -> splitter -> regfile -> ALU -> mux, and it
        # must not collapse into one column). Stage s occupies
        #     K+1+base(s) ................ its registers
        #     K+1+base(s)+d, d>=1 ........ logic at depth d
        # with base(s+1) = base(s) + max depth of stage s + 1.
        preds = defaultdict(set)
        for u, vs in forward.items():
            for v in vs:
                preds[v].add(u)
        stage_of, local_depth = {}, {}
        for u in reversed(order):
            if u in storage:
                stage_of[u], local_depth[u] = stage[u], 0
                continue
            staged = [p for p in preds[u] if p in stage_of]
            if not staged:
                continue
            s_ = min(stage_of[p] for p in staged)
            stage_of[u] = s_
            d = 1
            for p in staged:
                if stage_of[p] == s_:
                    d = max(d, local_depth[p] + 1 if p not in storage else 1)
            local_depth[u] = d
        pre = [u for u in ids if u not in stage_of]
        K = max((depth[u] for u in pre), default=-1)
        base, offset = {}, 0
        for s_ in sorted(set(stage_of.values())):
            base[s_] = offset
            offset += max((local_depth[u] for u in ids if stage_of.get(u) == s_), default=0) + 1
        layer = {}
        for u in ids:
            if u in stage_of:
                layer[u] = K + 1 + base[stage_of[u]] + local_depth[u]
            else:
                layer[u] = depth[u]
        self.stage_of = stage
        return self._compact(layer)

    def _balance(self, depth, forward):
        """Longest-path depth puts every part as far left as its inputs allow:
        a source, or a part fed only by sources, lands in the first columns
        however far away its consumers are (an immediate extender next to the
        instruction splitter, its mux eight columns on). Right to left, a part
        moves up to just before its nearest consumer when that makes its wires
        shorter in total: it has more consumers than producers, or it is a
        one-in, one-out link of a chain that starts at a part free to follow
        (the chain ends up beside the part it feeds). With self.balance
        "even", every part with at least as many consumers as producers moves
        too: no wire gets longer in total, and the rest of the drawing
        decides whether that helps (see _arrange). Input Pins stay where a reader
        looks for them. Only for circuits without pipeline stages (whose
        columns are the stages)."""
        preds = defaultdict(set)
        for u, vs in forward.items():
            for v in vs:
                if v in depth and u in depth:
                    preds[v].add(u)

        def consumers(u):
            return [v for v in forward.get(u, ()) if v in depth]

        def shortens(u):
            if len(consumers(u)) > len(preds[u]):
                return True
            if len(consumers(u)) != 1 or len(preds[u]) != 1:
                return False
            # one wire in, one out: moving is worth it only when the chain
            # feeding u starts at a part that can follow it
            p, seen = u, {u}
            while preds[p]:
                (q,) = preds[p]
                if q in seen or len(consumers(q)) != 1 or len(preds[q]) > 1 or self.by_id[q]["factoryName"] == "Pin":
                    return False
                seen.add(q)
                p = q
            return True

        for _round in range(len(depth)):
            changed = False
            for u in sorted(depth, key=lambda u: -depth[u]):
                succ = consumers(u)
                if not succ or self.by_id[u]["factoryName"] == "Pin":
                    continue
                hi = min(depth[v] for v in succ) - 1
                if hi <= depth[u]:
                    continue
                if shortens(u):
                    depth[u] = hi
                    changed = True
                elif self.balance == "even" and len(succ) >= len(preds[u]):
                    depth[u] = hi
                    changed = True
                    self.even_moves += 1
            if not changed:
                break

    @staticmethod
    def _compact(layer):
        """Renumber the layers densely. Every depth keeps a column of its own:
        a part merged into the layer before it stood above or below the
        parts that feed it, their wire going round it (a register file under
        the Pins it reads), and a stage boundary with one part lost its
        column. _pack_columns still shares columns where the budget allows,
        staggering each depth to the right so wires run left to right."""
        dense = {l: i for i, l in enumerate(sorted(set(layer.values())))}
        return {cid: dense[l] for cid, l in layer.items()}

    def _pack_columns(self, layer):
        """Min-width layering. Consecutive combinational layers share one
        column while their stacked height stays under a budget, each part
        staggered right by its depth inside the column so wires still run
        left to right; a register layer is always a column of its own (the
        stage boundary a reader looks for). The budget follows the size of
        the circuit: with H the total stacked height of all layers and P the
        column pitch, packing into columns of height B gives a sheet about
        (H/B)*P wide and B tall, so B = sqrt(H*P/TARGET_ASPECT) lands near the
        aspect people draw (1.5). A 10-part adder then keeps one layer per
        column with real channels between them instead of one staggered
        column its wires have to thread through; a 370-part CPU packs its
        thin layers into ~2000 px columns as before. The tallest register
        column is a floor (it cannot be split), MAX_STACK the ceiling;
        self.column_height overrides. Returns (column of part, x offset)."""
        # A very wide, flat part (a hazard/bubble unit drawn as a 1800 x 40
        # subcircuit with all its pins on one long edge) cannot stand in a
        # column: it goes on a shelf across the top of the body instead.
        self.shelf = [cid for cid in layer
                      if self.by_id[cid]["bounds"]["width"] >= SHELF_WIDTH and self.by_id[cid]["bounds"]["height"] * 4 <= self.by_id[cid]["bounds"]["width"]]
        layer = {cid: l for cid, l in layer.items() if cid not in self.shelf}
        by_layer = defaultdict(list)
        for cid, l in layer.items():
            by_layer[l].append(cid)
        storage = {cid for cid in layer if self._is_storage(cid)}
        def stack_height(ids):
            return sum(self.by_id[cid]["bounds"]["height"] + self.row_gap for cid in ids)
        tallest_register = max((stack_height([cid for cid in ids if cid in storage]) for ids in by_layer.values()), default=0)
        if self.column_height is not None:
            budget = max(self.column_height, tallest_register)
        else:
            total = sum(stack_height(ids) for ids in by_layer.values())
            widths_all = sorted(self.by_id[cid]["bounds"]["width"] for cid in layer) or [40]
            pitch = widths_all[len(widths_all) // 2] + self.channel_min + 2 * self.stagger
            auto = math.sqrt(total * pitch / TARGET_ASPECT)
            budget = max(tallest_register, min(MAX_STACK, max(COLUMN_HEIGHT_MIN, auto)))
        self.report["columnBudget"] = int(budget)
        column, offset, col, members, depth = {}, {}, -1, [], 0
        widths = []
        for l in sorted(by_layer):
            ids = by_layer[l]
            if stack_height(ids) > budget * LAYER_SPLIT and not any(cid in self.pin_rank for cid in ids):
                # Parts of one depth do not feed each other, so a layer of many
                # (six processor instances side by side on a test sheet) need
                # not be one column 20 times taller than wide: it becomes
                # columns of the budget's height, filled in the author's
                # top-to-bottom order. Pins whose order is the instance's port
                # order stay one column (side by side they would interleave).
                chunk = []
                pins = [cid for cid in ids if self.by_id[cid]["factoryName"] == "Pin"]
                if pins:
                    # the Pins of the layer stay one column: fanned out to
                    # several, their wires cross each other on the way
                    col += 1
                    widths.append(max(self.by_id[c]["bounds"]["width"] for c in pins))
                    for c in pins:
                        column[c], offset[c] = col, 0
                for cid in sorted((c for c in ids if c not in pins), key=lambda c: (self.by_id[c]["location"]["y"], self.by_id[c]["location"]["x"])) + [None]:
                    if chunk and (cid is None or stack_height(chunk + [cid]) > budget):
                        col += 1
                        widths.append(max(self.by_id[c]["bounds"]["width"] for c in chunk))
                        for c in chunk:
                            column[c], offset[c] = col, 0
                        chunk = []
                    if cid is not None:
                        chunk.append(cid)
                members = list(ids)
                continue
            is_reg = any(cid in storage for cid in ids)
            if col < 0 or is_reg or any(cid in storage for cid in members) or stack_height(members + ids) > budget:
                col += 1
                members, depth, x = [], 0, 0
                widths.append(0)
            else:
                depth += 1
                x = widths[col] + self.stagger
            for cid in ids:
                column[cid] = col
                offset[cid] = x
            widths[col] = max(widths[col], x + max(self.by_id[cid]["bounds"]["width"] for cid in ids))
            members = members + ids
        return column, offset

    def _demote(self, depth_layer, column, x_offset):
        """Nets that stay Tunnels although both ends are in the body.

        Hand-drawn HUST CPUs (233 circuits, 23.7k nets) switch from wire to
        tunnel by distance: a net whose consumer sits 600 px or more from its
        driver is tunnelled in more than two thirds of them, one under 200 px
        almost never; fan-out lowers the distance (a control signal with three
        consumers is tunnelled from ~300 px). A named net that runs backwards
        (consumer left of its driver: write-back, branch target, feedback)
        keeps its Tunnels regardless. An unnamed net has no label to read, so
        it stays a wire unless it would cross half the sheet. Distances are
        estimated from the column packing before routing (channels at their
        upper bound), so the rule is deterministic and needs no iteration."""
        by_col = defaultdict(list)
        for cid, col in column.items():
            by_col[col].append(cid)
        widths = {col: max(x_offset[c] + self.by_id[c]["bounds"]["width"] for c in ids) for col, ids in by_col.items()}
        channel = self._channels(column, [self.nets[key] for key, cls in self.classes.items() if cls == "wire"])
        x_of, cursor = {}, 0
        for col in sorted(by_col):
            x_of[col] = cursor
            cursor += widths[col] + channel(col)

        def px(cid, idx):
            c = self.by_id[cid]
            return x_of[column[cid]] + x_offset[cid] + c["ends"][idx]["location"]["x"] - c["bounds"]["x"]

        demoted = 0
        for key, cls in list(self.classes.items()):
            if cls != "wire":
                continue
            ports = [(cid, idx) for cid, idx in self.nets[key] if cid in column]
            if len(ports) < 2:
                continue
            named = bool(self.labels_of_net.get(key))
            drivers = [(cid, idx) for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") == "output"]
            consumers = [(cid, idx) for cid, idx in ports if self.by_id[cid]["ends"][idx].get("direction") == "input"]
            if not drivers or not consumers:
                drivers, consumers = ports[:1], ports[1:]
            backward = min(depth_layer[c] for c, i in consumers) < max(depth_layer[c] for c, i in drivers)
            span = max(px(c, i) - px(d, j) for d, j in drivers for c, i in consumers)
            columns_spanned = max(column[c] for c, i in ports) - min(column[c] for c, i in ports)
            limit = TUNNEL_SPAN[min(len(consumers), max(TUNNEL_SPAN))] * self.tunnel_span_scale * (1 if named else UNNAMED_SPAN_FACTOR)
            if (named and backward) or span > limit or columns_spanned > self.max_layer_span:
                self.classes[key] = "tunnel"
                demoted += 1
        self.report["nets"]["demotedToTunnel"] = demoted

    def _channels(self, column, nets):
        """Width of the routing channel right of each column: channel_min plus
        CHANNEL_PER_WIRE for every wired net that spans it (once per net,
        however many consumers), capped at column_gap. Counting only the nets
        that turn in a channel draws a narrower sheet but crowds the channels
        next to busy columns: more crossings on the course circuits."""
        need = defaultdict(int)
        for ports in nets:
            cols = sorted({column[cid] for cid, idx in ports if cid in column})
            for l in range(cols[0], cols[-1]) if len(cols) >= 2 else ():
                need[l] += 1
        return lambda l: min(self.column_gap, max(self.channel_min, _snap(self.channel_min + CHANNEL_PER_WIRE * need[l])))

    def _footer_slot(self, width, height):
        """Top-left of the next free place in the footer (see _place_once)."""
        f = self.footer
        if f["x"] > 100 and f["x"] + width > f["right"]:
            f["x"], f["y"], f["row"] = 100, _snap(f["y"] + f["row"] + 2 * GRID), 0
        x, y = f["x"], f["y"]
        f["x"] += width + 40
        f["row"] = max(f["row"], height)
        return x, y

    def _pinout_ranks(self, layer, one_layer):
        """Without a custom appearance an instance's ports are this circuit's
        Pins, per facing in the order of their position (interface_signature):
        re-ordering two Pins of one facing swaps two ports in every circuit
        that uses this one. The Pins of one facing keep their order inside a
        layer (_hold_pinout); with one_layer they also share a layer -- the
        first when they only drive (inputs), the last when any is driven
        (outputs, at the right edge as drawn by hand) -- which makes the order
        hold across the sheet (see _place). Returns {cid: (facing, rank)},
        empty for a custom appearance, which fixes its ports itself."""
        if self.circuit.find("appear") is not None:
            return {}
        groups = defaultdict(list)
        for cid in layer:
            if self.by_id[cid]["factoryName"] == "Pin":
                groups[_attr(self.by_id[cid], "facing") or "east"].append(cid)
        ranks = {}
        for facing, cids in groups.items():
            key = _pin_order_key(facing)
            cids.sort(key=lambda cid: key((self.by_id[cid]["location"]["x"], self.by_id[cid]["location"]["y"])))
            driven = any(e.get("direction") == "input" for cid in cids for e in self.by_id[cid]["ends"])
            target = (max if driven else min)(layer[cid] for cid in cids)
            for rank, cid in enumerate(cids):
                if one_layer:
                    layer[cid] = target
                ranks[cid] = (facing, rank)
        return ranks

    def _pinout_kept(self, placement, ranks=None):
        """Do the Pins of every facing still come in their original order?"""
        seen = defaultdict(list)
        for cid, (facing, rank) in (self.pin_rank if ranks is None else ranks).items():
            dx, dy = placement.get(cid, (0, 0))
            loc = self.by_id[cid]["location"]
            seen[facing].append((_pin_order_key(facing)((loc["x"] + dx, loc["y"] + dy)), rank))
        return all([rank for _p, rank in sorted(pins)] == sorted(rank for _p, rank in pins) for pins in seen.values())

    def _hold_pinout(self, ids):
        """Put the Pins of each facing back in their original order in `ids`
        (one layer, top to bottom), in the slots they occupy; other parts keep
        their places."""
        slots = defaultdict(list)
        for i, cid in enumerate(ids):
            if cid in self.pin_rank:
                slots[self.pin_rank[cid][0]].append(i)
        for positions in slots.values():
            for i, cid in zip(positions, sorted((ids[i] for i in positions), key=lambda cid: self.pin_rank[cid][1])):
                ids[i] = cid

    def _place(self):
        """Placement of the fused pieces (see _contact_groups): each is placed
        as one part and all its members move with it, so the ports drawn onto
        each other stay on each other and need no wire."""
        if not self.fused:
            return self._place_pieces()
        own = self.by_id, self.nets, self.body, self.body_ids, self.copies
        self.by_id, self.nets, self.body, self.body_ids, self.copies = self._fused_view()
        try:
            placement = self._place_pieces()
        finally:
            self.by_id, self.nets, self.body, self.body_ids, self.copies = own
        for part, host in self.fused.items():
            dx, dy = self.relocated.get(part, (0, 0))
            placement[part] = (placement[host][0] + dx, placement[host][1] + dy)
            self.layer[part] = self.layer[host]
        if self.relocated and not self._pinout_kept(placement, ranks=self._pinout_ranks({cid: 0 for cid in self.body_ids}, False)):
            # standing below their ports put two Pins of the pinout out of order: without satellites
            self.fused = {part: host for part, host in self.fused.items() if part not in self.relocated}
            self.relocated = {}
            return self._place()
        return placement

    def _place_pieces(self):
        """Placement, keeping the pinout (_pinout_ranks). Output Pins usually
        stand in different columns, next to what drives them; when that puts
        two of one facing out of order, the placement is redone with every
        facing's Pins in one column (costlier: long nets to the right edge
        become Tunnels)."""
        classes = dict(self.classes)
        placement = self._place_once(one_layer=False)
        if not self._pinout_kept(placement):
            self.classes = classes           # _demote re-classifies on each pass
            placement = self._place_once(one_layer=True)
        self.report["pinsOneColumn"] = self._pinout_layers
        return placement

    def _place_once(self, one_layer):
        depth_layer = self._layers()
        self.pin_rank = self._pinout_ranks(depth_layer, one_layer)
        self._pinout_layers = one_layer
        column, x_offset = self._pack_columns(depth_layer)
        self._demote(depth_layer, column, x_offset)
        layer = column                       # shelf parts are not in it (see _pack_columns)
        self.depth_layer = depth_layer
        by_layer = defaultdict(list)
        for cid, l in layer.items():
            by_layer[l].append(cid)
        # Port-level edges of the nets that will be wired: (source port, sink
        # port). A net with several drivers or no driver contributes edges from
        # its first port to the others.
        edges = []
        for key, cls in self.classes.items():
            if cls != "wire":
                continue
            if key in self.copies:
                edges.extend((copy, port) for copy, served in self.copies[key] for port in served
                             if copy[0] in layer and port[0] in layer)
                continue
            ports = [(cid, idx) for cid, idx in self.nets[key] if cid in layer]
            if len(ports) < 2:
                continue
            outs = [p for p in ports if self.by_id[p[0]]["ends"][p[1]].get("direction") == "output"]
            src = (outs or ports)[0]
            for p in ports:
                if p != src:
                    edges.append((src, p))
        touching = defaultdict(list)
        for e in edges:
            for cid, _ in e:
                touching[cid].append(e)

        def port_dy(cid, idx):
            c = self.by_id[cid]
            return c["ends"][idx]["location"]["y"] - c["bounds"]["y"]

        def height(cid):
            return self.by_id[cid]["bounds"]["height"]

        def on_grid(cid, y):
            """The top nearest y at which the part's loc (and so every port) is
            on the grid. A 30 px gate's top is 15 above its loc: snapping the
            top instead would put its ports 5 px off the neighbour ports they
            were placed to meet, and the final rounding would pick a side."""
            below = self.by_id[cid]["location"]["y"] - self.by_id[cid]["bounds"]["y"]
            return _snap(y + below) - below

        # initial order: the author's y (their intent when it exists)
        order = {}
        for l, ids in by_layer.items():
            ids.sort(key=lambda cid: (self.by_id[cid]["location"]["y"], depth_layer[cid], self.by_id[cid]["location"]["x"]))
            self._hold_pinout(ids)
            order[l] = list(ids)
        layers_sorted = sorted(by_layer)
        top_y = {}

        def stack(l, desired=None):
            """Body tops for column l in its current order.

            Compact first (self.row_gap between neighbours), then the whole column
            shifts rigidly by the median offset to where its ports would like
            to be (desired), then parts with the most connections move within
            their slack towards their own desired y. The column may not grow
            beyond compact height * self.stack_slack + self.gap_cap, so one far-away
            neighbour cannot stretch it and columns cannot drift apart."""
            ids = order[l]
            if not ids:
                return {}
            tops, cursor = {}, 0
            for cid in ids:
                tops[cid] = cursor
                cursor += height(cid) + self.row_gap
            compact = cursor - self.row_gap
            wanted = {cid: y for cid, y in (desired or {}).items() if cid in tops and y is not None}
            if not wanted:
                return {cid: on_grid(cid, y) for cid, y in tops.items()}
            offsets = sorted(wanted[cid] - tops[cid] for cid in wanted)
            shift = offsets[len(offsets) // 2]
            tops = {cid: y + shift for cid, y in tops.items()}
            budget = compact * self.stack_slack + self.gap_cap
            lo_frame = min(tops.values())
            hi_frame = lo_frame + budget
            index = {cid: i for i, cid in enumerate(ids)}
            for cid in sorted(wanted, key=lambda c: -len(touching[c])):
                i = index[cid]
                lo = lo_frame if i == 0 else tops[ids[i - 1]] + height(ids[i - 1]) + self.row_gap
                below = sum(height(c) + self.row_gap for c in ids[i + 1:])
                hi = hi_frame - below - height(cid)
                if i + 1 < len(ids):
                    hi = min(hi, tops[ids[i + 1]] - self.row_gap - height(cid))
                if hi < lo:
                    continue
                tops[cid] = min(max(wanted[cid], lo), hi)
            for i in range(1, len(ids)):          # restore order if a clamp broke it
                a, b = ids[i - 1], ids[i]
                tops[b] = max(tops[b], tops[a] + height(a) + self.row_gap)
            return {cid: on_grid(cid, y) for cid, y in tops.items()}

        for l in layers_sorted:
            top_y[l] = stack(l)

        def port_y(cid, idx):
            return top_y[layer[cid]][cid] + port_dy(cid, idx)

        def barycenter(cid, l):
            """Where this part's ports would like to sit: the mean, over its
            wired neighbours in other layers, of (neighbour port y - own port
            offset) so that the two ports line up; nearer layers weigh more."""
            num = den = 0.0
            for (a, ai), (b, bi) in touching[cid]:
                (me, mi), (other, oi) = ((a, ai), (b, bi)) if a == cid else ((b, bi), (a, ai))
                lo = layer[other]
                w = 0.5 if lo == l else 1.0 / abs(lo - l)
                num += w * (port_y(other, oi) - port_dy(me, mi))
                den += w
            return (num / den) if den else None

        for sweep in range(SWEEPS):
            seq = layers_sorted if sweep % 2 == 0 else layers_sorted[::-1]
            for l in seq:
                cur = top_y[l]
                want = {}
                for cid in order[l]:
                    b = barycenter(cid, l)
                    want[cid] = cur[cid] if b is None else b
                order[l].sort(key=lambda cid: (want[cid], cur[cid]))
                self._hold_pinout(order[l])
                top_y[l] = stack(l, want)

        # Transposition: swap neighbours in a layer when the straight-line
        # segments of their nets cross less afterwards (segments are a proxy
        # for the orthogonal routes the router will draw).
        def seg(e):
            (a, ai), (b, bi) = e
            if layer[a] > layer[b]:
                (a, ai), (b, bi) = (b, bi), (a, ai)
            return layer[a], port_y(a, ai), layer[b], port_y(b, bi)

        def crosses(s1, s2):
            l1a, y1a, l1b, y1b = s1
            l2a, y2a, l2b, y2b = s2
            lo, hi = max(l1a, l2a), min(l1b, l2b)
            if lo >= hi:
                return False
            def at(sg, l):
                la, ya, lb, yb = sg
                return ya if lb == la else ya + (yb - ya) * (l - la) / (lb - la)
            return (at(s1, lo) - at(s2, lo)) * (at(s1, hi) - at(s2, hi)) < 0

        def local_crossings(cids):
            mine = {id(e): e for cid in cids for e in touching[cid]}
            own = [seg(e) for e in mine.values()]
            n = 0
            for e in edges:
                if id(e) in mine:
                    continue
                s2 = seg(e)
                n += sum(1 for s1 in own if crosses(s1, s2))
            n += sum(1 for i in range(len(own)) for j in range(i + 1, len(own)) if crosses(own[i], own[j]))
            return n

        def realign(l):
            want = {}
            for cid in order[l]:
                b = barycenter(cid, l) if touching[cid] else None
                want[cid] = top_y[l][cid] if b is None else b
            top_y[l] = stack(l, want)

        for _round in range(TRANSPOSE_ROUNDS):
            improved = False
            for l in layers_sorted:
                ids = order[l]
                for i in range(len(ids) - 1):
                    a, b = ids[i], ids[i + 1]
                    if not touching[a] and not touching[b]:
                        continue
                    if a in self.pin_rank and b in self.pin_rank and self.pin_rank[a][0] == self.pin_rank[b][0]:
                        continue            # two Pins of one facing: their order is the pinout
                    before = local_crossings((a, b))
                    saved = top_y[l]
                    ids[i], ids[i + 1] = b, a
                    realign(l)
                    if local_crossings((a, b)) < before:
                        improved = True
                    else:
                        ids[i], ids[i + 1] = a, b
                        top_y[l] = saved
            if not improved:
                break
        # final coordinates follow the neighbours once more (ports line up)
        for l in layers_sorted:
            realign(l)

        def side(cid, idx):
            b, e = self.by_id[cid]["bounds"], self.by_id[cid]["ends"][idx]["location"]
            d = {"west": e["x"] - b["x"], "east": b["x"] + b["width"] - e["x"], "north": e["y"] - b["y"], "south": b["y"] + b["height"] - e["y"]}
            return min(d, key=d.get)

        def align_blocks():
            """Straight wires between neighbouring columns. The barycenter puts
            a part where its ports meet its neighbours' on average, which
            levels almost none of them: each part is aligned instead with one
            part in the column to its left (an output on that part's right
            edge wired to an input on its own left edge, the one nearest to
            where it stands), without two alignments crossing. Aligned parts
            form a block that moves as one; blocks keep their order and gaps
            in every column and stay as near as they can to where the
            barycenter put their parts."""
            pos = {cid: i for l in layers_sorted for i, cid in enumerate(order[l])}
            root, off = {}, {}
            for l in layers_sorted:
                for cid in order[l]:
                    root[cid], off[cid] = cid, 0
            taken = set()
            aligned = 0
            for li in range(1, len(layers_sorted)):
                l, left = layers_sorted[li], layers_sorted[li - 1]
                if left != l - 1:
                    continue
                last = -1
                for v in order[l]:
                    if v in self.pin_rank:
                        continue
                    options = []
                    for (a, ai), (b, bi) in touching[v]:
                        (me, mi), (u, ui) = ((a, ai), (b, bi)) if a == v else ((b, bi), (a, ai))
                        if u == v or layer.get(u) != left or u in taken or u in self.pin_rank or pos[u] <= last:
                            continue
                        if side(u, ui) != "east" or side(v, mi) != "west":
                            continue
                        want = top_y[left][u] + port_dy(u, ui) - port_dy(v, mi)
                        if abs(want - top_y[l][v]) <= LEVEL_REACH:
                            options.append((abs(want - top_y[l][v]), pos[u], u, ui, mi))
                    if not options:
                        continue
                    _, _, u, ui, mi = min(options)
                    root[v] = root[u]
                    off[v] = off[u] + port_dy(u, ui) - port_dy(v, mi)
                    taken.add(u)
                    last = pos[u]
                    aligned += 1
            members = defaultdict(list)
            for cid, r in root.items():
                members[r].append(cid)
            # separation constraints between blocks, from every column's order
            after = defaultdict(list)
            indeg = defaultdict(int)
            for l in layers_sorted:
                ids = order[l]
                for a, b in zip(ids, ids[1:]):
                    ra, rb = root[a], root[b]
                    after[ra].append((rb, off[a] + height(a) + self.row_gap - off[b]))
                    indeg[rb] += 1
            want = {}
            for r, ms in members.items():
                ys = sorted(top_y[layer[m]][m] - off[m] for m in ms)
                want[r] = on_grid(r, ys[len(ys) // 2])
            before = defaultdict(list)
            for ra, succ in after.items():
                for rb, sep in succ:
                    before[rb].append((ra, sep))
            topo, queue = [], [r for r in members if not indeg[r]]
            while queue:
                r = queue.pop()
                topo.append(r)
                for rb, sep in after[r]:
                    indeg[rb] -= 1
                    if not indeg[rb]:
                        queue.append(rb)
            if len(topo) < len(members):
                return 0                    # a cycle (cannot happen with crossing-free alignments): keep the barycenter
            # Each block as near its wish as the blocks above it allow (pushing
            # down), and as the blocks below allow (pushing up); both satisfy
            # every gap, so their mean does too and splits the displacement.
            down, up = {}, {}
            for r in topo:
                down[r] = max([want[r]] + [down[ra] + sep for ra, sep in before[r]])
            for r in reversed(topo):
                up[r] = min([want[r]] + [up[rb] - sep for rb, sep in after[r]])
            y = {}
            for r in topo:
                # on the grid; the rounding may take at most one step off a gap
                y[r] = on_grid(r, (down[r] + up[r]) / 2)
                for ra, sep in before[r]:
                    while y[r] < y[ra] + sep - GRID:
                        y[r] += GRID
            for l in layers_sorted:
                for cid in order[l]:
                    top_y[l][cid] = y[root[cid]] + off[cid]
            return aligned

        self.report["alignedPairs"] = align_blocks()

        def straight(cid, top):
            """Wires of this part that are one horizontal segment with it at top."""
            n = 0
            for (a, ai), (b, bi) in touching[cid]:
                (me, mi), (other, oi) = ((a, ai), (b, bi)) if a == cid else ((b, bi), (a, ai))
                if other != cid and layer[other] != layer[cid] and top + port_dy(me, mi) == port_y(other, oi):
                    n += 1
            return n

        def share_rows():
            """Rows across columns. The barycenter puts a part where its ports
            meet its neighbours' on average, which leaves most tops 5-10 px from
            the top of a part in the next column; hand-drawn sheets put about
            three parts in four on a top shared with another. Each part may move
            inside the free space of its column onto another part's top (up to
            ROW_SNAP away) or onto the height where one of its ports meets the
            port it is wired to (up to LEVEL_REACH away), keeping every such
            straight wire it has; among the choices with the most straight
            wires, the one that lets more parts share a top, then the nearest."""
            count = defaultdict(int)
            for l in layers_sorted:
                for cid in order[l]:
                    count[top_y[l][cid]] += 1
            def sharing(n):
                return n if n >= 2 else 0
            ranked = defaultdict(list)          # facing -> Pins in pinout order
            for cid, (facing, rank) in self.pin_rank.items():
                if cid in layer:
                    ranked[facing].append((rank, cid))
            for pins in ranked.values():
                pins.sort()

            def loc_y(cid):
                return top_y[layer[cid]][cid] + self.by_id[cid]["location"]["y"] - self.by_id[cid]["bounds"]["y"]

            snaps = 0
            for _round in range(3):
                changed = False
                for l in layers_sorted:
                    ids, tops = order[l], top_y[l]
                    for i, cid in enumerate(ids):
                        cur = tops[cid]
                        lo, hi = -math.inf, math.inf
                        if i:
                            lo = tops[ids[i - 1]] + height(ids[i - 1]) + self.row_gap
                        if i + 1 < len(ids):
                            hi = tops[ids[i + 1]] - self.row_gap - height(cid)
                        if cid in self.pin_rank and self.pin_rank[cid][0] in ("east", "west"):
                            # a Pin keeps its place in the pinout: strictly
                            # between the Pins ranked before and after it
                            pins = [c for _r, c in ranked[self.pin_rank[cid][0]]]
                            k = pins.index(cid)
                            below = self.by_id[cid]["location"]["y"] - self.by_id[cid]["bounds"]["y"]
                            if k:
                                lo = max(lo, loc_y(pins[k - 1]) + GRID - below)
                            if k + 1 < len(pins):
                                hi = min(hi, loc_y(pins[k + 1]) - GRID - below)
                        options = {t for t in count if count[t] and max(lo, cur - ROW_SNAP) <= t <= min(hi, cur + ROW_SNAP)}
                        for (a, ai), (b, bi) in touching[cid]:
                            (me, mi), (other, oi) = ((a, ai), (b, bi)) if a == cid else ((b, bi), (a, ai))
                            if other != cid and layer[other] != l:
                                t = port_y(other, oi) - port_dy(me, mi)
                                if max(lo, cur - LEVEL_REACH) <= t <= min(hi, cur + LEVEL_REACH):
                                    options.add(t)
                        best, best_key = cur, (straight(cid, cur), 0, 0)
                        for t in options:
                            if t == cur or on_grid(cid, t) != t:
                                continue
                            gain = (sharing(count[cur] - 1) + sharing(count[t] + 1)) - (sharing(count[cur]) + sharing(count[t]))
                            k = (straight(cid, t), gain, -abs(t - cur))
                            if k > best_key:
                                best, best_key = t, k
                        if best != cur:
                            count[cur] -= 1
                            count[best] += 1
                            tops[cid] = best
                            snaps += 1
                            changed = True
                if not changed:
                    break
            return snaps

        self.report["rowSnaps"] = share_rows()

        def label_reach(cid):
            """How far the part's label reaches past its box, left and right."""
            label = _attr(self.by_id[cid], "label")
            if not label:
                return 0, 0
            w, where = _text_width(label), _attr(self.by_id[cid], "labelloc") or "west"
            if where in ("west", "east"):
                return (w, 0) if where == "west" else (0, w)
            over = max(0, (w - self.by_id[cid]["bounds"]["width"]) / 2)
            return over, over

        def pinout_holds():
            ranked = defaultdict(list)
            for cid, (facing, rank) in self.pin_rank.items():
                if cid in layer:
                    loc = self.by_id[cid]["location"]
                    y = top_y[layer[cid]][cid] + loc["y"] - self.by_id[cid]["bounds"]["y"]
                    ranked[facing].append(((y, loc["x"]) if facing in ("east", "west") else (loc["x"], y), rank))
            return all([r for _k, r in sorted(pins)] == sorted(r for _k, r in pins) for pins in ranked.values())

        def fan_pins():
            """Pins wired one to one to ports on the facing edge of the next
            column stand level with those ports. A tall part's ports are 20 px
            apart and a column of Pins needs 70, so otherwise all but a few of
            those wires jog; Pins that would touch stand abreast instead, the
            farther one's wire passing between the nearer ones -- how people
            draw the control lines out of a decoder. Ports 10 px apart leave no
            room to pass between Pins: the Pins then stand in a staircase, each
            wire running along the edge of the Pin before it, as people draw
            the outputs of a subcircuit (those wires are laid before routing,
            see _route). Only where nothing else in the column is in the way and
            the pinout keeps its order. Returns {pin: x offset inside its
            column}; self.fan_wires holds {pin port: driver port}."""
            fan_dx = {}
            self.fan_wires = {}
            for li, l in enumerate(layers_sorted):
                for edge, ni in (("east", li + 1), ("west", li - 1)):
                    if not 0 <= ni < len(layers_sorted):
                        continue
                    pins = []
                    for cid in order[l]:
                        if self.by_id[cid]["factoryName"] != "Pin" or len(touching[cid]) != 1 or cid in fan_dx:
                            continue
                        (a, ai), (b, bi) = touching[cid][0]
                        (me, mi), (u, ui) = ((a, ai), (b, bi)) if a == cid else ((b, bi), (a, ai))
                        if layer.get(u) == layers_sorted[ni] and side(cid, mi) == edge and side(u, ui) == _OPPOSITE[edge]:
                            pins.append((port_y(u, ui) - port_dy(cid, mi), cid, port_y(u, ui)))
                    if len(pins) < 2 or all(top_y[l][cid] == t for t, cid, _w in pins):
                        continue
                    placed, lane = [], {}
                    for t, cid, wire in sorted(pins):
                        top, bottom = t, t + height(cid)
                        for j in range(FAN_COLUMNS):
                            if any(pj == j and top < pb + GRID and pt < bottom + GRID for pj, pt, pb, _w in placed):
                                continue            # touches the Pin before it in that column
                            if any(pj < j and pt - GRID < wire < pb + GRID for pj, pt, pb, _w in placed):
                                continue            # its wire would run through a nearer Pin
                            if any(pj > j and top - GRID < pw < bottom + GRID for pj, pt, pb, pw in placed):
                                continue            # a farther Pin's wire would run through it
                            break
                        else:
                            break
                        lane[cid] = j
                        placed.append((j, top, bottom, wire))
                    if len(lane) < len(pins):
                        # the staircase: the top Pin nearest, each next one a step further out
                        wires_y = sorted(w for _t, _c, w in pins)
                        if any(b - a < GRID for a, b in zip(wires_y, wires_y[1:])):
                            continue
                        ranked = sorted(pins)
                        lane = {cid: j for j, (_t, cid, _w) in enumerate(ranked)}
                        placed = [(j, t, t + height(cid), w) for j, (t, cid, w) in enumerate(ranked)]
                        staircase = True
                    else:
                        staircase = False
                    lo = min(pt for _j, pt, _pb, _w in placed) - self.row_gap
                    hi = max(pb for _j, _pt, pb, _w in placed) + self.row_gap
                    if any(lo < top_y[l][c] + height(c) and top_y[l][c] < hi for c in order[l] if c not in lane):
                        continue                    # another part of the column is in the way
                    saved = dict(top_y[l])
                    for t, cid, _w in pins:
                        top_y[l][cid] = t
                    if not pinout_holds():
                        top_y[l] = saved
                        continue
                    def room(left, right):
                        """x from the left Pin's box to the right one's, labels clear."""
                        return GRID * math.ceil((self.by_id[left]["bounds"]["width"] + label_reach(left)[1] + label_reach(right)[0] + 2 * GRID) / GRID)

                    if staircase:
                        # each Pin one step further out than the one above it
                        x, xs = 0, {}
                        ranked = [cid for _t, cid, _w in sorted(pins)]
                        for k, cid in enumerate(ranked):
                            if k:
                                x += room(ranked[k - 1], cid) if edge == "west" else -room(cid, ranked[k - 1])
                            xs[cid] = x
                        for cid, x in xs.items():
                            fan_dx[cid] = x - min(xs.values())
                    else:
                        lanes = max(lane.values()) + 1
                        step = max(room(a, b) for a in lane for b in lane)
                        for cid, j in lane.items():
                            fan_dx[cid] = (lanes - 1 - j) * step if edge == "east" else j * step
                    for _t, cid, _w in pins:
                        (a, ai), (b, bi) = touching[cid][0]
                        self.fan_wires[(a, ai) if a == cid else (b, bi)] = (b, bi) if a == cid else (a, ai)
                    order[l].sort(key=lambda c: top_y[l][c])
            return fan_dx

        self.fan_wires = {}
        fan_dx = fan_pins()
        self.report["fannedPins"] = len(fan_dx)
        segs = [seg(e) for e in edges]
        self.report["placementCrossings"] = sum(1 for i in range(len(segs)) for j in range(i + 1, len(segs)) if crosses(segs[i], segs[j]))
        # Channel widths: a channel between two columns is as wide as the wires
        # that run through it need (every wired net spanning it), never wider
        # than the caller's column gap (_channels).
        channel = self._channels(layer, [self.nets[key] for key, cls in self.classes.items() if cls == "wire"])

        # coordinate assignment: sub-columns of bounded height per layer
        panel_bottom = max((c["bounds"]["y"] + c["bounds"]["height"] for c in self.components if self._is_panel(c)), default=0)
        top = _snap(panel_bottom + 120)
        # Keep the author's panel/body split when the body already starts just
        # below the panel (course files: panel y<600, body from ~630); anything
        # judging "the panel region" by that line then still sees the same body.
        body_top = min((self.by_id[cid]["bounds"]["y"] for cid in layer), default=None)
        if body_top is not None and self.panel_below_y is not None and panel_bottom + 60 <= body_top <= panel_bottom + 300:
            top = _snap(body_top)
        shelf_y = top
        if self.shelf:
            shelf_h = max(self.by_id[cid]["bounds"]["height"] for cid in self.shelf)
            top = _snap(shelf_y + shelf_h + SHELF_GAP)
        x_cursor = 100
        placement = {}
        body_bottom = top
        # a whole number of grid steps, so every part keeps its grid phase (on_grid)
        frame = GRID * math.floor(min((y for l in layers_sorted for y in top_y[l].values()), default=0) / GRID)
        for l in layers_sorted:
            ids = order[l]
            columns = [[]]
            for cid in ids:
                if columns[-1] and top_y[l][cid] + height(cid) - top_y[l][columns[-1][0]] > MAX_STACK:
                    columns.append([])
                columns[-1].append(cid)
            for k, column in enumerate(columns):
                width = max(x_offset[cid] + fan_dx.get(cid, 0) + self.by_id[cid]["bounds"]["width"] for cid in column)
                for cid in column:
                    c = self.by_id[cid]
                    b = c["bounds"]
                    y = top + top_y[l][cid] - frame
                    # the body's left edge sits on x_cursor (+ its depth stagger);
                    # the component's own loc stays on the 10-grid
                    dx = _snap(x_cursor + x_offset[cid] + fan_dx.get(cid, 0) - b["x"])
                    dy = _snap(y - b["y"])
                    placement[cid] = (dx, dy)
                    body_bottom = max(body_bottom, _snap(y + b["height"] + self.row_gap))
                x_cursor += width + (SUBCOLUMN_GAP if k + 1 < len(columns) else channel(l))
        shelf_x = 100
        for cid in sorted(self.shelf, key=lambda c: self.by_id[c]["bounds"]["x"]):
            b = self.by_id[cid]["bounds"]
            placement[cid] = (_snap(shelf_x - b["x"]), _snap(shelf_y - b["y"]))
            layer[cid] = -1
            shelf_x += b["width"] + 60
        # Text annotations have no ports. One that sits next to a body part is
        # its caption and moves with it; the rest are collected in a footer
        # row below the body instead of being deleted or left over the new body.
        def gap(a, b):
            dx = max(0, max(a["x"], b["x"]) - min(a["x"] + a["width"], b["x"] + b["width"]))
            dy = max(0, max(a["y"], b["y"]) - min(a["y"] + a["height"], b["y"] + b["height"]))
            return dx + dy
        # The footer wraps at the body's right edge: a row of 30 loose
        # Constants must not make the sheet twice as wide as the drawing.
        right = max((self.by_id[cid]["bounds"]["x"] + dx + self.by_id[cid]["bounds"]["width"] for cid, (dx, dy) in placement.items()), default=0)
        self.footer = {"x": 100, "y": _snap(body_bottom + 60), "row": 0, "right": max(right, 800)}
        texts = sorted((c for c in self.body if c["componentId"] not in layer), key=lambda c: (c["bounds"]["x"], c["bounds"]["y"]))
        for t in texts:
            nearest = min(((gap(t["bounds"], self.by_id[cid]["bounds"]), cid) for cid in layer), default=None)
            if t["factoryName"] == "Text" and nearest is not None and nearest[0] <= TEXT_ATTACH_DISTANCE:
                placement[t["componentId"]] = placement[nearest[1]]
            else:
                x, y = self._footer_slot(t["bounds"]["width"], t["bounds"]["height"])
                placement[t["componentId"]] = (_snap(x - t["bounds"]["x"]), _snap(y - t["bounds"]["y"]))
        self.body_bottom = body_bottom
        self.placement = placement
        self.layer = layer
        self.report["moved"] = sum(1 for cid, (dx, dy) in placement.items() if dx or dy)
        return placement

    # ---- routing ---------------------------------------------------------------
    def _moved(self, c):
        dx, dy = self.placement.get(c["componentId"], (0, 0))
        m = copy.deepcopy(c)
        m["location"] = {"x": c["location"]["x"] + dx, "y": c["location"]["y"] + dy}
        m["bounds"] = {**c["bounds"], "x": c["bounds"]["x"] + dx, "y": c["bounds"]["y"] + dy}
        for e in m["ends"]:
            e["location"] = {"x": e["location"]["x"] + dx, "y": e["location"]["y"] + dy}
        return m

    def _port_edge(self, moved_component, idx):
        """The body edge a port sits on (as its outward Tunnel facing and the
        outward grid step), in moved coordinates."""
        end = moved_component["ends"][idx]
        px, py = end["location"]["x"], end["location"]["y"]
        b = moved_component["bounds"]
        d = {"west": px - b["x"], "east": b["x"] + b["width"] - px, "north": py - b["y"], "south": b["y"] + b["height"] - py}
        edge = min(d, key=d.get)
        facing = {"west": "east", "east": "west", "north": "south", "south": "north"}[edge]
        step = {"west": (-GRID, 0), "east": (GRID, 0), "north": (0, -GRID), "south": (0, GRID)}[edge]
        return (px, py), facing, step

    @staticmethod
    def _split_at_endpoints(wires):
        """Split every segment at the interior points where another segment
        ends. Logisim merges two collinear wires that meet at a point where no
        third wire ends, so a '+' made of two branches leaving a trunk from
        opposite sides loses its junction on load; a trunk split there is a
        real 4-way node instead."""
        ends_x, ends_y = defaultdict(set), defaultdict(set)
        for a, b in wires:
            for p in (a, b):
                ends_x[p[0]].add(p[1])
                ends_y[p[1]].add(p[0])
        out = []
        for a, b in wires:
            if a[0] == b[0]:
                lo, hi = sorted((a[1], b[1]))
                cuts = sorted(y for y in ends_x.get(a[0], ()) if lo < y < hi)
                pts = [(a[0], y) for y in (lo, *cuts, hi)]
            else:
                lo, hi = sorted((a[0], b[0]))
                cuts = sorted(x for x in ends_y.get(a[1], ()) if lo < x < hi)
                pts = [(x, a[1]) for x in (lo, *cuts, hi)]
            out.extend(zip(pts, pts[1:]))
        return out

    def _net_key(self, end):
        bits = end.get("netBits") or []
        return _key(bits) if bits else None

    def _route(self):
        moved = {c["componentId"]: self._moved(c) for c in self.components}
        body_ids = self.body_ids
        body_port_points = {(e["location"]["x"], e["location"]["y"]) for c in self.body for e in c["ends"]}
        panel_points = {(e["location"]["x"], e["location"]["y"]) for c in self.components if self._is_panel(c) for e in c["ends"]}
        # Copper that survives: bundles touching the panel and no body port.
        # Everything that touches a moved port is rebuilt (a hand-drawn wire from
        # a panel Pin straight into the body included -- both ends get a Tunnel).
        kept_wires, kept_bundles, kept_points = [], [], set()
        bundle_by_id = {b["bundleId"]: b for b in self.focus.get("wireBundles", [])}
        for b in self.focus.get("wireBundles", []):
            pts = {(p["x"], p["y"]) for p in b.get("points", [])}
            if pts & panel_points and not pts & body_port_points:
                kept_bundles.append(b)
                kept_points |= pts
        kept_ids = {b["bundleId"] for b in kept_bundles}
        for w in self.focus.get("wires", []):
            if w["bundleId"] in kept_ids:
                kept_wires.append(w)
        self.kept_wires = kept_wires
        # Tunnels: panel-side ones (in the panel, or standing on kept copper) stay
        # exactly where they are. Body-side ones of every net that has a body port
        # go: the port moved, and emit() re-anchors the labels on the moved port.
        panel_side = {cid for cid, t in self.tunnels.items()
                      if self._is_panel(t) or (t["location"]["x"], t["location"]["y"]) in kept_points}
        drop_tunnels = set()
        for key, ports in self.nets.items():
            if any(cid in body_ids for cid, idx in ports):
                drop_tunnels.update(cid for cid, idx in ports if cid in self.tunnels and cid not in panel_side)
        self.panel_side_tunnels = panel_side
        # Router view. The observer already merged every tunnel into its net, so
        # all ports of a wired net carry identical netIds; the router would call
        # them "already connected" and route nothing. Give each port a private
        # bus id, and fold those ids back onto the real net in the ownership
        # partition so same-net copper is never treated as foreign.
        partition = Partition()
        for cid, c in moved.items():
            for e in c["ends"]:
                bits = e.get("netBits") or []
                key = _key(bits) if bits else None
                if key is not None and self.classes.get(key) == "wire" and cid in body_ids:
                    fresh = []
                    for b in sorted(bits, key=lambda b: b["bit"]):
                        synthetic = f"{b['netId']}#{cid}:{e['index']}"
                        partition.join(b["netId"], synthetic)
                        fresh.append({"bit": b["bit"], "netId": synthetic})
                    e["netBits"] = fresh
                else:
                    e["netBits"] = [{"bit": i, "netId": f"x:{cid}:{e['index']}:{i}"} for i in range(max(1, e.get("width") or 1))]
        # Localised constants become synthetic components the router knows about:
        # one per consumer port, one grid step outward from the port along the
        # edge normal (further out when that cell is taken), carrying the
        # consumer's net bits so the stub is routed as a normal 2-pin net.
        self.synthetic_constants = []
        self.synthetic_factory = {}
        occupied = [c["bounds"] for cid, c in moved.items() if cid not in self.tunnels and c["factoryName"] not in ("Text", "Tunnel")]

        def collides(rect, skip=None):
            return any(o is not skip and rect["x"] < o["x"] + o["width"] and o["x"] < rect["x"] + rect["width"] and
                       rect["y"] < o["y"] + o["height"] and o["y"] < rect["y"] + rect["height"] for o in occupied)

        def constant_bounds(cx, cy, facing, body):
            # Logisim draws a Constant entirely behind its output port: facing
            # east the body spans [cx-body, cx], facing west [cx, cx+body]; the
            # port is on the body's edge, so the stub cell in front stays free.
            if facing == "east":
                return {"x": cx - body, "y": cy - 8, "width": body, "height": 16}
            if facing == "west":
                return {"x": cx, "y": cy - 8, "width": body, "height": 16}
            if facing == "south":
                return {"x": cx - body // 2, "y": cy - 16, "width": body, "height": 16}
            # north: the observer reports the body hanging below the port
            # (200,500 -> y 500..516), i.e. the label box, not the arrow side.
            return {"x": cx - body // 2, "y": cy, "width": body, "height": 16}

        def stub_bounds(px, py, cx, cy):
            # The straight stub from the port to the Constant, one grid cell thick,
            # excluding the port cell itself (which sits on the consumer's edge).
            x0, x1 = sorted((px, cx)); y0, y1 = sorted((py, cy))
            if x0 == x1:
                return {"x": x0 - 4, "y": (y0 + 1 if py == y0 else y0), "width": 8, "height": max(1, y1 - y0 - 1)}
            return {"x": (x0 + 1 if px == x0 else x0), "y": y0 - 4, "width": max(1, x1 - x0 - 1), "height": 8}

        # Consumer ports that get no local Constant (boxed in, or the stub failed
        # to route) reach the shared Constant through its label instead: emit()
        # puts a labelled Tunnel on the port and on the driver.
        self.failed_constant_consumers = set()
        for key, cls in self.classes.items():
            if cls != "constant":
                continue
            driver = next(cid for cid, idx in self.nets[key] if cid in self.constants)
            drv = self.by_id[driver]
            value = _attr(drv, "value") or "0x0"
            width = drv["ends"][0]["width"] or 1
            factory = drv["factoryName"]
            for cid, idx in self.nets[key]:
                if cid in self.tunnels or cid == driver or cid not in body_ids:
                    continue
                end = moved[cid]["ends"][idx]
                px, py = end["location"]["x"], end["location"]["y"]
                b = moved[cid]["bounds"]
                d = {"west": px - b["x"], "east": b["x"] + b["width"] - px, "north": py - b["y"], "south": b["y"] + b["height"] - py}
                edge = min(d, key=d.get)
                dx, dy, facing = {"west": (-1, 0, "east"), "east": (1, 0, "west"), "north": (0, -1, "south"), "south": (0, 1, "north")}[edge]
                # Native Constant body: 16 px up to 8 bits, then 10 px per further
                # hex digit of the bit width (26 px at 9-12 bits ... 76 px at 29-32),
                # regardless of the value printed (measured with the observer).
                # A Ground or Power symbol is 14-15 px deep whatever its width.
                body_px = 16 + 10 * max(0, (width + 3) // 4 - 2) if factory == "Constant" else 16
                placed = None
                for step in range(1, 16):
                    cx, cy = px + dx * step * GRID, py + dy * step * GRID
                    bounds = constant_bounds(cx, cy, facing, body_px)
                    if not collides(bounds) and not collides(stub_bounds(px, py, cx, cy), skip=b):
                        placed = (cx, cy, bounds)
                        break
                if placed is None:
                    self.failed_constant_consumers.add((cid, idx))
                    continue
                cx, cy, bounds = placed
                sid = f"const:{cid}:{idx}"
                bits = [{"bit": i, "netId": f"{sid}:b{i}"} for i in range(width)]
                consumer_bits = [{"bit": i, "netId": f"{sid}:b{i}#consumer"} for i in range(width)]
                for i in range(width):
                    partition.join(f"{sid}:b{i}", f"{sid}:b{i}#consumer")
                end["netBits"] = consumer_bits
                synthetic = {"componentId": sid, "factoryName": factory, "location": {"x": cx, "y": cy}, "bounds": bounds,
                             "attributes": [], "ends": [{"index": 0, "location": {"x": cx, "y": cy}, "width": width, "direction": "output", "netBits": bits}]}
                moved[sid] = synthetic
                occupied.append(bounds)
                occupied.append(stub_bounds(px, py, cx, cy))
                self.synthetic_constants.append((sid, cx, cy, facing, width, value, (cid, idx)))
                self.synthetic_factory[sid] = factory
        # Which body ports will carry Tunnels (decided before routing where
        # possible, so the router keeps their chain cells free):
        #   tunnel/global nets: every body port, all labels of the net;
        #   wire nets with panel ports: the routing source port (the bridge);
        #   constant nets with panel consumers: the driver's output.
        self.anchors = {}
        self.source_of = {}
        for key, cls in self.classes.items():
            real = [(cid, idx) for cid, idx in self.nets[key] if cid not in self.tunnels]
            body_ports = [(cid, idx) for cid, idx in real if cid in body_ids]
            panel_ports = [(cid, idx) for cid, idx in real if cid not in body_ids]
            if cls in ("tunnel", "global"):
                if body_ports and (len(real) >= 2 or self.labels_of_net.get(key)):
                    labels = self._labels_for(key)
                    for port in body_ports:
                        self.anchors[port] = labels
            elif cls == "wire":
                outputs = [p for p in body_ports if self.by_id[p[0]]["ends"][p[1]].get("direction") == "output"]
                self.source_of[key] = (outputs or body_ports)[0]
                if panel_ports:
                    self.anchors[self.source_of[key]] = self._labels_for(key)
            elif cls == "constant":
                driver = next(cid for cid, idx in self.nets[key] if cid in self.constants)
                if panel_ports:
                    self.anchors[(driver, 0)] = self._labels_for(key)
        focus_components = [c for cid, c in moved.items() if cid not in drop_tunnels]
        jobs = []
        for key, cls in self.classes.items():
            if cls != "wire":
                continue
            ports = [(cid, idx) for cid, idx in self.nets[key] if cid in body_ids]
            if len(ports) < 2:
                continue
            # one tree per Splitter copy (see _splitter_copies), each from its copy
            trees = [(("copy", key, i), [copy] + served) for i, (copy, served) in enumerate(self.copies[key])] if key in self.copies else [(key, ports)]
            for job, ports in trees:
                xs = [moved[cid]["ends"][idx]["location"]["x"] for cid, idx in ports]
                ys = [moved[cid]["ends"][idx]["location"]["y"] for cid, idx in ports]
                jobs.append((len(ports) > 2, (max(xs) - min(xs)) + (max(ys) - min(ys)), job, ports))
        for sid, cx, cy, facing, width, value, (cid, idx) in self.synthetic_constants:
            jobs.append((False, 20, ("const", sid), [(sid, 0), (cid, idx)]))
        jobs.sort(key=lambda j: (j[0], j[1]), reverse=(self.route_order == "long"))

        def route_all(first):
            """Every job on a fresh router, the nets in `first` before the rest."""
            router = Router({"focus": {"components": focus_components, "wires": kept_wires, "wireBundles": kept_bundles}}, partition,
                            crossing_cost=self.crossing_cost, visit_cap=ROUTER_VISIT_CAP, bend_cost=self.bend_cost)
            # A port that gets several labels chains them outward on 10 px stubs
            # (see emit); those cells are copper of that net, so no other route may
            # run through them.
            # Every anchored Tunnel stands one cell off its port on a 10 px lead
            # (as hand-drawn schematics do: 6% of 22.7k corpus tunnels sit on the
            # port itself), further labels chain outward on 10 px stubs (see emit).
            # Those cells are copper of that net; no other route may run through
            # them. They are remembered so emit can tell them from real obstacles.
            reserved = set()
            for (cid, idx), labels in self.anchors.items():
                (px, py), _facing, (sx, sy) = self._port_edge(moved[cid], idx)
                lead = (px + sx, py + sy)
                reserved.add(lead)
                # the lead belongs to the port's net (its own route may still
                # leave through it: a bridge port is both routed and labelled)
                router.port_owners.setdefault(lead, set()).add(router.owner(moved[cid]["ends"][idx].get("netBits") or []))
                for k in range(2, len(labels) + 1):
                    reserved.add((px + sx * k, py + sy * k))
                    router.blocked.add((px + sx * k, py + sy * k))
            # Every other body port keeps the cell in front of it for its own net
            # too. Pins of a tall pipeline register sit 30 px apart on one edge; a
            # neighbour's route that runs vertically along that edge would box in
            # the ports it passes (the router never ends a route on foreign
            # copper), which is how tall registers lost 3-8 nets to "no room".
            # Hand-drawn schematics have the same short lead before any bend or
            # junction. Splitters are excluded: their pins are not on a body edge.
            claims = defaultdict(set)          # lead cell -> nets of the ports it fronts
            for c in focus_components:
                if c["factoryName"] in ("Tunnel", "Text", "Splitter"):
                    continue
                for idx, end in enumerate(c["ends"]):
                    if (c["componentId"], idx) in self.anchors:
                        continue
                    (px, py), _facing, (sx, sy) = self._port_edge(c, idx)
                    claims[(px + sx, py + sy)].add(router.owner(end.get("netBits") or []) or ("lead", c["componentId"], idx))
            for lead, nets in claims.items():
                # two ports of different nets facing each other across one cell:
                # the cell stays free, or neither port could be reached
                if len(nets) == 1 and lead not in router.port_owners and lead not in router.blocked:
                    router.port_owners[lead].add(next(iter(nets)))
            wires, failed_ports, failed_consts, unrouted, failed_jobs = [], defaultdict(list), set(), [], set()
            wire_nets = []                   # the net of every segment in wires
            # A Pin standing level with its port (see fan_pins) gets its straight
            # wire as it is, before anything is routed: in a staircase that wire
            # runs along the edge of the Pin before it, which the router's
            # clearance cost would rather bend around.
            net_of_port = {port: key for key, ports in self.nets.items() for port in ports}
            for pin_port, driver_port in self.fan_wires.items():
                key = net_of_port.get(pin_port)
                if key is None or self.classes.get(key) != "wire" or key in self.copies:
                    continue
                pin_end, driver_end = moved[pin_port[0]]["ends"][pin_port[1]], moved[driver_port[0]]["ends"][driver_port[1]]
                a, b = (driver_end["location"]["x"], driver_end["location"]["y"]), (pin_end["location"]["x"], pin_end["location"]["y"])
                owner = router.owner(driver_end.get("netBits") or [])
                if a[1] != b[1] or a == b or any(q in router.blocked or any(own != owner for own in router.port_owners.get(q, ()))
                                                  or any(s[0] != owner for s in router.at.get(q, ())) for q in Router.grid(a, b)):
                    continue
                router.add(a, b, owner, tuple(bit["netId"] for bit in driver_end.get("netBits") or []))
                router.connected.join(tuple(bit["netId"] for bit in driver_end.get("netBits") or []),
                                      tuple(bit["netId"] for bit in pin_end.get("netBits") or []))
                wires.append((a, b))
                wire_nets.append(key)
            for _, _, key, ports in sorted(jobs, key=lambda j: j[2] not in first):
                if key in self.nets:
                    source_port = self.source_of[key]
                    remaining = [p for p in ports if p != source_port]
                else:
                    source_port, remaining = ports[0], ports[1:]
                source = moved[source_port[0]]["ends"][source_port[1]]
                remaining.sort(key=lambda p: abs(moved[p[0]]["ends"][p[1]]["location"]["x"] - source["location"]["x"]) + abs(moved[p[0]]["ends"][p[1]]["location"]["y"] - source["location"]["y"]))
                net = key[1] if key[0] == "copy" else key
                for port in remaining:
                    target = moved[port[0]]["ends"][port[1]]
                    try:
                        found = router.route(source, target)
                        wires.extend(found)
                        wire_nets.extend([net] * len(found))
                    except ValueError as error:
                        unrouted.append({"label": self.label_of_net.get(net) if net in self.nets else key[1], "ports": len(ports), "reason": str(error)[:120]})
                        failed_jobs.add(key)
                        if net in self.nets:
                            failed_ports[net].append(port)
                        else:
                            # constant stub: this consumer falls back to the shared Constant's label.
                            failed_consts.add(port)
            return router, reserved, wires, failed_ports, failed_consts, unrouted, failed_jobs, wire_nets

        # Ports the router could not reach keep the net by label: emit() puts the
        # net's Tunnel on them and on the routing source, the copper that did
        # route stays. A route that cannot reach its port was usually boxed in
        # by nets routed before it (a jog right in front of a dense port edge
        # such as a multiplexer's inputs 10 px apart); routing the failed nets
        # first frees most of them.
        attempt = route_all(set())
        if attempt[5]:
            retry = route_all(attempt[6])
            if len(retry[5]) < len(attempt[5]):
                attempt = retry
        router, self.reserved, wires, self.failed_ports, failed_consts, unrouted, _failed, wire_nets = attempt
        self.routed = list(zip(wires, wire_nets))
        self.report["unrouted"].extend(unrouted)
        self.failed_constant_consumers |= failed_consts
        for key, ports in self.failed_ports.items():
            labels = self._labels_for(key)
            self.anchors[self.source_of[key]] = labels
            for port in ports:
                self.anchors[port] = labels
        for key, cls in self.classes.items():
            if cls != "constant":
                continue
            failed = [(cid, idx) for cid, idx in self.nets[key] if (cid, idx) in self.failed_constant_consumers]
            if failed:
                labels = self._labels_for(key)
                driver = next(cid for cid, idx in self.nets[key] if cid in self.constants)
                self.anchors[(driver, 0)] = labels
                for port in failed:
                    self.anchors[port] = labels
        wires = self._split_at_endpoints(wires)
        self.wires, self.drop_tunnels, self.moved, self.router = wires, drop_tunnels, moved, router
        self.report["wires"] = len(wires)
        return wires

    # ---- emission --------------------------------------------------------------
    def _drawing_cost(self):
        """What a reader pays for the routed drawing: one crossing, five bends,
        a metre of wire and two Tunnels count about the same."""
        horizontal = [(min(a[0], b[0]), max(a[0], b[0]), a[1]) for a, b in self.wires if a[1] == b[1]]
        vertical = [(min(a[1], b[1]), max(a[1], b[1]), a[0]) for a, b in self.wires if a[0] == b[0]]
        crossings = sum(1 for x1, x2, y in horizontal for y1, y2, x in vertical if x1 < x < x2 and y1 < y < y2)
        axes = defaultdict(set)
        for a, b in self.wires:
            for q in (a, b):
                axes[q].add(a[1] == b[1])
        bends = sum(1 for seen in axes.values() if len(seen) == 2)
        length = sum(abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in self.wires)
        tunnels = sum(len(labels) for labels in self.anchors.values())
        return crossings + bends / 5 + length / 1000 + tunnels / 2

    def _arrange(self):
        """Place and route. Without pipeline stages the columns can be balanced
        two ways (_balance) and neither wins everywhere: on the course circuits
        each draws some CPU with 20-30 crossings fewer than the other. Both are
        drawn and the cheaper drawing is kept (_drawing_cost); when the even
        rule moves nothing more than the chain rule, one drawing is enough."""
        start = dict(self.__dict__)
        best = self._arrange_once(start, dict(start["classes"]))
        # A net whose copper crosses many others is drawn with Tunnels when
        # its label means something to a reader (see _crossing_heavy); the
        # sheet is placed and routed again around what is left, and kept when
        # it reads better. Repeated while it helps: the next heaviest nets
        # show only once the first ones are gone.
        tunnelled = set()
        for _round in range(3):
            self.__dict__.update(best[2])
            heavy = self._crossing_heavy()
            if not heavy:
                break
            classes = dict(start["classes"])
            for key in tunnelled | heavy:
                classes[key] = "tunnel"
            again = self._arrange_once(start, classes)
            if again[0] >= best[0]:
                break
            best, tunnelled = again, tunnelled | heavy
        self.__dict__.update(best[2])
        self.report["tunnelledForCrossings"] = len(tunnelled)

    def _arrange_once(self, start, classes):
        attempts = []
        for balance in ("even", "chains"):
            self.__dict__.update(start)
            self.classes = dict(classes)
            self.report = copy.deepcopy(start["report"])
            self.synthesized, self.used_labels = dict(start["synthesized"]), set(start["used_labels"])
            self.abbr_counter = copy.copy(start["abbr_counter"])
            self.balance, self.even_moves = balance, 0
            self._place()
            self._route()
            attempts.append((self._drawing_cost(), len(attempts), dict(self.__dict__)))
            if not self.even_moves:
                break
        return min(attempts, key=lambda a: a[:2])

    def _crossing_heavy(self):
        """Wired nets whose copper crosses more than CROSSINGS_PER_CONSUMER
        other wires per consumer (and at least CROSSINGS_MIN) and that have a
        name a reader knows (the author's Tunnel label, a labelled Pin or
        part on the net, a clock). Hand-drawn schematics tolerate a few
        crossings per consumer -- nine in ten wired nets stay within two --
        and switch to Tunnels beyond; a net known only by a made-up name
        stays a wire."""
        horizontal = [(min(a[0], b[0]), max(a[0], b[0]), a[1], k) for (a, b), k in self.routed if a[1] == b[1] and a[0] != b[0]]
        vertical = [(min(a[1], b[1]), max(a[1], b[1]), a[0], k) for (a, b), k in self.routed if a[0] == b[0] and a[1] != b[1]]
        count = defaultdict(int)
        for x0, x1, y, k in horizontal:
            for y0, y1, x, j in vertical:
                if k != j and x0 < x < x1 and y0 < y < y1:
                    count[k] += 1
                    count[j] += 1
        heavy = set()
        for key, n in count.items():
            if key not in self.nets or self.classes.get(key) != "wire" or n < CROSSINGS_MIN:
                continue
            ports = [(cid, idx) for cid, idx in self.nets[key] if cid in self.body_ids]
            if n > CROSSINGS_PER_CONSUMER * (len(ports) - 1) and self._nameable(key):
                heavy.add(key)
        return heavy

    def _nameable(self, key):
        """Would this net's Tunnels carry a name a reader knows?"""
        if self.labels_of_net.get(key):
            return True
        return any(_attr(self.by_id[cid], "label") or self.by_id[cid]["factoryName"] == "Clock"
                   for cid, _idx in self.nets[key] if cid not in self.tunnels)

    def emit(self):
        self.plan()
        self._arrange()
        circuit = self.circuit
        moved_pins = {}
        for cid, element in self.element_of.items():
            dx, dy = self.placement.get(cid, (0, 0))
            if dx or dy:
                x, y = _loc(element.get("loc"))
                element.set("loc", f"({x + dx},{y + dy})")
                if element.get("name") == "Pin":
                    moved_pins[(x, y)] = (x + dx, y + dy)
        # A custom appearance names the Pin behind each of its ports by the
        # Pin's location. Left pointing at the old spot, the port is gone: the
        # file no longer loads ("Appearance element circ-port not found"), or
        # the instance loses that connection in every circuit using it. The
        # port stays where it is on the instance; only the reference follows.
        repointed = 0
        appear = circuit.find("appear")
        for port in appear.iter("circ-port") if appear is not None else ():
            try:
                old = tuple(int(v) for v in port.get("pin", "").split(","))
            except ValueError:
                continue
            if old in moved_pins:
                port.set("pin", "%d,%d" % moved_pins[old])
                repointed += 1
        self.report["appearancePortsRepointed"] = repointed
        # Old body wiring goes; panel copper (unchanged coordinates) stays.
        # Logisim normalises wires on load -- collinear pieces that meet are
        # merged, a wire is split where another one ends -- so the observed
        # wires are not always the file's <wire> elements (a 10 px lead drawn
        # onto the end of a longer wire is one observed wire). A file wire
        # stays when it lies on kept copper.
        kept_h, kept_v = defaultdict(list), defaultdict(list)
        for kw in self.kept_wires:
            (ax, ay), (bx, by) = (kw["from"]["x"], kw["from"]["y"]), (kw["to"]["x"], kw["to"]["y"])
            if ay == by:
                kept_h[ay].append((min(ax, bx), max(ax, bx)))
            if ax == bx:
                kept_v[ax].append((min(ay, by), max(ay, by)))

        def on_kept_copper(a, b):
            if a[1] == b[1] and any(lo <= min(a[0], b[0]) and max(a[0], b[0]) <= hi for lo, hi in kept_h.get(a[1], ())):
                return True
            return a[0] == b[0] and any(lo <= min(a[1], b[1]) and max(a[1], b[1]) <= hi for lo, hi in kept_v.get(a[0], ()))

        for w in list(circuit.findall("wire")):
            if not on_kept_copper(_loc(w.get("from")), _loc(w.get("to"))):
                circuit.remove(w)
        for cid in self.drop_tunnels:
            element = self.element_of.get(cid)
            if element is not None and element in list(circuit):
                circuit.remove(element)
        # A body-side Tunnel of a net without body ports (label-only copper) keeps
        # its coordinates unless the new body now sits there; then it goes to the
        # footer rather than onto a foreign port.
        moved_bodies = [self.moved[cid]["bounds"] for cid in self.layer]
        moved_ports = {(e["location"]["x"], e["location"]["y"]) for cid in self.layer for e in self.moved[cid]["ends"]}
        for cid, t in self.tunnels.items():
            if cid in self.drop_tunnels or cid in self.panel_side_tunnels:
                continue
            p = (t["location"]["x"], t["location"]["y"])
            if p in moved_ports or any(b["x"] <= p[0] <= b["x"] + b["width"] and b["y"] <= p[1] <= b["y"] + b["height"] for b in moved_bodies):
                footer_x, footer_y = self._footer_slot(20, 20)
                self.element_of[cid].set("loc", f"({footer_x},{footer_y})")
                self.moved[cid]["location"] = {"x": footer_x, "y": footer_y}
        # Tunnels on moved body ports (see _route: self.anchors) and on panel
        # ports whose copper was rebuilt. The first label sits on the port;
        # further labels chain outward on 10 px stubs (cells the router kept
        # free); if a late anchor finds its chain cell taken, the labels stack
        # on the port instead (distinct labels on one point are all read).
        copper = set()
        for a, b in self.wires:
            copper.update(Router.grid(a, b))
        for kw in self.kept_wires:
            copper.update(Router.grid((kw["from"]["x"], kw["from"]["y"]), (kw["to"]["x"], kw["to"]["y"])))
        placed_tunnels = defaultdict(set)   # net key -> points carrying one of its labels
        reanchored = 0

        def free(q):
            return (q not in copper and (q not in self.router.port_owners or q in self.reserved)
                    and (q not in self.router.blocked or q in self.reserved)
                    and not any(b["x"] <= q[0] <= b["x"] + b["width"] and b["y"] <= q[1] <= b["y"] + b["height"] for b in moved_bodies))

        def anchor_tunnels(cid, idx, labels):
            comp = self.moved[cid]
            (px, py), facing, step = self._port_edge(comp, idx)
            width = comp["ends"][idx].get("width") or 1
            # The first label one cell off the port on a lead (a Tunnel on the
            # port itself is what a reader of hand-drawn work never sees),
            # further labels chained outward; a taken cell ends the chain and
            # the remaining labels stack on the last free point (distinct
            # labels on one point are all read by Logisim).
            chain = []
            for k in range(1, len(labels) + 1):
                q = (px + step[0] * k, py + step[1] * k)
                if not free(q):
                    break
                chain.append(q)
            if not chain:
                chain = [(px, py)]
            chain += [chain[-1]] * (len(labels) - len(chain))
            previous = (px, py)
            for (tx, ty), label in zip(chain, labels):
                el = ET.SubElement(circuit, "comp", {"lib": self.wiring_lib, "name": "Tunnel", "loc": f"({tx},{ty})"})
                ET.SubElement(el, "a", {"name": "facing", "val": facing})
                ET.SubElement(el, "a", {"name": "width", "val": str(width)})
                ET.SubElement(el, "a", {"name": "label", "val": label})
                if (tx, ty) != previous:
                    (ax, ay), (bx, by) = previous, (tx, ty)
                    ET.SubElement(circuit, "wire", {"from": f"({min(ax, bx)},{min(ay, by)})", "to": f"({max(ax, bx)},{max(ay, by)})"})
                    copper.add((tx, ty))
                previous = (tx, ty)
            return len(labels)

        for (cid, idx), labels in self.anchors.items():
            reanchored += anchor_tunnels(cid, idx, labels)
            key = self._net_key(self.by_id[cid]["ends"][idx])
            placed_tunnels[key].add((self.moved[cid]["ends"][idx]["location"]["x"], self.moved[cid]["ends"][idx]["location"]["y"]))
        # Panel side: every panel port of a net that now depends on a label must
        # reach a Tunnel of that net over kept copper (or stand on one).
        joined = _UnionFind()
        for kw in self.kept_wires:
            joined.join((kw["from"]["x"], kw["from"]["y"]), (kw["to"]["x"], kw["to"]["y"]))
        tunnel_roots = defaultdict(set)
        for cid, t in self.tunnels.items():
            if cid in self.drop_tunnels:
                continue
            key = self._net_key(t["ends"][0]) if t["ends"] else None
            if key is not None:
                tunnel_roots[key].add(joined.root((t["location"]["x"], t["location"]["y"])))
        for key in {self._net_key(self.by_id[cid]["ends"][idx]) for (cid, idx) in self.anchors}:
            if key is None:
                continue
            labels = self._labels_for(key)
            for cid, idx in self.nets[key]:
                if cid in self.tunnels or cid in self.body_ids:
                    continue
                p = (self.by_id[cid]["ends"][idx]["location"]["x"], self.by_id[cid]["ends"][idx]["location"]["y"])
                if joined.root(p) in tunnel_roots[key]:
                    continue
                reanchored += anchor_tunnels(cid, idx, labels)
                tunnel_roots[key].add(joined.root(p))
        self.report["tunnelsReanchored"] = reanchored
        self.report["tunnelsRemoved"] = len(self.drop_tunnels)
        self.report["tunnelsKept"] = len(self.tunnels) - len(self.drop_tunnels) + reanchored
        # Localised constants: emit the synthetic components the router placed.
        for sid, cx, cy, facing, width, value, consumer in self.synthetic_constants:
            if consumer in self.failed_constant_consumers:
                continue
            factory = self.synthetic_factory.get(sid, "Constant")
            el = ET.SubElement(circuit, "comp", {"lib": self.wiring_lib, "name": factory, "loc": f"({cx},{cy})"})
            # a Constant faces its consumer; a Ground or Power symbol faces away
            ET.SubElement(el, "a", {"name": "facing", "val": facing if factory == "Constant" else _OPPOSITE[facing]})
            ET.SubElement(el, "a", {"name": "width", "val": str(width)})
            if factory == "Constant":
                ET.SubElement(el, "a", {"name": "value", "val": str(value)})
            self.report["constantsPlaced"] += 1
        # The shared Constant itself stays only while something still reads it
        # by label (panel consumers, consumers without a private Constant).
        for key, cls in self.classes.items():
            if cls != "constant":
                continue
            driver = next(cid for cid, idx in self.nets[key] if cid in self.constants)
            if (driver, 0) not in self.anchors:
                drv_el = self.element_of.get(driver)
                if drv_el is not None and drv_el in list(circuit):
                    circuit.remove(drv_el)
        for a, b in self.wires:
            ET.SubElement(circuit, "wire", {"from": f"({a[0]},{a[1]})", "to": f"({b[0]},{b[1]})"})
        if self.sheet_gap:
            self._compact_sheet(circuit)
        # Only this definition is rewritten; everything else in the file stays
        # byte for byte (a student diffing their file sees one circuit change).
        return splice_circuit(self.source, self.circuit_name, circuit)

    def _compact_sheet(self, circuit):
        """Squeeze the air out of the routed sheet (compaction.compact_x):
        everything below the panel moves left as far as its neighbours at the
        same height allow, keeping every left-to-right order where heights
        overlap, so crossings, bends and connectivity stay exactly as routed;
        parts that share a left edge move together and stay a column.
        Geometry of a part comes from its observation; Tunnels and Constants
        written by emit are estimated from their label and width."""
        cid_of = {id(el): cid for cid, el in self.element_of.items()}
        panel = self.panel_below_y
        comps, elements = [], []
        for el in circuit.findall("comp"):
            x, y = _loc(el.get("loc"))
            c = self.by_id.get(cid_of.get(id(el)))
            if c is not None:
                ox, oy = x - c["location"]["x"], y - c["location"]["y"]
                b = c["bounds"]
                boxes = [(b["x"] + ox, b["y"] + oy, b["x"] + ox + b["width"], b["y"] + oy + b["height"])]
                ports = [(e["location"]["x"] + ox, e["location"]["y"] + oy) for e in c["ends"]]
            else:
                boxes, ports = _estimated_geometry(el, x, y)
            label = _attr(c, "label") if c is not None else None
            if label and c["factoryName"] == "Pin":
                x0, y0, x1, y1 = boxes[0]
                w = _text_width(label)
                side = _attr(c, "labelloc") or "west"
                if side == "west":
                    boxes.append((x0 - w, y0, x0, y1))
                elif side == "east":
                    boxes.append((x1, y0, x1 + w, y1))
            fixed = panel is not None and max(bx[3] for bx in boxes) < panel
            comps.append({"boxes": boxes, "ports": ports or [(x, y)], "fixed": fixed,
                          "cling": el.get("name") == "Tunnel" or el.get("name") in CONSTANT_SOURCES})
            elements.append(el)
        wires, wire_elements = [], []
        for w in circuit.findall("wire"):
            a, b = _loc(w.get("from")), _loc(w.get("to"))
            wires.append((a, b, panel is not None and max(a[1], b[1]) < panel))
            wire_elements.append(w)
        # The Pins of a north or south edge are an instance's ports in x order,
        # and a consumer that read left to right from its driver keeps doing
        # so (over a label no wire holds them apart; a wire that turns back
        # does not either).
        edge_pins = sorted((comps[i]["ports"][0][0], i) for i, el in enumerate(elements)
                           if el.get("name") == "Pin" and _attr_of(el, "facing") in ("north", "south"))
        keep = [((i, xi), (j, xj)) for (xi, i), (xj, j) in zip(edge_pins, edge_pins[1:])]
        index = {cid_of[id(el)]: i for i, el in enumerate(elements) if id(el) in cid_of}
        for key in self.nets:
            ends = [(cid, idx) for cid, idx in self.nets[key] if cid in index and cid in self.moved]
            drivers = [(index[cid], self.moved[cid]["ends"][idx]["location"]["x"]) for cid, idx in ends
                       if self.by_id[cid]["ends"][idx].get("direction") == "output"]
            consumers = [(index[cid], self.moved[cid]["ends"][idx]["location"]["x"]) for cid, idx in ends
                         if self.by_id[cid]["ends"][idx].get("direction") == "input"]
            keep += [(d, c) for d in drivers for c in consumers if c[1] > d[1]]
        bodies = [i for i, (c, el) in enumerate(zip(comps, elements)) if not c["fixed"] and el.get("name") not in ("Tunnel", "Text")]
        if not bodies:
            return
        boxes = [comps[i]["boxes"][0] for i in bodies]
        width = max(b[2] for b in boxes) - min(b[0] for b in boxes)
        height = max(b[3] for b in boxes) - min(b[1] for b in boxes)
        cap = next(v for n, v in DENSITY_MAX if len(bodies) < n)
        min_width = len(bodies) * 1e6 / (cap * max(height, 1))
        if width <= min_width:
            return                              # already as dense as hand-drawn sheets get
        # Parts that share a left edge (a column, as placed) keep sharing it.
        columns = defaultdict(list)
        for i in bodies:
            if elements[i].get("name") not in CONSTANT_SOURCES:
                columns[comps[i]["boxes"][0][0]].append(i)
        together = [members for members in columns.values() if len(members) > 1]
        dx, moved = compact_x(comps, wires, part_gap=self.sheet_gap, keep_order=keep, min_width=min_width, extent_parts=bodies,
                              together=together)
        pins = {}
        for el, d in zip(elements, dx):
            if d:
                x, y = _loc(el.get("loc"))
                el.set("loc", f"({x + d},{y})")
                if el.get("name") == "Pin":
                    pins[(x, y)] = (x + d, y)
                cid = cid_of.get(id(el))
                if cid is not None:
                    px, py = self.placement.get(cid, (0, 0))
                    self.placement[cid] = (px + d, py)      # the whole move, as callers map parts by it
                if cid in self.moved:
                    m = self.moved[cid]
                    m["location"] = {"x": m["location"]["x"] + d, "y": m["location"]["y"]}
                    m["bounds"] = dict(m["bounds"], x=m["bounds"]["x"] + d)
                    m["ends"] = [dict(e, location={"x": e["location"]["x"] + d, "y": e["location"]["y"]}) for e in m["ends"]]
        for w, (a, b) in zip(wire_elements, moved):
            w.set("from", f"({a[0]},{a[1]})")
            w.set("to", f"({b[0]},{b[1]})")
        appear = circuit.find("appear")
        for port in appear.iter("circ-port") if appear is not None else ():
            try:
                old = tuple(int(v) for v in port.get("pin", "").split(","))
            except ValueError:
                continue
            if old in pins:
                port.set("pin", "%d,%d" % pins[old])
        before = max((bx[2] for c in comps for bx in c["boxes"]), default=0)
        after = max((bx[2] + d for c, d in zip(comps, dx) for bx in c["boxes"]), default=0)
        self.report["sheetCompactedPx"] = before - after


def netlist_signature(focus, *, ignore_factories=("Tunnel",)):
    """Canonical connectivity over non-tunnel ports, keyed by stable identity.

    Identity = (factoryName, label, sorted attribute values, end index) is not
    unique in general; callers pass a focus whose components carry an
    `identity` tag injected before layout. Here we key by componentId when the
    caller guarantees ids are stable, else by (factory, label, index).
    """
    def attr(c, n):
        for a in c["attributes"]:
            if a.get("name") == n:
                return a.get("value", a.get("standard"))
        return None
    groups = defaultdict(set)
    for c in focus["components"]:
        if c["factoryName"] in ignore_factories:
            continue
        ident = (c["factoryName"], attr(c, "label"), c.get("identity"))
        for e in c["ends"]:
            bits = e.get("netBits") or []
            if not bits:
                continue
            groups[_key(bits)].add((ident, e["index"]))
    return sorted(frozenset(v) for v in groups.values() if len(v) >= 2)
