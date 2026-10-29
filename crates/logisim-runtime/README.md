# logisim-runtime

The Java side of the product, driven from Rust: the real Logisim runtime loads the file, says which pins exist and where, what is electrically connected, records how each kind of component draws itself and how a running circuit looks frame by frame, renders pictures for the AI, and runs the simulation. Nothing in Rust or TypeScript re-implements Logisim semantics; when a question is "what would Logisim do", it is answered here by asking Logisim.

## Owns

- `runtime.rs`: which Logisim jar to use (`RuntimeFacts::runtime_for(source)` picks the compatible runtime per file: Logisim-ITA 2.16 or the 2020 course build, both pinned in `config/runtime-lock.json`), Java discovery, the bridge class cache keyed by jar and source digests, and `Launcher` (how to start a worker).
- `process.rs`: child process plumbing, UTF-8 on Windows, bounded stderr capture for diagnostics.
- `lib.rs` (`Native`): the long-lived worker and its request protocol (below). One request = one XML element in, XML bytes out, translated to JSON with `xml_json(node) = {tag, attributes, text, children}`. The worker answers each request with one line, `status\tbase64[\tphases]`; the third field appears only when timing is on. Its first reply is the handshake `ready <runtime version>`, which is where `observed_version` comes from; replies themselves are not parsed for a version.

  A request names a document id and a revision (`vibe_circuit_document::Revision`), never a file. The worker keeps up to three loaded documents, each at one revision; `Native` mirrors that (same ids, same eviction by least recent use) and decides what to send: nothing when the worker already holds that revision, the per-circuit difference (`Revision::changes`, a `<change>` of `<remove>/<add>/<wire>`) when the worker holds one this applies to in place, and the whole bytes when it does not. Nothing is written to disk for this, and a worker that reports `reload` (its own held revision is not what Rust thinks) gets the whole bytes next. External libraries are still files: `Native` digests the document's `<lib>` files and drops the worker when one changes.
