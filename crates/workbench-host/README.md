# workbench-host

The one process that owns the user's workspace. The window (Tauri or the Vite dev page) and the AI sidecar both talk to it with the same JSON requests; nothing else touches the open documents, the folder, the Java runtime or the state directory. If a rule must hold no matter who is editing, it is enforced here, once, in `Host::respond`.

## Owns

- `lib.rs` `Host`: workspace (`vibe_circuit_document::Workspace`), the read-only Java worker (`Native`, which the host hands each request's `Revision` from memory; nothing is written to disk for it), the `SimulationRegistry`, the open `Folder`, document history, the AI sidecar handle, the event bus, the single-instance lock (`<state>/instance.lock`).
- `api/`: the request vocabulary, one file per domain (`document.rs`, `folder.rs`, `simulation.rs`, `agent.rs`, `app.rs`), each op declaring its `Meta` once: `effect` (Read / Write / AutoSave), the history action it records, its diagnostics stage, and whether the AI may call it. `error.rs` is the closed list of `ErrorCode`s with user-facing messages; `events.rs` the `Event` enum pushed to the window.
- `documents/files.rs`: the open documents follow their files (see *Files are the truth*): one stat per document per entry, a read only when the file moved, a clean document reloaded in place, a dirty one left as it is, the result broadcast as `change` and `source` events. `restamp` records what the host itself just wrote, so its own saves are not read back.
- `documents/`: what the host adds on top of the document crate because it needs Java: `movement.rs` (a move as Logisim's select tool makes it: the worker's `MoveGesture` answer applied with the translation as one edit), `verification.rs` (test vectors and traces through the simulation verify worker), `interfaces/` (subcircuit interface editing with pin re-routing), `project_info.rs` (project summary and export), `history.rs` (document history entries and pictures of past revisions).
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

`connections {id, revision, circuit, components: [id], wires: [id], point?: {x, y, radius}}` is what the connection panel and signal tracing read: the bit nets of those components and wires and of the component ends within `radius` of the point, with every end on them and the wire bundles and wires they pass through, in an observation's ids and fields (`{focus: {components, wires, wireBundles, bitNets}}`, `crates/logisim-runtime/README.md`, Connections). The worker knows the document's ids, so they go to it as they are and every record it answers carries them. Read, not for the AI. Ops by domain:

| domain | ops |
| --- | --- |
| document | status open new import read activate source sourceStatus reload close save saveTarget edit movePreview undo redo observe observeXml symbols connections template properties catalog render simulate trace interfaceRead interfacePreview interfaceApply interfaceRender projectInfo projectExport projectExportTarget historyList historyReview historyPreview historyRestore |
| folder | folderOpen folderList folderRead folderPreview folderResolve folderCreate folderRename folderTrash folderImportPrepare folderImportApply folderImportCancel folderCheckpoint folderHistory folderHistoryDetail folderHistoryUndo |
| simulation | simulationStart simulationCommand simulationNavigate simulationStop memory memoryWrite observationList observationGet observationImage observationCapture observationRename observationDelete |
| agent | agent `{method, args}` → forwarded to the sidecar (see `packages/agent-runtime/README.md`) |
| app | feedbackStatus feedbackCheck feedbackPreference feedbackDismiss diagnostics diagnosticsExport |

Callable by the AI (`Meta::agent()`): folderRead folderList folderHistory folderCreate folderCheckpoint status read source sourceStatus saveTarget open new reload save edit undo redo observe observeXml template properties catalog render simulate trace interfaceRead interfacePreview interfaceApply historyList observationList observationGet observationImage. Anything else from the sidecar fails with `NotAllowed`.

`edit`, `undo` and `redo` answer `EditResult {change, revision, noop, title, circuit, changedCircuits, selection, unconnected}` (`unconnected`: where a move left an end unconnected, before the move; empty for other edits). `change` is a `DocumentChange`: the document's fields at the new revision, `base` (the revision the request was sent for), `order` (every circuit name in file order) and `circuits`, only the ones that changed. Applied to the view at `base` it gives the view at `revision`; `apps/workbench/src/workspace/documents.ts` (`applyChange`) does it for the window and reads the document again when its view is not at `base`. Auto-save notes (`dirty`, `saveError`, `referenceWarning`) are set on `change`. `change.widthErrors` maps each changed circuit to its width-conflict points (`[[x, y], …]`, the wires the window draws orange), asked of the worker's `width-errors` at the new revision before answering; it is absent when the worker could not answer, and the window then asks `symbols`. `status {summary: true}` lists each open document as `DocumentSummary {id, name, path, revision, main, circuits: names}` instead of its whole view; the sidecar only asks for that. `read {id, circuits?}` answers the document's whole view (`DocumentView`), or with `circuits` its fields plus only those definitions' content — a `DocumentChange` at the document's own revision; `circuits: []` is the fields alone. That is the one bookkeeping read a tool call makes. Writes broadcast a `change` only for documents whose view changed (`Document::same_view`).

`edit` with `move {ids, delta, detach?}` is Logisim's move: the worker runs `MoveGesture.forceRequest` on the revision the edit was sent for, and the host applies the translation with the wires the gesture removes and adds as one change ("移动 N 个对象", the moved parts and the added wires selected). An end dropped onto a wire or a port connects there and one dragged away keeps its connection through the added wires, as in Logisim; `detach` (Logisim's shift-drag) moves without keeping connections. `movePreview {id, revision, circuit, ids, delta}` is the same gesture's answer without applying it (`MovePreview {removed, added, unconnected}`), what the canvas draws while dragging; nothing waits for it.

