# logisim-runtime

The Java side of the product, driven from Rust: the real Logisim runtime loads the file, says which pins exist and where, what is electrically connected, records how each kind of component draws itself and how a running circuit looks frame by frame, renders pictures for the AI, and runs the simulation. Nothing in Rust or TypeScript re-implements Logisim semantics; when a question is "what would Logisim do", it is answered here by asking Logisim.

## Owns

- `runtime.rs`: which Logisim jar to use (`RuntimeFacts::runtime_for(source)` picks the compatible runtime per file: Logisim-ITA 2.16 or the 2020 course build, both pinned in `config/runtime-lock.json`), Java discovery, the bridge class cache keyed by jar and source digests, and `Launcher` (how to start a worker).
- `process.rs`: child process plumbing, UTF-8 on Windows, bounded stderr capture for diagnostics.
- `lib.rs` (`Native`): the long-lived read-only worker and its request protocol. One request = one XML element in, XML bytes out, translated to JSON with `xml_json(node) = {tag, attributes, text, children}`. The worker answers each request with one line, `status\tbase64[\tphases]`; the third field appears only when timing is on. Its first reply is the handshake `ready <runtime version>`, which is where `observed_version` comes from; replies themselves are not parsed for a version. `Native` remembers each artifact's and library's digest, top-level libraries and `source` version, and reads a file again only when its size, modification time or (Unix) inode or change time differ; a request on a known revision reads nothing.
- `timing.rs`: opt-in per-request stage timing for the host (`scope`, `span`). With `VIBE_WORKBENCH_TIMING=1` the host prints `timing <op> <total>ms <stage>=<ms> …` per request on stderr; the worker inherits the variable and reports its phases (`WorkerTiming.java`), recorded as `java.<phase>`. Unset, nothing is collected or printed.
- `simulation/`: the interactive run (below). `registry.rs` holds at most one run, sends its events to every subscriber and owns the separate verification worker the AI's checks use; `run.rs` is the run: one JVM, the commands waiting for their acknowledgement, the newest whole state (components, picture, waveform, memory page) and a watchdog; `protocol.rs` the wire format; `model.rs` the typed contract (`RunInfo`, `Command`, `FrameEvent`, `SimulationEvent`, …, all `ts_rs` exported for the UI); `paint.rs` the run's picture; `error.rs` the stable error codes.
- `java/native/com/cburch/logisim/file/*.java`: the bridge compiled against whatever jar the project needs (`CircuitWorker` request loop, `LoadedProject` a project the worker keeps and advances revision by revision, `FileLayout` the byte layout of a project file it compares revisions by, `NativeCircuitLoader`, `CircuitPalette` catalog/template/placement, `CircuitSymbols` and `RecordingGraphics2D` the vector picture of each kind of component (below), `CircuitPaint` the running circuit's picture per frame (with `circuit/WirePaint`, which calls the package-private `CircuitWires.draw`), `CircuitObjects` attribute reads, `CircuitInterface` pin description, `CircuitRenderer` (PNG of a viewport, for the AI's `render`), `PngEncoder` (every PNG: AI renders, palette icons, images inside symbols; unfiltered rows at the fastest deflate level, about a fifth of ImageIO's time for a file half again as large), `CircuitSession*` simulation, `CircuitTrace`, `CircuitWorkbench` pin-vector and trace batches for the verification worker). The worker answers exactly the request kinds `lib.rs` sends; a new kind is added on both sides at once.
- `java/observer/`: `ExactRuntimeObserver` reads nets, ports and hierarchy from Logisim's own data structures (see its README; it has its own CLI for debugging). `connectivityLoaded` is the lean view for connection checks: the same nets, without drawing or describing anything. Besides ports and nets it reports what each component does with time, computed from the definitions' own nets and never from names: `storage` on every component (`delay` = holds its inputs a cycle: Register, Shift Register, flip-flops, and subcircuits whose every input only reaches storage inside; `state` = changes on its own or feeds itself: Counter, Random, a PC with its incrementer; absent = combinational, including ROM/RAM) and `registered` on the input ends of subcircuit instances (the signal only reaches storage inside, e.g. the write port of a register file). The arranger builds stage boundaries from these two fields.

## Does not own

Documents, revisions, saving, history, the application state, anything about the AI. It receives a path to an immutable artifact file (the host materialises one file per revision) and never writes it.

## Public interface

```rust
pub struct Native;   // Native::new(root, state, runtime) | Native::with_launcher(launcher)
impl Native {
    async fn observe(&mut self, artifact: &Path, circuit: &str) -> Result<Value>;                // components with ports/ends/nets, wires, bounds, focus for the arranger
    async fn connectivity_bytes(&mut self, artifact, circuit) -> Result<Vec<u8>>;               // the worker's JSON of what a connection check compares: {focus: {components: [{location, factoryName, ends: [{index, location, width, netBits}]}], wireBundles: [{bundleId, valid, width, points, bitNets}]}}, the same values as an observation at a fraction of its cost
    async fn observe_raw(&mut self, artifact, circuit) -> Result<Box<RawValue>>;                 // the same, checked to be JSON, for callers that pass it on whole
    async fn catalog(&mut self, artifact, circuit) -> Result<Value>;                             // <group id name label><tool name label factory [disabled] [icon]/>…>; id "" = this file's subcircuits
    async fn template(&mut self, artifact, circuit, library: Option<String>, name, location: Option<Point>, attributes) -> Result<Value>;
                                                                                                  // root attrs factory, facingAttribute, snap; children bounds, port, attribute(option…), comp (the <comp> to splice when location is given)
    async fn properties(&mut self, artifact, circuit, component) -> Result<Value>;
    async fn memory(&mut self, ..) -> Result<Value>;
    async fn symbols(&mut self, artifact, circuit, items: &[SymbolSource]) -> Result<Box<RawValue>>;
                                                                                                  // the vector picture of each item, in order, plus the circuit's width conflicts (below)
    async fn connections(&mut self, artifact, circuit, seeds: &ConnectionSeeds) -> Result<Box<RawValue>>;
                                                                                                  // the nets of chosen components, wires and a point, in observation ids and fields (below)
    async fn width_errors(&mut self, artifact, circuits: &[String]) -> Result<Vec<Option<Vec<[i32; 2]>>>>;
                                                                                                  // each circuit's width-conflict points, as symbols reports them; None for a circuit the file lacks
    async fn render(&mut self, artifact, circuit, Viewport{x,y,width,height,scale}) -> Result<String>; // PNG data URL; scale ≤ 8, area ≤ 8 M px
    async fn request(&mut self, artifact, operation: Element) -> Result<Vec<u8>>;                // raw escape hatch
    fn status(&self) -> Value;  fn observed_version(&self) -> Option<&str>;  async fn shutdown(&mut self);
}
pub struct SimulationRegistry;  // new(launcher); start(RunDocument, circuit, frequency?) -> RunInfo (after the first frame; ends the current run first)
                                // command(Command) -> commandSequence; navigate(instance_path) -> commandSequence; stop(); end(reason); reconcile(revision_of)
                                // run() -> Option<RunInfo>; frame() -> Option<(RunInfo, Frame, Option<TraceDelta>)> (the newest whole state, for keeping); subscribe() -> Subscription
                                // verify(artifact, operation); shutdown
pub mod simulation::{Command, RunInfo, FrameEvent, LiveComponent, PaintEvent, Frame, ComponentState, SimulationEvent, EndReason, EndedInfo, SimError, Code};
pub enum SymbolSource { Placed { location: Point, factory: String }, Made { library: Option<String>, name: String, attributes: BTreeMap<String, String> } }
pub struct ConnectionSeeds { components: Vec<(Point, String)>, wires: Vec<(Point, Point)>, point: Option<(Point, f64)> }  // by location and factory name; by both ends; ends within the radius
pub fn xml(tag, attrs, children) -> Element;  pub fn encode_xml(..);  pub fn xml_json(node) -> Value;
pub fn artifact_dependencies(artifact) -> Result<BTreeMap<PathBuf, String>>;  // external .circ/.jar libraries with digests
```

### Symbols

The window draws the editor picture itself; Java only says how each kind of component looks. `symbols` records `Component.draw` of one component per item into `RecordingGraphics2D`, a `Graphics2D` that paints nothing and writes each call as a vector op. `SymbolSource::Placed` names a component of the circuit by location and factory name (the host picks one whose library, name and attributes are the requested ones); `Made` builds one at (0, 0) from its library tool and attributes, as `template` does (placement ghosts, kinds not in the circuit); it sets every attribute the key names that the tool's set has, in passes until none is left (an attribute can appear only after another is set, like a gate's inputs or a splitter's bits), skipping read-only ones and keeping the tool's value for one this runtime cannot parse, because a key comes from a saved component or a template and a picture needs the same values, not the edit path's validation. The draw context is `CircuitRenderer`'s: print view, `showState` false, `showColor` true, the project's circuit state (a separate one for made components), each component on its own `g.create()` of a root with antialiasing on and black. The reply is JSON:

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

`connections` is what the editor's connection panel and signal tracing read: the part of an observation's focus that some chosen objects need, with the same ids and values as `observe` at that revision (`CircuitConnections`, in the bridge's `circuit` package to reuse `ExactRuntimeObserver.NetIndex`). Request children are the seeds: `<component x y factory/>` (every component of that factory at that location), `<wire x0 y0 x1 y1/>` (the wire between those points, either way round), `<point x y radius/>` (every component with an end that close). The bit nets read are those of every end of a seed component and of every bit of a seed wire's bundle. The reply is JSON:

```text
{"focus": {"components": [{componentId, factoryName, displayName?, selector?: {label}, location, bounds, partial?: true,
                           ends: [{index, location, width, direction, semanticRole?, runtimeTooltip?, netBits?: [{bit, netId}]}]}, …],
           "wires": [{wireId, from, to, bundleId}, …],
           "wireBundles": [{bundleId, valid, width, wireIds, bitNets: [{bit, netId}]}, …],
           "bitNets": [{netId, contacts: [{componentId, endIndex, bit}]}, …]}}
```

Seed components come whole: every end, with `netBits`. Every other component with an end on those nets comes `partial`, with only those ends and without `netBits` (the nets' `contacts` say which bit of which end is on which net). `wireBundles` are the seed wires' bundles and every bundle the nets pass through, `wires` the wires of those bundles. A circuit's index (nets, each net's contacts, each component's end nets, the components by place and the wires by ends) is built the first time a revision is asked about it and kept with the loaded project until it advances; a request only picks its part and writes it.

`width-errors` takes `<circuit name/>` children and answers `[[[x, y], …] | null, …]` in their order: each circuit's width-conflict points as `symbols` reports them, null for a circuit the file does not have. The host asks it for the circuits an edit, undo or redo changed and puts the points in its answer.

Java error texts are user-facing and the host passes them through unchanged, for example `组件库不在当前文件中: <id>`, `当前组件库没有这个可放置元件: <name>`, `请将整个元件放在画布的非负坐标区域`, `此位置与已有元件冲突，请换一个位置`, `此位置已有相同元件`, `不能放入自身或引用了当前电路的子电路`.

### The run

A run is one `CircuitSession` process on the revision's artifact and a start file (`<session circuit frequency?>` holding `<component id factory x y/>` for each component of the root circuit). The process holds the circuit state; nothing above it keeps another copy. Commands are one element per line: `toggle-clock`, `play`, `pause`, `tick`, `reset`, `toggle-propagation`, `step`, `configure {frequency?, automatic?}`, `poke`, `input`, `button`, `pulse`, `trace`, `trace-stop`, `memory`, `memory-write`, and `view` to show an instance (`<instance id factory x y/>` for each step of the path, `<component id factory x y/>` for each component of the shown circuit). The process reads them on one thread and answers each with an `<ack>` in the same order, carrying `commandSequence` (how many commands it has taken) or `error`/`code`/`message`; `run.rs` pairs acks with the waiting commands by order. Toggles read the process's own state, so a burst of them never acts on an old frame.

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

`run.rs` lays each frame over the run's newest state and sends it on as a `FrameEvent` with the same parts. Its picture (`PaintEvent`) groups wires and junctions by color as flat coordinate arrays and numbers the ops and op lists of that event from 0 (`ops`, `lists`; a changed component is the number of its list), so components that look alike cost one list. A subscription starts with the whole state (`run`, then a full `frame` built from the newest state, or the last `ended` when there is no run) and then gets every frame in order; one that falls behind starts over with the whole state. `Frame` is the newest state with components in Logisim's long form (`ComponentState`, ports with width, grouped bits and value), which a kept observation stores.

## Dependencies

`tokio` (processes), `xmltree`/`quick-xml`, `base64` (PNG data URLs), `serde_json`, `ts-rs`; `vibe-circuit-document` only for `DocumentView`/`Point` types. Java 17+ at build time, the bundled Temurin 21 at run time (`runtimes/java`).

## Invariants and Logisim pitfalls

- The bridge sources must compile against _any_ runtime a project may need, including the 2020 course build that has no `com.cburch.logisim.plugin` package. Every reference to an ITA-only class goes through reflection (see `NativeCircuitLoader.pluginAlias`). A direct import breaks course projects silently at class-load time.
- Jar dependencies are resolved by basename next to the file. The native path (`getFileFor`) lacked that resolution once and the headless worker popped up a Swing dialog and died; keep `NativeCircuitLoader.openChecked` as the single entry.
- `trigger=high` on `<comp>` in 2.7.1 files: the runtime drops the component without an error. `openChecked` re-reads the file and reports/repairs; do not bypass it.
- The bridge carries `com.cburch.logisim.circuit.WireRepair`: the ITA 2.16.2.2 class with a `doSplits` that looks up split points on each wire's row or column (within the 2 px `Wire.contains` accepts) instead of testing every point against every wire, which was most of the load time of a large file. Same points, same order, same loaded circuit. Bridge classes come first on the worker class path, so this copy replaces the class of both supported runtimes, which carry the same one. Before adding or upgrading a runtime, diff its `WireRepair` against this copy; `test:compatibility` loads a junction file on both runtimes.
- The worker is headless. Anything that could create a `JFrame` or dialog must be guarded; `java.awt.headless=true` is set by the launcher.
- One request at a time per worker. The registry holds a gate so simulation commands never wait behind editor observations.
- The worker keeps two loaded projects, keyed by artifact digest, each with one `Project` that every drawing and observation of it uses (a `Project` per request leaves listeners behind) and its latest four observation and connectivity replies, plus the `connections` index of each circuit asked about at the current revision. A new artifact goes to the kept project it differs least from: when the header and circuit list are byte-identical and only circuits' components and wires changed, `LoadedProject.advance` applies the change in place (components of vanished element text taken out, those of new text built by the runtime's reader after its version repairs, the wires made the new file's, one `CircuitTransaction`, which repairs wires and updates instance ports like an edit in Logisim). Anything else, a file that loaded with reports, or one older than 2.6.3, loads whole through `openChecked`. `test:compatibility` pins that a revision applied in place observes like a whole load; a change to how revisions are applied must keep that. A changed external library restarts the worker.
- A symbol is a function of the component's library, name and attributes, the project's libraries and, for a subcircuit, its definition; the window caches it under that key and drops subcircuit symbols when their circuit changes. What a painting reads besides that must stay out of it: the draw context shows no state (pins show the fresh project's value), connections go through `U`, and nothing in it depends on where the component sits. A painter that reads anything else (time, the circuit through `getCircuit()`) would make the window's picture differ from Logisim's; the bridge and the course jars were scanned for such reads when this was built.
- An observation measures text with a graphics context, which caches in the components; a circuit's reported `bounds` can grow by a few pixels after the project has been observed once. Compare observations of a project measured the same way.

## Status

Done; this is the code path every real-model turn already exercised. Costs on a 1 MB course file, release build: opening it loads it whole, 35–90 ms (preflight 7–24, Logisim 29–63); the first request on each later revision applies the edit in place, 3–7 ms; an observation of a 350-component page takes 30 ms and of a 700-component page 60–80 ms, a quarter of it writing 3.6 MB of JSON; connectivity 5–12 ms; `connections` on a 713-component page builds its index in 5–7 ms the first time a revision is asked, then answers in under a millisecond of worker time (3–72 KB); `width-errors` under 1 ms; a render of a 1400×900 viewport about 10 ms at scale 1 (drawing 6, PNG 2.5), 16 ms at 1.5 and 22 ms at 2; recording every kind of component on a 713-component page (369 kinds, 4269 ops, 174 KB of JSON) takes 10–14 ms once the worker has drawn before and about 0.7 s the first time (class loading). A run of that page: the whole picture is 79 KB of paint (999 wires, 1184 ops in 367 lists), recording a frame takes 2.5 ms (p50; 10 ms for a whole one, 0.26 s for the first frame of a new process), and a clock cycle changes 6–9 KB.

## Remaining tasks

- Done: observing proposed XML is the host's `observeXml`, which writes the proposal as an artifact and calls `observe_raw`; no Java change.
- `template` without `location` returns defaults only; `place_component` in the AI runtime wants bounds too and currently gets them. Keep that contract when touching `CircuitPalette.java`.

## Verify

```sh
npm run setup            # downloads the pinned runtimes into .workbench-cache
npm run test:native      # builds the host, runs scripts/workbench/verify.mts and simulation-controls-check.mts against real JVMs
npm run test:compatibility
crates/logisim-runtime/java/observer/run.sh --compact /abs/path/design.circ main 0 0 800 600   # observer alone
```
