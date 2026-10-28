# workbench-host

The one process that owns the user's workspace. The window (Tauri or the Vite dev page) and the AI sidecar both talk to it with the same JSON requests; nothing else touches the open documents, the folder, the Java runtime or the state directory. If a rule must hold no matter who is editing, it is enforced here, once, in `Host::respond`.

## Owns

- `lib.rs` `Host`: workspace (`vibe_circuit_document::Workspace`), the read-only Java worker (`Native`), the `SimulationRegistry`, the open `Folder`, document history, the AI sidecar handle, the event bus, the single-instance lock (`<state>/instance.lock`).
- `api/`: the request vocabulary, one file per domain (`document.rs`, `folder.rs`, `simulation.rs`, `agent.rs`, `app.rs`), each op declaring its `Meta` once: `effect` (Read / Write / AutoSave), the history action it records, its diagnostics stage, and whether the AI may call it. `error.rs` is the closed list of `ErrorCode`s with user-facing messages; `events.rs` the `Event` enum pushed to the window.
- `documents/`: what the host adds on top of the document crate because it needs Java: `movement.rs` (move preview and commit with wire dragging), `topology.rs` (net comparison before/after a move, from the worker's connectivity replies; a move that would change it fails with `ConnectionsChanged`, whose message names the first two ports it would join or separate by factory, label and position, `context {joined, ports: [[id, end], …]}`), `verification.rs` (test vectors and traces through the simulation verify worker), `interfaces/` (subcircuit interface editing with pin re-routing), `project_info.rs` (project summary and export), `history.rs` (document history entries with Java-observed snapshots), `snapshots.rs` (artifact files per revision for the Java workers).
- `folder/`: the project folder as the user sees it: `file_history.rs` (checkpoints of the whole folder, undo of a checkpoint), `file_references.rs` (bindings from documents to their source files, auto-save on edit, Save As), `recycle.rs` (trash), import of outside files.
- `simulation/observations.rs`: kept observations (screenshots and port values the user saved from a run).
- `agent/mod.rs`: spawning the Node sidecar, the JSONL protocol with it, forwarding its events, serving its host calls.
- `app/`: `diagnostics.rs` (failure counts by stage, export) and `feedback.rs` (update/feedback checks).
- `main.rs`: the dev transport (axum on loopback). `bin/export-contract.rs`: generates the TypeScript copies of every request, view and event type.

## Does not own

Rendering widgets, conversation history, model services, prompts, tools (sidecar), layout algorithms (arranger), file-format details (document crate), Logisim semantics (runtime crate).

## Public interface

```rust
let host = Host::new(root, state, runtime)?;          // root = resources dir, state = per-user state dir
host.respond(request).await -> Result<Reply, HostError>    // request: Request (untagged: Document | Folder | Simulation | Agent | App)
host.dispatch(request).await -> Result<Value, HostError>   // respond, as a value (in-process callers and tests)
host.events().await -> Events;  events.next().await -> Option<Event>   // Resync, then the run's whole state, then events in order
host.shutdown().await;
```

Request JSON is `{"op": "<name>", ...args}`; the window gets `{result}` or `{error: HostError{code, message, retryable, detail?}}`. `Reply` is a value, or for `observe`, `observeXml`, `symbols` and `connections` the worker's JSON text (`Reply::Text`), which the transports (dev HTTP, Tauri IPC, the sidecar's `hostResult`) write out as is: a course page's observation is megabytes and nothing in the host reads it. `observeXml` is `observe` of a proposed whole-file change: `{id, revision, circuit, xml}`, nothing applied.

`symbols {id, revision, circuit, symbols: [SymbolKey {library?, name, attributes}]}` is how the window gets the picture of each kind of component it draws: per key `{bounds, ink, ports, ops} | {error}` in request order, plus the circuit's `widthErrors`, as `crates/logisim-runtime/README.md` (Symbols) describes. A key is a component's library (none or empty for the file's circuits), name and complete attribute map as the document has them. The host records a component of `circuit` with exactly that key when there is one whose location and name no other component shares, and otherwise one made from the library tool (a placement ghost from `template`'s `comp`). Keys may be empty: the reply then carries only the width conflicts of that revision. Read, not for the AI.

`connections {id, revision, circuit, components: [id], wires: [id], point?: {x, y, radius}}` is what the connection panel and signal tracing read: the bit nets of those components and wires and of the component ends within `radius` of the point, with every end on them and the wire bundles and wires they pass through, in an observation's ids and fields (`{focus: {components, wires, wireBundles, bitNets}}`, `crates/logisim-runtime/README.md`, Connections). The host turns the document's ids into what the worker finds objects by (a component's location and factory name, a wire's ends) and leaves out ids the revision does not have. Read, not for the AI. Ops by domain:

| domain | ops |
| --- | --- |
| document | status open new import read activate source sourceStatus reload close save saveTarget edit movePreview undo redo observe observeXml symbols connections template properties catalog render simulate trace interfaceRead interfacePreview interfaceApply interfaceRender projectInfo projectExport projectExportTarget historyList historyReview historyPreview historyRestore |
| folder | folderOpen folderList folderRead folderPreview folderResolve folderCreate folderRename folderTrash folderImportPrepare folderImportApply folderImportCancel folderCheckpoint folderHistory folderHistoryDetail folderHistoryUndo |
| simulation | simulationStart simulationCommand simulationNavigate simulationStop memory memoryWrite observationList observationGet observationImage observationCapture observationRename observationDelete |
| agent | agent `{method, args}` → forwarded to the sidecar (see `packages/agent-runtime/README.md`) |
| app | feedbackStatus feedbackCheck feedbackPreference feedbackDismiss diagnostics diagnosticsExport |

Callable by the AI (`Meta::agent()`): folderRead folderList folderHistory folderCreate folderCheckpoint status read source sourceStatus saveTarget open new reload save edit undo redo observe observeXml template properties catalog render simulate trace interfaceRead interfacePreview interfaceApply historyList observationList observationGet observationImage. Anything else from the sidecar fails with `NotAllowed`.

`edit`, `undo` and `redo` answer `EditResult {change, revision, noop, title, circuit, changedCircuits, selection}`. `change` is a `DocumentChange`: the document's fields at the new revision, `base` (the revision the request was sent for), `order` (every circuit name in file order) and `circuits`, only the ones that changed. Applied to the view at `base` it gives the view at `revision`; `packages/agent-runtime/src/protocol/document-change.ts` (`applyDocumentChange`, `combineChanges`) does it for the window, the sidecar and the scripts, and a holder whose view is not at `base` reads the document again. Auto-save notes (`dirty`, `saveError`, `referenceWarning`) are set on `change`. `change.widthErrors` maps each changed circuit to its width-conflict points (`[[x, y], …]`, the wires the window draws orange), asked of the worker's `width-errors` at the new revision before answering; it is absent when the worker could not answer, and the window then asks `symbols`. `status {summary: true}` lists each open document as `DocumentSummary {id, name, path, revision, main, circuits: names}` instead of its whole view; the sidecar only asks for that.

`edit` with a batch resolves every place and attribute edit in it against the revision it was sent for (one Java load), refuses a move among other edits or a nested batch, and a placed part that would put an exclusive port on another new part's or repeat a new part at its location. A batch of moves only (parts moved by different offsets) plans and checks each move on the result of the one before, like a single move, and applies the last result as one change ("移动 N 个对象"); nothing moves when any is refused. The AI sends each tool call's edits as one batch.

Folder history: create, rename, trash and import are each one entry; `folderCheckpoint` records everything that changed since the folder's last entry (the AI calls it before and after each turn) and reads open documents of the changed files again (a clean one is reloaded with its previous content kept in undo history, a deleted one closes, one with unsaved changes stays as it is), as import and folder undo do; when that changed a document the window gets a `documents` event and reads the workspace again. `folderCreate {checkpoint: false}` leaves its file to the next checkpoint, so an AI turn that creates a file is one entry listing it as added.