`edit` with a batch resolves every place and attribute edit in it against the revision it was sent for (one Java request), refuses a move among other edits or a nested batch, and a placed part that would put an exclusive port on another new part's or repeat a new part at its location. A batch of moves only (parts moved by different offsets) resolves each move's gesture on the result of the one before and applies the last result as one change ("移动 N 个对象"). The AI sends each tool call's edits as one batch.

Files are the truth. A document is a cache of its file: every `document` and `folder` request first looks at the open documents' files (`documents/files.rs`, one `stat` each, a read only when mtime or size moved), and after a folder write it looks again and closes clean documents whose file the write removed. A clean document whose file changed is reloaded in place — the content it was showing goes into undo history as `读取磁盘版本`, so the user can get their draft back — and the change is broadcast. A document with unsaved changes is never overwritten: its file's state becomes `modified` (or `missing`, `unreadable`), the window shows it beside the document, and an edit to it changes only the draft: its auto-save is refused (`saveError`, the file keeps the newer bytes). An AI request on a document whose file changed to content that does not load fails with `InvalidDocument`, so its tools do not go on with what the file no longer holds. `sourceStatus` answers the last look rather than reading again. This is also why the window polls nothing: the files it shows were checked by whatever request it just made, and it asks `sourceStatus` when the window regains focus.

Folder history: create, rename, trash and import are each one entry; `folderCheckpoint` records everything that changed since the folder's last entry (the AI calls it before and after each turn). It does not read documents: a folder write is followed by the same entry look every other request gets, which reloads a clean document whose file it changed and closes one whose file it removed. `folderCreate {checkpoint: false}` leaves its file to the next checkpoint, so an AI turn that creates a file is one entry listing it as added.