- `timing.rs`: opt-in per-request stage timing for the host (`scope`, `span`). With `VIBE_WORKBENCH_TIMING=1` the host prints `timing <op> <total>ms <stage>=<ms> …` per request on stderr; the worker inherits the variable and reports its phases (`WorkerTiming.java`), recorded as `java.<phase>`. Unset, nothing is collected or printed.
- `simulation/`: the interactive run (below). `registry.rs` holds at most one run, sends its events to every subscriber and owns the separate verification worker the AI's checks use; `run.rs` is the run: one JVM, the commands waiting for their acknowledgement, the newest whole state (components, picture, waveform, memory page) and a watchdog; `protocol.rs` the wire format; `model.rs` the typed contract (`RunInfo`, `Command`, `FrameEvent`, `SimulationEvent`, …, all `ts_rs` exported for the UI); `paint.rs` the run's picture; `error.rs` the stable error codes.
- `java/native/com/cburch/logisim/file/*.java`: the bridge compiled against whatever jar the project needs (`CircuitWorker` request loop, `LoadedProject` a project the worker keeps and advances revision by revision, `circuit/DocumentIds` the document's ids of its loaded components and wires, `circuit/CircuitMoves` Logisim's move gesture (below), `circuit/CircuitConnections` (below), `NativeCircuitLoader`, `CircuitPalette` catalog/template/placement, `CircuitSymbols` and `RecordingGraphics2D` the vector picture of each kind of component (below), `CircuitPaint` the running circuit's picture per frame (with `circuit/WirePaint`, which calls the package-private `CircuitWires.draw`), `CircuitObjects` attribute reads, `CircuitInterface` pin description, `CircuitRenderer` (PNG of a viewport, for the AI's `render`), `PngEncoder` (every PNG: AI renders, palette icons, images inside symbols; unfiltered rows at the fastest deflate level, about a fifth of ImageIO's time for a file half again as large), `CircuitSession*` simulation, `CircuitTrace`, `CircuitWorkbench` pin-vector and trace batches for the verification worker). The worker answers exactly the request kinds `lib.rs` sends; a new kind is added on both sides at once.
- `java/observer/`: `ExactRuntimeObserver` reads nets, ports and hierarchy from Logisim's own data structures (see its README; it has its own CLI for debugging). Besides ports and nets it reports what each component does with time, computed from the definitions' own nets and never from names: `storage` on every component (`delay` = holds its inputs a cycle: Register, Shift Register, flip-flops, and subcircuits whose every input only reaches storage inside; `state` = changes on its own or feeds itself: Counter, Random, a PC with its incrementer; absent = combinational, including ROM/RAM) and `registered` on the input ends of subcircuit instances (the signal only reaches storage inside, e.g. the write port of a register file). The arranger builds stage boundaries from these two fields.

## Does not own

Documents, revisions, saving, history, the application state, anything about the AI. It is handed each document's bytes in memory and never reads the document's own file.

## Public interface

```rust
pub struct Native;   // Native::new(root, state, runtime) | Native::with_launcher(launcher)
impl Native {
    async fn observe(&mut self, revision: &Revision, circuit: &str) -> Result<Value>;            // components with ports/ends/nets, wires, bounds, focus for the arranger
    async fn observe_raw(&mut self, revision, circuit) -> Result<Box<RawValue>>;                 // the same, checked to be JSON, for callers that pass it on whole
    async fn catalog(&mut self, revision, circuit) -> Result<Value>;                             // <group id name label><tool name label factory [disabled] [icon]/>…>; id "" = this file's subcircuits
    async fn template(&mut self, revision, circuit, library: Option<String>, name, location: Option<Point>, attributes) -> Result<Value>;
                                                                                                  // root attrs factory, facingAttribute, snap; children bounds, port, attribute(option…), comp (the <comp> to splice when location is given)
    async fn properties(&mut self, revision, circuit, component: &str, values, list: bool) -> Result<Value>;
                                                                                                  // by document component id: the attributes with `values` applied as the runtime stores them, the circuit unchanged; `list` adds each attribute's label and choices (the inspector; building the choices costs 10–15 ms)
    async fn interface(&mut self, revision, circuit) -> Result<Element>;                         // the circuit's interface as the runtime draws it
    async fn memory(&mut self, ..) -> Result<Value>;
    async fn symbols(&mut self, revision, circuit, items: &[SymbolSource]) -> Result<Box<RawValue>>;
                                                                                                  // the vector picture of each item, in order, plus the circuit's width conflicts (below)
    async fn connections(&mut self, revision, circuit, seeds: &ConnectionSeeds) -> Result<Box<RawValue>>;
                                                                                                  // the nets of chosen components, wires and a point, in document ids (below)
    async fn moves(&mut self, revision, circuit, ids: &[String], delta: Point, connect: bool) -> Result<MoveResult>;
                                                                                                  // Logisim's own MoveGesture answer for that translation (below)
    async fn width_errors(&mut self, revision, circuits: &[String]) -> Result<Vec<Option<Vec<[i32; 2]>>>>;
                                                                                                  // each circuit's width-conflict points, as symbols reports them; None for a circuit the file lacks
    async fn render(&mut self, revision, circuit, Viewport{x,y,width,height,scale}) -> Result<String>; // PNG data URL; scale ≤ 8, area ≤ 8 M px
    async fn request(&mut self, revision: &Revision, operation: Element) -> Result<Vec<u8>>;     // raw escape hatch
    fn status(&self) -> Value;  fn observed_version(&self) -> Option<&str>;  async fn shutdown(&mut self);
}
pub struct SimulationRegistry;  // new(launcher); start(RunDocument, circuit, frequency?) -> RunInfo (after the first frame; ends the current run first)
                                // command(Command) -> commandSequence; navigate(instance_path) -> commandSequence; stop(); end(reason); reconcile(revision_of)
                                // run() -> Option<RunInfo>; frame() -> Option<(RunInfo, Frame, Option<TraceDelta>)> (the newest whole state, for keeping); subscribe() -> Subscription
                                // verify(revision, operation): a check in the separate verification process; shutdown
pub mod simulation::{Command, RunInfo, FrameEvent, LiveComponent, PaintEvent, Frame, ComponentState, SimulationEvent, EndReason, EndedInfo, SimError, Code};
pub enum SymbolSource { Placed { id: String }, Made { library: Option<String>, name: String, attributes: BTreeMap<String, String> } }
pub struct ConnectionSeeds { components: Vec<String>, wires: Vec<String>, point: Option<(Point, f64)> }  // component ids; wire ids; ends within the radius
pub struct MoveResult { wires: WireEdit, unconnected: Vec<Point> }   // the wires a move takes out and adds; where it leaves an end unconnected (before the move)
pub struct RunDocument { revision: Revision, view: DocumentView }     // what a run starts from
pub fn xml(tag, attrs, children) -> Element;  pub fn encode_xml(..);  pub fn xml_json(node) -> Value;
pub fn library_dependencies(file: &Path) -> Result<BTreeMap<PathBuf, String>>;  // a .circ file's external .circ/.jar libraries with digests
```

### Symbols

The window draws the editor picture itself; Java only says how each kind of component looks. `symbols` records `Component.draw` of one component per item into `RecordingGraphics2D`, a `Graphics2D` that paints nothing and writes each call as a vector op. `SymbolSource::Placed` names a component of the circuit by document id; `Made` builds one at (0, 0) from its library tool and attributes, as `template` does (placement ghosts, kinds not in the circuit); it sets every attribute the key names that the tool's set has, in passes until none is left (an attribute can appear only after another is set, like a gate's inputs or a splitter's bits), skipping read-only ones and keeping the tool's value for one this runtime cannot parse, because a key comes from a saved component or a template and a picture needs the same values, not the edit path's validation. The draw context is `CircuitRenderer`'s: print view, `showState` false, `showColor` true, the project's circuit state (a separate one for made components), each component on its own `g.create()` of a root with antialiasing on and black. The reply is JSON:

```text
{"symbols": [{"bounds": {x, y, width, height}, "ink": {x, y, width, height},
              "ports": [{index, x, y, width, direction}], "ops": [op, …]} | {"error": text}, …],
 "widthErrors": [[x, y], …]}
```

Everything is relative to the component's location. `bounds` is `Component.getBounds()` (selection, hit testing, placement); `ink` covers everything the ops can touch (culling); `direction` is `input`, `output`, `inout` or `none` as in observations. `widthErrors` are the points of the circuit's wire bundles whose widths disagree: Logisim draws those wires and their dots in `Value.WIDTH_ERROR_COLOR` (`#ff7b00`), every other wire black (`WireWidths`, in the bridge's `circuit` package because bundles are package-private there).

Ops are arrays in the component's space; style ops apply to every following op and each item's list starts with the styles it uses, so one symbol replays on its own (`apps/workbench/src/editor/paint.ts`):

| op | meaning |
| --- | --- |
| `["C", "#rrggbb[aa]"]`, `["N", class]` | color; a paint that is not a color (keeps the last color) |
| `["W", width, cap, join, miter?, [dash], phase]` | `BasicStroke`; cap 0 butt 1 round 2 square, join 0 miter 1 round 2 bevel; miter only when not 10 |
| `["F", family, style, size]` | font by family (`Dialog`, `SansSerif`, `Serif`, `Monospaced`, …); style 1 bold, 2 italic |
| `["X", rule, alpha]`, `["X"]` | `AlphaComposite`; plain source-over |
| `["K"]`, `["K", x, y, w, h]`, `["K", path]` | clip: none, rectangle, path |
| `["Z"]`, `["Z", color]` | paint mode, XOR mode |
| `["L", x1, y1, x2, y2]` | line |
| `["R"/"r", x, y, w, h]` | rectangle drawn / filled |
| `["E", color, x, y, w, h]`, `["E", color, path]` | `clearRect` to that background |
| `["Q"/"q", x, y, w, h, arcW, arcH]` | round rectangle |
| `["O"/"o", x, y, w, h]` | oval |
| `["A"/"a", x, y, w, h, start, extent]` | arc in degrees counterclockwise; filled = pie |
| `["Y", [x, y, …]]`, `["G"/"g", [x, y, …]]` | polyline; polygon (filled even-odd) |
| `["P"/"p", "M x y L … Q … C … Z", 1?]` | shape drawn / filled with its curves; 1 = even-odd fill |
| `["T", text, x, y, [a, b, c, d]?]` | text with its baseline-left at x, y; the matrix when the transform is not a translation |
| `["I", dataUrl, [a, b, c, d, e, f]]` | image under that transform |
| `["U", x, y]` | the next drawing op only when something else connects at x, y |

`U` exists because shaped gates in print view draw an input's line only when that input is connected (`PainterShaped`, `PainterDin`, the only painters of both runtimes and the course jars that ask). The recording's draw context has a circuit that answers every `isConnected` with yes and marks the next drawing op with the point it was asked about; the window checks the point against the document, the way `Circuit.isConnected` checks wire and component ends.

### Connections

`connections` is what the editor's connection panel and signal tracing read: the part of an observation's focus that some chosen objects need, with the same ids and values as `observe` at that revision (`CircuitConnections`, in the bridge's `circuit` package to reuse `ExactRuntimeObserver.NetIndex`). Request children are the seeds, in document ids: `<component id/>` (every component with that id), `<wire id/>` (the wire with that id), `<point x y radius/>` (every component with an end that close). The bit nets read are those of every end of a seed component and of every bit of a seed wire's bundle. The reply is JSON:

```text
{"focus": {"components": [{componentId, factoryName, displayName?, selector?: {label}, location, bounds, partial?: true,
                           ends: [{index, location, width, direction, semanticRole?, runtimeTooltip?, netBits?: [{bit, netId}]}]}, …],
           "wires": [{wireId, from, to, bundleId}, …],
           "wireBundles": [{bundleId, valid, width, wireIds, bitNets: [{bit, netId}]}, …],
           "bitNets": [{netId, contacts: [{componentId, endIndex, bit}]}, …]}}
```

Seed components come whole: every end, with `netBits`. Every other component with an end on those nets comes `partial`, with only those ends and without `netBits` (the nets' `contacts` say which bit of which end is on which net). `wireBundles` are the seed wires' bundles and every bundle the nets pass through, `wires` the wires of those bundles. A circuit's index (nets, each net's contacts, each component's end nets, the components by place and the wires by ends) is built the first time a revision is asked about it and kept with the loaded project until it advances; a request only picks its part and writes it.

### Move

`moves` asks Logisim what moving a selection by an offset does, without editing anything. The request is `<move circuit dx dy connect components wires/>` with the ids to move, space-separated; the worker builds the runtime's own `MoveGesture` for those components and wires and calls `forceRequest(dx, dy)`, which is what Logisim's select tool does when the mouse is released. The reply is JSON:

```text
{"remove": [wireId, …],          the document wires the move takes out (one that keeps a part comes back as that part in add)
 "add": [[x0, y0, x1, y1], …],   the segments the gesture adds, at their place after the move
 "unconnected": [[x, y], …]}     where a moved end touched something the gesture found no route back to (its place before the move)
```

`connect="false"` (Logisim's shift-drag) and a zero offset answer empty lists without running the gesture. The gesture of one selection is kept with the loaded revision, so asking again at another offset during a drag reuses its search (`Connector` has its own time and iteration limits). A native wire that only partly lies under the moved document wires (two in-line wires the load merged) is split at the document wire ends for the gesture and put back afterwards. The host applies the answer as one edit (`Document::translate`: the translation plus these wire edits, one undo step "移动 N 个对象"); an end dropped onto a wire or another end connects there, as in Logisim. Asking does not advance the revision; the edit that writes it does.

`width-errors` takes `<circuit name/>` children and answers `[[[x, y], …] | null, …]` in their order: each circuit's width-conflict points as `symbols` reports them, null for a circuit the file does not have. The host asks it for the circuits an edit, undo or redo changed and puts the points in its answer.

Java error texts are user-facing and the host passes them through unchanged, for example `组件库不在当前文件中: <id>`, `当前组件库没有这个可放置元件: <name>`, `请将整个元件放在画布的非负坐标区域`, `此位置与已有元件冲突，请换一个位置`, `此位置已有相同元件`, `不能放入自身或引用了当前电路的子电路`.

### The run

A run is one `CircuitSession` process. Its first input line is the start element (`<session name directory circuit frequency?>` holding `<component id factory x y/>` for each component of the root circuit) and, after a tab, the revision's bytes, both base64; the verification process takes each check's revision the same way. Nothing is written to disk for either. The process holds the circuit state; nothing above it keeps another copy. Commands are one element per line: `toggle-clock`, `play`, `pause`, `tick`, `reset`, `toggle-propagation`, `step`, `configure {frequency?, automatic?}`, `poke`, `input`, `button`, `pulse`, `trace`, `trace-stop`, `memory`, `memory-write`, and `view` to show an instance (`<instance id factory x y/>` for each step of the path, `<component id factory x y/>` for each component of the shown circuit). The process reads them on one thread and answers each with an `<ack>` in the same order, carrying `commandSequence` (how many commands it has taken) or `error`/`code`/`message`; `run.rs` pairs acks with the waiting commands by order. Toggles read the process's own state, so a burst of them never acts on an old frame.

Frames come from another thread whenever the state changed, at most every 16 ms, recorded under the session lock and encoded outside it:

```text
<frame captureMs encodeMs circuit commandSequence ticks running automatic pending frequency actualFrequency oscillating [failure failureCode] full>
  <instance id/>…                                       the shown instance, from the root
  <component id [control] [input]>bits|bits…</component>…   components whose values changed; all of them when full
  [<memory componentId offset count …><word value/>…</memory>]  the RAM page asked for with `memory`
  [<trace id recording total dropped full>…</trace>]        only when the waveform changed: new samples, all kept ones when full
  <paint>{"wires": [[x1, y1, x2, y2, color], …], "dots": [[x, y, color], …], "components": {id: [op, …], …}}</paint>   what changed in the picture; all of it when full
</frame>
```

A frame is full after the start and after every `view`; otherwise each part carries only what changed. Values are Logisim's binary text without spaces: `0`, `1`, `x` unknown, `E` error, `-` for a port without width.

The picture draws nothing itself: it says how the circuit looks now, in the ops of the table above, and the window paints it. `CircuitPaint` records, under the session lock, `CircuitWires.draw` (wires 3 wide in the colors Logisim gives them: the value's, `Value.WIDTH_ERROR_COLOR` for a bundle whose widths disagree, `Value.NIL_COLOR` when the whole bundle map is invalid; junctions as 8-wide ovals) and every component of the view with Logisim's canvas context, not the print view: `ComponentDrawContext(null, circuit, state, g, g, false)` with `showState` and `showColor`, each component on its own `g.create()`, relative to its location. A live circuit answers connection questions itself, so there is no `U`. It keeps what it last sent for each wire, junction and component and puts only what changed into the frame. `captureMs` is the recording under the lock, `encodeMs` comparing and writing JSON and XML.

`run.rs` lays each frame over the run's newest state and sends it on as a `FrameEvent` with the same parts. Its picture (`PaintEvent`, `paint.rs`) groups wires and junctions by color as flat coordinate arrays and gives a changed component as the number of its op list. The run's picture numbers every op and op list once, from 0 at a full frame and onwards from there, and an event carries only the ones numbered since the event before (`ops`, `lists`), so components that look alike cost one list and a component that goes back to a look it had (a tunnel's color, a register's value) costs one number. The whole state carries every number still known; once the numbered looks grow past three times what the picture had when numbering started, the run numbers the picture anew and sends the frame as a full one. A subscription starts with the whole state (`run`, then a full `frame` built from the newest state, or the last `ended` when there is no run) and then gets every frame in order; one that falls behind starts over with the whole state. `Frame` is the newest state with components in Logisim's long form (`ComponentState`, ports with width, grouped bits and value), which a kept observation stores.

## Dependencies

`tokio` (processes), `xmltree`/`quick-xml`, `base64` (PNG data URLs), `serde_json`, `ts-rs`; `vibe-circuit-document` only for `DocumentView`/`Point` types. Java 17+ at build time, the bundled Temurin 21 at run time (`runtimes/java`).

## Invariants and Logisim pitfalls

- The bridge sources must compile against _any_ runtime a project may need, including the 2020 course build that has no `com.cburch.logisim.plugin` package. Every reference to an ITA-only class goes through reflection (see `NativeCircuitLoader.pluginAlias`). A direct import breaks course projects silently at class-load time.
- Jar dependencies are resolved by basename next to the file. The native path (`getFileFor`) lacked that resolution once and the headless worker popped up a Swing dialog and died; keep `NativeCircuitLoader.openChecked` as the single entry.
- `trigger=high` on `<comp>` in 2.7.1 files: the runtime drops the component without an error. `openChecked` re-reads the file and reports/repairs; do not bypass it.
- The bridge carries `com.cburch.logisim.circuit.WireRepair`: the ITA 2.16.2.2 class with a `doSplits` that looks up split points on each wire's row or column (within the 2 px `Wire.contains` accepts) instead of testing every point against every wire, which was most of the load time of a large file. Same points, same order, same loaded circuit. Bridge classes come first on the worker class path, so this copy replaces the class of both supported runtimes, which carry the same one. Before adding or upgrading a runtime, diff its `WireRepair` against this copy; `test:compatibility` loads a junction file on both runtimes.
- The worker is headless. Anything that could create a `JFrame` or dialog must be guarded; `java.awt.headless=true` is set by the launcher.
- One request at a time per worker. The registry holds a gate so simulation commands never wait behind editor observations.
- The worker keeps up to three loaded documents by document id, each at one revision, with one `Project` that every drawing and observation of it uses (a `Project` per request leaves listeners behind), a map from the document's ids to the loaded components and wires, its latest four observation replies, and the `connections` index of each circuit asked about at the current revision. The request line is base64 XML plus, on a load, a tab and base64 bytes: `<request document revision directory? [bytes] [change]><op …/></request>`. Rust has already worked out the difference (`Revision::changes`), so a change is a list of circuits with `<remove id/>`, `<add id>element text</add>` and `<wires><wire from to/>…</wires>` (the circuit's whole wire list after the change, which keeps Logisim's load-time splitting at junctions in step with the file). `LoadedProject.advance` applies it in place: removed components taken out, added ones built by the runtime's reader after its version repairs, the wires made the new file's, one `CircuitTransaction`, which repairs wires and updates instance ports like an edit in Logisim. A document the worker does not hold, a revision that is not the one it holds and has no change for, a file that loaded with reports, or one older than 2.6.3 loads whole through `openChecked`. A worker that cannot apply a change answers `reload` and Rust sends the bytes. `test:compatibility` pins that a revision applied in place observes like a whole load; a change to how revisions are applied must keep that. A changed external library restarts the worker.
- Document ids are the only ids: the bridge's replies carry the document's `c<x>_<y>`/`w<n>` ids and its requests name components and wires by them. The map from id to loaded object is rebuilt whenever the circuit's component or wire list changes (an applied change updates it) and never uses geometry to look an object up, so two identical parts on one point stay distinct.
- A loaded circuit has more wires than its file has `<wire>` elements: `WireRepair` splits wires at junctions, so one document wire id can name a run of native wires. Replies report the document id; the wire edits a move returns are the file's runs, not the native splits.
- A symbol is a function of the component's library, name and attributes, the project's libraries and, for a subcircuit, its definition; the window caches it under that key and drops subcircuit symbols when their circuit changes. What a painting reads besides that must stay out of it: the draw context shows no state (pins show the fresh project's value), connections go through `U`, and nothing in it depends on where the component sits. A painter that reads anything else (time, the circuit through `getCircuit()`) would make the window's picture differ from Logisim's; the bridge and the course jars were scanned for such reads when this was built.
- An observation measures text with a graphics context, which caches in the components; a circuit's reported `bounds` can grow by a few pixels after the project has been observed once. Compare observations of a project measured the same way.

## Status

Done; this is the code path every real-model turn already exercised. Costs on a 1 MB course file, release build: opening it loads it whole, 35–90 ms (preflight 7–24, Logisim 29–63); the first request on each later revision applies the edit in place, 3–7 ms; an observation of a 350-component page takes 30 ms and of a 700-component page 60–80 ms, a quarter of it writing 3.6 MB of JSON; `connections` on a 713-component page builds its index in 5–7 ms the first time a revision is asked, then answers in under a millisecond of worker time (3–72 KB); `width-errors` under 1 ms; a render of a 1400×900 viewport about 10 ms at scale 1 (drawing 6, PNG 2.5), 16 ms at 1.5 and 22 ms at 2; recording every kind of component on a 713-component page (369 kinds, 4269 ops, 174 KB of JSON) takes 10–14 ms once the worker has drawn before and about 0.7 s the first time (class loading). A run of that page (debug host, Java 25): a start shows its first picture 0.70–0.79 s after the click on a quiet machine, the process alone 0.68–0.73 s (the bundled Java 21 0.81 s; 0.8–1.3 s while another heavy program runs), of which loading the project is about 0.44 s and the first frame about 0.1 s since the fonts, text layout and XML writer warm up beside the project load (0.3–0.4 s before). The whole state is 110 KB (paint 77 KB: 999 wires, about 1220 ops in 385 lists; port values 33 KB). At 2 Hz a falling edge is a 4 KB event (paint 0.7 KB, port values 3 KB) and a rising edge while the program runs 15–30 KB (paint 5–10 KB, port values 10–21 KB); once the program halts every event is about 4 KB. At 256 Hz about 50 events a second, 177 KB/s. Recording a frame takes 2.5 ms (p50; 10 ms for a whole one).

## Remaining tasks

- Done: observing proposed XML is the host's `observeXml`, which sends the proposal as the document's next revision and calls `observe_raw`; no Java change.
- `template` without `location` returns defaults only; `place_component` in the AI runtime wants bounds too and currently gets them. Keep that contract when touching `CircuitPalette.java`.

## Verify

```sh
npm run setup            # downloads the pinned runtimes into .workbench-cache
npm run test:native      # builds the host, runs scripts/workbench/verify.mts and simulation-controls-check.mts against real JVMs
npm run test:compatibility
```