The interactive run (`crates/logisim-runtime/README.md`, The run) has four requests, all addressed to the one run there is. `simulationStart {documentId, revision, circuit, frequency?}` ends the current run, starts one of that circuit at that revision and answers its `RunInfo` after the first frame. `simulationCommand {command}` and `simulationNavigate {instancePath}` answer `{commandSequence}` once the runtime took the command (`SESSION_ENDED` when there is no run); `simulationStop` ends the run. Replies never carry run state: the `simulation` events do, and the window counts a command as shown once a frame's `commandSequence` reaches the reply's. None of these changes a document; only `memoryWrite` (a ROM's stored words) does.

`observationCapture {title?, imageData?}` keeps the run's newest frame with its waveform and, when the window sends `imageData` (its canvas as a PNG data URL, at most 8 MB), that picture beside the record; `observationImage` of a record kept without one fails with 这条观察没有留存画面.

Events (`{topic, data}`): `agent` `{sequence, event}` from the sidecar; `simulation` (`run`, `frame`, `ended`; every subscription starts with the run's whole state); `resync` (snapshots may be stale, read again); `documents` (open documents were read again from their files or closed with them outside a window command, read the workspace again); `warning {message}` (a change took effect, something around it failed).

Transports: dev `POST /api/command`, `GET /api/events` (SSE), origin restricted to the Vite port; production Tauri `invoke("command")` and `invoke("events", {channel})`, which each page calls once for its own stream; a reloaded page gets a new one, starting with Resync and the run's whole state (`apps/workbench/src-tauri/src/main.rs`).

Environment: `VIBE_WORKBENCH_RESOURCES` (resources root; default: beside the executable), `VIBE_WORKBENCH_STATE` (state dir), `VIBE_WORKBENCH_PORT`, `VIBE_WORKBENCH_DEV_PORT`, `VIBE_WORKBENCH_TIMING=1` (one stderr line per window or AI request with its stages, see `vibe_logisim_runtime::timing`; `timing_label` names a request `op` or `edit.<kind>`); sidecar: `VIBE_LOGISIM_AGENT_ROOT`, `VIBE_LOGISIM_NODE`.

State directory: `instance.lock`, `session/` (open documents and journals), `folder.json`, `document-history/`, `snapshots/`, `observations/`, `file-imports/`, `file-references/`, `feedback.json`, `index.json`; the sidecar keeps `profile/` and `conversations.json` in the same directory.

## Rules enforced in `respond`

- Writes (effect Write or AutoSave) serialise on one gate; reads never wait. A write while recovery failed (`RecoveryFailed`) is refused.
- AutoSave ops write the document back to its source file when that file is inside the open folder; an edit that leaves the revision unchanged writes nothing and records no history.
- Every write ends with `persist` (crash-recovery records) and, if the op declares a history action, a document-history entry; a failed history write is reported as `historyWarning` on the result, never as a failure of the edit.
- `reconcile` runs after every request: a simulation whose document closed or moved to another revision is ended. There is no path that leaves a run of a changed document alive.
- Errors carry the user-facing text; the window shows `message` as is. New codes go into `ErrorCode` with their text, not into ad-hoc strings.

## Dependencies

`vibe-circuit-document`, `vibe-logisim-runtime`, `tokio`, `axum` (dev transport only), `reqwest` (update check), `zip` (project export), `serde`, `ts-rs`.

## Status

Done and exercised end to end on the course project (open, edit, AI turn, apply, save, reopen). 18 unit tests. The window draws the editor picture itself (`docs/rendering.md`): an edit's new picture, width conflicts included, needs the edit's answer and, when the edit made a kind of component the document has not drawn yet, one `symbols` request. Release build, p50 on the synthetic course-size pages (`scripts/workbench/editing-latency.mts`, 350 / 713 components): move 32 / 47, wire 19 / 23, place 25 / 27, delete 16 / 19, attributes 26 / 32 ms (4–10 ms of each answer brings the worker to the new revision for its width conflicts); a whole page's `symbols` 6 / 11 ms (220 / 446 kinds, 89 / 184 KB); a selection's `connections` 6 / 10 ms, 9 / 13 KB. On the course project's 713-component page in a browser, from input to the new picture on screen (measured before the width conflicts joined the answer): wire 36–39, delete 32–35, place 49, attributes 46–67, undo 43–44 ms, move 76–94 ms (drawn in place while dragging); opening the page is one `symbols` request of 175 KB answered in 11–28 ms.

## Remaining tasks

1. Done: `observeXml {id, revision, circuit, xml}` (agent-callable, Read) observes what `edit replace` with that whole-file XML would make of the revision (`Document::preview`), without applying it, and answers like `observe`. The file is written where the applied revision's file would go, so applying the same XML afterwards loads nothing new (on a 700-component page: 155 ms for the proposal, then 45 ms for the replace and 24 ms for the next observe). The AI arranger verifies with it before applying.
2. Done: an edit no longer reloads the file in Java or answers with the whole document. The worker applies each new revision to the project it holds, re-reading only the circuits whose element text changed (`crates/logisim-runtime/README.md`), and `edit`, `undo` and `redo` answer with the changed circuits only (`DocumentChange`); the sidecar reads `status {summary: true}`. Release build, p50 from sending the edit to the new picture: on the synthetic course-size page (350 components, `scripts/workbench/editing-latency.mts`) move 60, wire 45, place 56, delete 44, attributes 53 ms (before: 125, 104, 110, 59, 109); on a page of about 700 components and 1000 wires move 79, wire 51, place 55, delete 48, attributes 58 ms (before: 150, 104, 135, 63, 118).
3. Started, not finished. Move refusals out of ad-hoc strings: `documents/topology.rs` returns `Result<_, String>`, so a move the runtime cannot check (incomplete native load, overlapping components, out-of-range coordinates, missing bit nets) reaches the caller as `UNKNOWN`, and `documents/movement.rs` still maps each document error back to a string (`.map_err(|e| e.to_string())`, a bare `Err("文档位置已改变…".into())`). Intended: topology returns `crate::Result` with `RuntimeUnavailable` (incomplete load), `ComponentAmbiguous` (overlap), `InvalidCommand` (coordinates) and `Internal` (missing bit nets); movement drops the `.map_err` where it returns `Result<_, HostError>` and gives the changed-path refusal `StaleRevision`. `topology::preserved` already answers `CONNECTIONS_CHANGED` with hint and context, so only the check-before-the-check paths are left. The same cleanup is pending across the rest of `crates/workbench-host/src` (187 sites at the last count, e.g. `lib.rs::snapshot`, `documents/history.rs`).

4. Next: `connect` sends a delete-and-place prelude and the routed wires as two batches, so one call is two undo steps and a failed join check takes back only the wires. Intended shape: route against a view that already has the prelude applied without applying it (the `Document::preview` path `observeXml` uses, generalized to an `observe {edits}` or a batch preview), then send prelude and wires as one batch. `Document::edit`'s wire selection (`old_wires..count`) assumes nothing was deleted in the same batch, so the added wires would have to be diffed by geometry, as `movement.rs::new_wires` does.

## Verify

```sh
cargo test -p vibe-workbench-host
npm run check:contracts          # generated TS matches the Rust types
npm run test:native              # real JVM: editing, run picture and simulation scenarios
npm run test:files  && npm run test:history && npm run test:interfaces
```