The interactive run (`crates/logisim-runtime/README.md`, The run) has four requests, all addressed to the one run there is. `simulationStart {documentId, revision, circuit, frequency?}` ends the current run, starts one of that circuit at that revision and answers its `RunInfo` after the first frame. `simulationCommand {command}` and `simulationNavigate {instancePath}` answer `{commandSequence}` once the runtime took the command (`SESSION_ENDED` when there is no run); `simulationStop` ends the run. Replies never carry run state: the `simulation` events do, and the window counts a command as shown once a frame's `commandSequence` reaches the reply's. None of these changes a document; only `memoryWrite` (a ROM's stored words) does.

`observationCapture {title?, imageData?}` keeps the run's newest frame with its waveform and, when the window sends `imageData` (its canvas as a PNG data URL, at most 8 MB), that picture beside the record; `observationImage` of a record kept without one fails with 这条观察没有留存画面.

Events (`{topic, data}`): `agent` `{sequence, event}` from the sidecar; `simulation` (`run`, `frame`, `ended`; every subscription starts with the run's whole state); `resync` (snapshots may be stale, read again); `change` (a `DocumentChange` to apply at its `base`: the AI's edits, undos and redos, reloads from disk, any document another request changed; the window's own change arrives in its reply instead and is not repeated); `source {id, status}` (an open document's file state changed: the file moved, it could not be loaded, it is gone); `workspace {documents: [DocumentSummary], active}` (documents were opened or closed outside a window command, and which one is active); `warning {message}` (a change took effect, something around it failed).

Transports: dev `POST /api/command`, `GET /api/events` (SSE), origin restricted to the Vite port; production Tauri `invoke("command")` and `invoke("events", {channel})`, which each page calls once for its own stream; a reloaded page gets a new one, starting with Resync and the run's whole state (`apps/workbench/src-tauri/src/main.rs`).

Environment: `VIBE_WORKBENCH_RESOURCES` (resources root; default: beside the executable), `VIBE_WORKBENCH_STATE` (state dir), `VIBE_WORKBENCH_PORT`, `VIBE_WORKBENCH_DEV_PORT`, `VIBE_WORKBENCH_TIMING=1` (one stderr line per window or AI request with its stages, see `vibe_logisim_runtime::timing`; `timing_label` names a request `op` or `edit.<kind>`); sidecar: `VIBE_LOGISIM_AGENT_ROOT`, `VIBE_LOGISIM_NODE`.

State directory: `instance.lock`, `session/` (open documents and journals), `folder.json`, `document-history/`, `observations/`, `file-imports/`, `file-references/`, `feedback.json`, `index.json`; the sidecar keeps `profile/` and `conversations.json` in the same directory.

## Rules enforced in `respond`

- Writes (effect Write or AutoSave) serialise on one gate; reads never wait. A write while recovery failed (`RecoveryFailed`) is refused.
- AutoSave ops write the document back to its source file when that file is inside the open folder; an edit that leaves the revision unchanged writes nothing and records no history.
- Every write ends with `persist` (crash-recovery records) and, if the op declares a history action, a document-history entry; a failed history write is reported as `historyWarning` on the result, never as a failure of the edit.
- `reconcile` runs after every request: a simulation whose document closed or moved to another revision is ended. There is no path that leaves a run of a changed document alive.
- Errors carry the user-facing text; the window shows `message` as is. New codes go into `ErrorCode` with their text, not into ad-hoc strings.

## Dependencies

`vibe-circuit-document`, `vibe-logisim-runtime`, `tokio`, `axum` (dev transport only), `reqwest` (update check), `zip` (project export), `serde`, `ts-rs`.

## Status

Done and exercised end to end on the course project (open, edit, AI turn, apply, save, reopen). 18 unit tests. The window draws the editor picture itself (`docs/rendering.md`): an edit's new picture, width conflicts included, needs the edit's answer and, when the edit made a kind of component the document has not drawn yet, one `symbols` request. Release build, p50 on the synthetic 713-component page (`scripts/workbench/editing-latency.mts 5 core_c`): move 26, wire 21, place 23, delete 20, attributes 22 ms (debug build 34 / 24 / 27 / 24 / 27; before revisions were pushed to the worker from memory: 174 / 44 / 53 / 38 / 59); a whole page's `symbols` 11 ms (446 kinds, 184 KB); a selection's `connections` 6 / 10 ms, 9 / 13 KB. On the course project's 713-component page in a browser, from input to the new picture on screen: wire 36–39, delete 32–35, place 49, attributes 46–67, undo 43–44 ms (measured before the width conflicts joined the answer), move 64 ms from release to the new picture (the move request itself 28 ms; drawn in place while dragging, three `movePreview` requests per drag, at most one in flight); opening the page is one `symbols` request of 175 KB answered in 11–28 ms. No `state/snapshots/` directory is written any more.

## Remaining tasks

1. Done: `observeXml {id, revision, circuit, xml}` (agent-callable, Read) observes what `edit replace` with that whole-file XML would make of the revision (`Document::preview`), without applying it, and answers like `observe`. The proposal goes to the worker as the document's next revision, so applying the same XML afterwards sends nothing new. The AI arranger verifies with it before applying.
2. Done: an edit no longer reloads the file in Java or answers with the whole document. Rust sends the worker each new revision's per-circuit difference with the request that needs it (`Revision::changes`, `crates/logisim-runtime/README.md`), and `edit`, `undo` and `redo` answer with the changed circuits only (`DocumentChange`); the sidecar reads `status {summary: true}`. Numbers from before the difference came from Rust: Release build, p50 from sending the edit to the new picture: on the synthetic course-size page (350 components, `scripts/workbench/editing-latency.mts`) move 60, wire 45, place 56, delete 44, attributes 53 ms (before: 125, 104, 110, 59, 109); on a page of about 700 components and 1000 wires move 79, wire 51, place 55, delete 48, attributes 58 ms (before: 150, 104, 135, 63, 118).
3. Ad-hoc string errors: much of `crates/workbench-host/src` still returns `Result<_, String>` (167 `map_err(|e| e.to_string())` sites, e.g. `lib.rs::revision_at`, `documents/history.rs`), which reaches the caller as `UNKNOWN`. Give each failure its `ErrorCode` where it is made.

4. Done: `observeEdits` previews a proposed batch through the same native resolution as an edit. `connect` routes against the proposed prelude, checks the complete netlist, and submits everything as one batch. Failed previews leave the file and undo history untouched. New wire selections compare endpoint pairs, including batches that delete existing wires.

## Verify

```sh
cargo test -p vibe-workbench-host
npm run check:contracts          # generated TS matches the Rust types
npm run test:native              # real JVM: editing, run picture and simulation scenarios
npm run test:files  && npm run test:history && npm run test:interfaces
```
