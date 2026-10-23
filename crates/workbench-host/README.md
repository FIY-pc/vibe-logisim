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
host.events().await -> Events;  events.next().await -> Option<Event>   // first event is always Resync
host.shutdown().await;
```

Request JSON is `{"op": "<name>", ...args}`; the window gets `{result}` or `{error: HostError{code, message, retryable, detail?}}`. `Reply` is a value, or for `observe` and `observeXml` the worker's JSON text (`Reply::Text`), which the transports (dev HTTP, Tauri IPC, the sidecar's `hostResult`) write out as is: a course page's observation is megabytes and nothing in the host reads it. `observeXml` is `observe` of a proposed whole-file change: `{id, revision, circuit, xml}`, nothing applied. Ops by domain:

| domain | ops |
| --- | --- |
| document | status open new import read activate source sourceStatus reload close save saveTarget edit movePreview undo redo observe observeXml template properties catalog render simulate trace interfaceRead interfacePreview interfaceApply interfaceRender projectInfo projectExport projectExportTarget historyList historyReview historyPreview historyRestore |
| folder | folderOpen folderList folderRead folderPreview folderResolve folderCreate folderRename folderTrash folderImportPrepare folderImportApply folderImportCancel folderCheckpoint folderHistory folderHistoryDetail folderHistoryUndo |
| simulation | simulationAct simulationNavigate simulationViewport simulationStop simulationStatus simulationSnapshot simulationFrameImage memory memoryWrite observationList observationGet observationImage observationCapture observationRename observationDelete |
| agent | agent `{method, args}` → forwarded to the sidecar (see `packages/agent-runtime/README.md`) |
| app | feedbackStatus feedbackCheck feedbackPreference feedbackDismiss diagnostics diagnosticsExport |

Callable by the AI (`Meta::agent()`): folderRead folderList folderHistory folderCreate folderCheckpoint status read source sourceStatus saveTarget open new save edit undo redo observe observeXml template properties catalog render simulate trace interfaceRead interfacePreview interfaceApply historyList observationList observationGet observationImage. Anything else from the sidecar fails with `NotAllowed`.

Events (`{topic, data}`): `agent` `{sequence, event}` from the sidecar; `simulation` (session, frames, end); `resync` (snapshots may be stale, read again); `warning {message}` (a change took effect, something around it failed).

Transports: dev `POST /api/command`, `GET /api/events` (SSE), origin restricted to the Vite port; production Tauri `invoke("command")` and the `workbench-event` window event (`apps/workbench/src-tauri/src/main.rs`).

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

Done and exercised end to end on the course project (open, edit, AI turn, apply, save, reopen). 18 unit tests. On a course-size page (350 components, 374 wires; `scripts/workbench/editing-latency.mts`, release build, p50) an edit is answered in 30–45 ms and a move in about 90 ms; the canvas shows the new picture 60–120 ms after sending the edit, and the observation follows 20–50 ms later. On a page twice that size (about 700 components and 1000 wires; production window) the picture is on screen about 130 ms after releasing a wire and 210 ms after releasing a moved component.

## Remaining tasks

1. Done: `observeXml {id, revision, circuit, xml}` (agent-callable, Read) observes what `edit replace` with that whole-file XML would make of the revision (`Document::preview`), without applying it, and answers like `observe`. The file is written where the applied revision's file would go, so applying the same XML afterwards loads nothing new (on a 700-component page: 155 ms for the proposal, then 45 ms for the replace and 24 ms for the next observe). The AI arranger verifies with it before applying.
2. Edit latency, what is left (release numbers above; measure with `scripts/workbench/editing-latency.mts`). Every edit's first Java request loads the whole new revision: the connectivity check of a move (50 of its 90 ms: preflight 7, Logisim load 29, connectivity 5) and the render after any other edit (35 of its 65 ms); on a 700-component page the load is 45–90 ms. Loading only the edited circuit into a copy of the previous revision's loaded file would remove most of it; it needs a partial reader that compiles against both runtimes and keeps `openChecked`'s coverage check. Every edit answers with the whole document view, built as a `Value`, then written as text (`edit.view`, `edit.value`, `encode`: 14 ms); answering with the edited circuit only would cut it. After a move the window's observe is computed afresh (the move asked only for connectivity): 30 ms on a 350-component page, 75 ms on a 700-component one, after the picture is up.
3. Replace the remaining `.map_err(|e| e.to_string())?` with `?` where the function already returns `Result<_, HostError>` (`grep -rn 'map_err(|e| e.to_string())' crates/workbench-host/src`).

## Verify

```sh
cargo test -p vibe-workbench-host
npm run check:contracts          # generated TS matches the Rust types
npm run test:native              # real JVM: editing, viewport and simulation scenarios
npm run test:files  && npm run test:history && npm run test:interfaces
```
