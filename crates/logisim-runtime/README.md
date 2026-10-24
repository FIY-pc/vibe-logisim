# logisim-runtime

The Java side of the product, driven from Rust: the real Logisim runtime loads the file, says which pins exist and where, what is electrically connected, renders the picture, and runs the simulation. Nothing in Rust or TypeScript re-implements Logisim semantics; when a question is "what would Logisim do", it is answered here by asking Logisim.

## Owns

- `runtime.rs`: which Logisim jar to use (`RuntimeFacts::runtime_for(source)` picks the compatible runtime per file: Logisim-ITA 2.16 or the 2020 course build, both pinned in `config/runtime-lock.json`), Java discovery, the bridge class cache keyed by jar and source digests, and `Launcher` (how to start a worker).
- `process.rs`: child process plumbing, UTF-8 on Windows, bounded stderr capture for diagnostics.
- `lib.rs` (`Native`): the long-lived read-only worker and its request protocol. One request = one XML element in, XML bytes out, translated to JSON with `xml_json(node) = {tag, attributes, text, children}`. The worker answers each request with one line, `status\tbase64[\tphases]`; the third field appears only when timing is on. Its first reply is the handshake `ready <runtime version>`, which is where `observed_version` comes from; replies themselves are not parsed for a version. `Native` remembers each artifact's and library's digest, top-level libraries and `source` version, and reads a file again only when its size, modification time or (Unix) inode or change time differ; a request on a known revision reads nothing.
- `timing.rs`: opt-in per-request stage timing for the host (`scope`, `span`). With `VIBE_WORKBENCH_TIMING=1` the host prints `timing <op> <total>ms <stage>=<ms> …` per request on stderr; the worker inherits the variable and reports its phases (`WorkerTiming.java`), recorded as `java.<phase>`. Unset, nothing is collected or printed.
- `simulation/`: the interactive run. `registry.rs` owns the single current run and a separate verification worker; `session.rs` is one JVM session; `protocol.rs` the wire format; `model.rs` the typed events (`Frame`, `Command`, `Status`, `Snapshot`, …, all `ts_rs` exported for the UI); `error.rs` the stable error codes.
- `java/native/com/cburch/logisim/file/*.java`: the bridge compiled against whatever jar the project needs (`CircuitWorker` request loop, `LoadedProject` a project the worker keeps and advances revision by revision, `FileLayout` the byte layout of a project file it compares revisions by, `NativeCircuitLoader`, `CircuitPalette` catalog/template/placement, `CircuitObjects` attribute reads, `CircuitInterface` pin description, `CircuitRenderer`, `PngEncoder` (every picture sent to the window: canvas, simulation frames, palette icons; unfiltered rows at the fastest deflate level, about a fifth of ImageIO's time for a file half again as large), `CircuitSession*` simulation, `CircuitTrace`, `CircuitWorkbench` pin-vector and trace batches for the verification worker). The worker answers exactly the request kinds `lib.rs` sends; a new kind is added on both sides at once.
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
    async fn render(&mut self, artifact, circuit, Viewport{x,y,width,height,scale}) -> Result<String>; // PNG data URL; scale ≤ 8, area ≤ 8 M px
    async fn request(&mut self, artifact, operation: Element) -> Result<Vec<u8>>;                // raw escape hatch
    fn status(&self) -> Value;  fn observed_version(&self) -> Option<&str>;  async fn shutdown(&mut self);
}
pub struct SimulationRegistry;  // new(launcher); act(target, command) ; navigate ; stop ; end ; reconcile ; session ; status ; snapshot ; frame_image ; subscribe() -> Subscription ; verify(artifact, operation) ; shutdown
pub mod simulation::{Command, RunTarget, Frame, Snapshot, Status, SimulationEvent, ActResult, NavigateResult, EndReason, SimError, Code};
pub fn xml(tag, attrs, children) -> Element;  pub fn encode_xml(..);  pub fn xml_json(node) -> Value;
pub fn artifact_dependencies(artifact) -> Result<BTreeMap<PathBuf, String>>;  // external .circ/.jar libraries with digests
```

Java error texts are user-facing and the host passes them through unchanged, for example `组件库不在当前文件中: <id>`, `当前组件库没有这个可放置元件: <name>`, `请将整个元件放在画布的非负坐标区域`, `此位置与已有元件冲突，请换一个位置`, `此位置已有相同元件`, `不能放入自身或引用了当前电路的子电路`.

## Dependencies

`tokio` (processes), `xmltree`/`quick-xml`, `base64` (PNG data URLs), `serde_json`, `ts-rs`; `vibe-circuit-document` only for `DocumentView`/`Point` types. Java 17+ at build time, the bundled Temurin 21 at run time (`runtimes/java`).

## Invariants and Logisim pitfalls

- The bridge sources must compile against _any_ runtime a project may need, including the 2020 course build that has no `com.cburch.logisim.plugin` package. Every reference to an ITA-only class goes through reflection (see `NativeCircuitLoader.pluginAlias`). A direct import breaks course projects silently at class-load time.
- Jar dependencies are resolved by basename next to the file. The native path (`getFileFor`) lacked that resolution once and the headless worker popped up a Swing dialog and died; keep `NativeCircuitLoader.openChecked` as the single entry.
- `trigger=high` on `<comp>` in 2.7.1 files: the runtime drops the component without an error. `openChecked` re-reads the file and reports/repairs; do not bypass it.
- The bridge carries `com.cburch.logisim.circuit.WireRepair`: the ITA 2.16.2.2 class with a `doSplits` that looks up split points on each wire's row or column (within the 2 px `Wire.contains` accepts) instead of testing every point against every wire, which was most of the load time of a large file. Same points, same order, same loaded circuit. Bridge classes come first on the worker class path, so this copy replaces the class of both supported runtimes, which carry the same one. Before adding or upgrading a runtime, diff its `WireRepair` against this copy; `test:compatibility` loads a junction file on both runtimes.
- The worker is headless. Anything that could create a `JFrame` or dialog must be guarded; `java.awt.headless=true` is set by the launcher.
- One request at a time per worker. The registry holds a gate so simulation commands never wait behind editor observations.
- The worker keeps two loaded projects, keyed by artifact digest, each with one `Project` that every drawing and observation of it uses (a `Project` per request leaves listeners behind) and its latest four observation and connectivity replies. A new artifact goes to the kept project it differs least from: when the header and circuit list are byte-identical and only circuits' components and wires changed, `LoadedProject.advance` applies the change in place (components of vanished element text taken out, those of new text built by the runtime's reader after its version repairs, the wires made the new file's, one `CircuitTransaction`, which repairs wires and updates instance ports like an edit in Logisim). Anything else, a file that loaded with reports, or one older than 2.6.3, loads whole through `openChecked`. `test:compatibility` pins that a revision applied in place observes like a whole load; a change to how revisions are applied must keep that. A changed external library restarts the worker.
- An observation measures text with a graphics context, which caches in the components; a circuit's reported `bounds` can grow by a few pixels after the project has been observed once. Compare observations of a project measured the same way.

## Status

Done; this is the code path every real-model turn already exercised. Costs on a 1 MB course file, release build: opening it loads it whole, 35–90 ms (preflight 7–24, Logisim 29–63); the first request on each later revision applies the edit in place, 3–7 ms; an observation of a 350-component page takes 30 ms and of a 700-component page 60–80 ms, a quarter of it writing 3.6 MB of JSON; connectivity 5–12 ms; a render of a 1400×900 viewport about 10 ms at scale 1 (drawing 6, PNG 2.5), 16 ms at 1.5 and 22 ms at 2.

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
