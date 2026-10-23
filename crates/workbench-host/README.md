# workbench-host

The one process that owns the user's workspace. The window (Tauri or the Vite dev page) and the AI sidecar both talk to it with the same JSON requests; nothing else touches the open documents, the folder, the Java runtime or the state directory. If a rule must hold no matter who is editing, it is enforced here, once, in `Host::dispatch`.

## Owns

- `lib.rs` `Host`: workspace (`vibe_circuit_document::Workspace`), the read-only Java worker (`Native`), the `SimulationRegistry`, the open `Folder`, document history, the AI sidecar handle, the event bus, the single-instance lock (`<state>/instance.lock`).
- `api/`: the request vocabulary, one file per domain (`document.rs`, `folder.rs`, `simulation.rs`, `agent.rs`, `app.rs`), each op declaring its `Meta` once: `effect` (Read / Write / AutoSave), the history action it records, its diagnostics stage, and whether the AI may call it. `error.rs` is the closed list of `ErrorCode`s with user-facing messages; `events.rs` the `Event` enum pushed to the window.
- `documents/`: what the host adds on top of the document crate because it needs Java: `movement.rs` (move preview and commit with wire dragging), `topology.rs` (net comparison before/after an edit), `verification.rs` (test vectors and traces through the simulation verify worker), `interfaces/` (subcircuit interface editing with pin re-routing), `project_info.rs` (project summary and export), `history.rs` (document history entries with Java-observed snapshots), `snapshots.rs` (artifact files per revision for the Java workers).
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
host.dispatch(request).await -> Result<Value, HostError>   // request: Request (untagged: Document | Folder | Simulation | Agent | App)
host.events().await -> Events;  events.next().await -> Option<Event>   // first event is always Resync
host.shutdown().await;
```

Request JSON is `{"op": "<name>", ...args}`; the window gets `{result}` or `{error: HostError{code, message, retryable, detail?}}`. Ops by domain:

| domain | ops |
| --- | --- |
| document | status open new import read activate source sourceStatus reload close save saveTarget edit movePreview undo redo observe template properties catalog render simulate trace interfaceRead interfacePreview interfaceApply interfaceRender projectInfo projectExport projectExportTarget historyList historyReview historyPreview historyRestore |
| folder | folderOpen folderList folderRead folderPreview folderResolve folderCreate folderRename folderTrash folderImportPrepare folderImportApply folderImportCancel folderCheckpoint folderHistory folderHistoryDetail folderHistoryUndo |
| simulation | simulationAct simulationNavigate simulationViewport simulationStop simulationStatus simulationSnapshot simulationFrameImage memory memoryWrite observationList observationGet observationImage observationCapture observationRename observationDelete |
| agent | agent `{method, args}` → forwarded to the sidecar (see `packages/agent-runtime/README.md`) |
| app | feedbackStatus feedbackCheck feedbackPreference feedbackDismiss diagnostics diagnosticsExport |

Callable by the AI (`Meta::agent()`): folderRead folderList folderHistory folderCreate folderCheckpoint status read source sourceStatus saveTarget open new save edit undo redo observe template properties catalog render simulate trace interfaceRead interfacePreview interfaceApply historyList observationList observationGet observationImage. Anything else from the sidecar fails with `NotAllowed`.

Events (`{topic, data}`): `agent` `{sequence, event}` from the sidecar; `simulation` (session, frames, end); `resync` (snapshots may be stale, read again); `warning {message}` (a change took effect, something around it failed).

Transports: dev `POST /api/command`, `GET /api/events` (SSE), origin restricted to the Vite port; production Tauri `invoke("command")` and the `workbench-event` window event (`apps/workbench/src-tauri/src/main.rs`).

Environment: `VIBE_WORKBENCH_RESOURCES` (resources root; default: beside the executable), `VIBE_WORKBENCH_STATE` (state dir), `VIBE_WORKBENCH_PORT`, `VIBE_WORKBENCH_DEV_PORT`; sidecar: `VIBE_LOGISIM_AGENT_ROOT`, `VIBE_LOGISIM_NODE`.

State directory: `instance.lock`, `session/` (open documents and journals), `folder.json`, `document-history/`, `snapshots/`, `observations/`, `file-imports/`, `file-references/`, `feedback.json`, `index.json`; the sidecar keeps `profile/` and `conversations.json` in the same directory.

## Rules enforced in `dispatch`

- Writes (effect Write or AutoSave) serialise on one gate; reads never wait. A write while recovery failed (`RecoveryFailed`) is refused.
- AutoSave ops write the document back to its source file when that file is inside the open folder; an edit that leaves the revision unchanged writes nothing and records no history.
- Every write ends with `persist` (crash-recovery records) and, if the op declares a history action, a document-history entry; a failed history write is reported as `historyWarning` on the result, never as a failure of the edit.
- `reconcile` runs after every request: a simulation whose document closed or moved to another revision is ended. There is no path that leaves a run of a changed document alive.
- Errors carry the user-facing text; the window shows `message` as is. New codes go into `ErrorCode` with their text, not into ad-hoc strings.

## Dependencies

`vibe-circuit-document`, `vibe-logisim-runtime`, `tokio`, `axum` (dev transport only), `reqwest` (update check), `zip` (project export), `serde`, `ts-rs`.

## Status

Done and exercised end to end on the course project (open, edit, AI turn, apply, save, reopen). 17 unit tests. Known cost: a move on the 1 MB course file takes about 900 ms because topology is observed twice through Java; wiring 600 ms. The agreed direction is fewer Java↔Rust↔Node hops per edit, not another cache.

## Remaining tasks

1. `observeXml` op (agent-callable, Read): take `{documentId, circuit, xml}`, write a scratch artifact, run `Native::observe` on it, return the same shape as `observe`. Needed so the AI arranger can verify a layout before applying it instead of apply-verify-undo. See `packages/agent-runtime/src/tools/arrange.mts` `TODO(arrange)`. Reuse `documents/topology.rs::ports` for the comparison.
2. Edit latency: `documents/movement.rs` observes before and after; a single observe after the edit plus the cached "before" nets from the last observation of the same revision removes one Java round trip. Measure with `scripts/workbench/editing-scenarios.mts` against a course-size file before and after.
3. Replace the remaining `.map_err(|e| e.to_string())?` with `?` where the function already returns `Result<_, HostError>` (`grep -rn 'map_err(|e| e.to_string())' crates/workbench-host/src`).

## Verify

```sh
cargo test -p vibe-workbench-host
npm run check:contracts          # generated TS matches the Rust types
npm run test:native              # real JVM: editing, viewport and simulation scenarios
npm run test:files  && npm run test:history && npm run test:interfaces
```
