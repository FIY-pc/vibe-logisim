# agent-runtime

The AI turn. A Node sidecar the host spawns once per application run; it holds the user's model services, the per-folder conversations, and the tools the model uses. It owns no circuit state: every tool call is a host request on the live document, so the user sees edits appear in the editor as they happen and can undo them with the same history as their own edits.

## Owns

- `worker.mts`: process entry. Reads `{kind:"request", id, method, args}` lines on stdin, answers `{kind:"result"}`, pushes `{kind:"event"}`, and calls the host with `{kind:"host", id, request}` answered by `{kind:"hostResult"}`. Sends `{kind:"ready"}` after start. Argument: the state directory.
- `protocol/`: the shapes shared with the host and the window: `host.mts` (`HostClient`, `HostStatus`, `HostFolder`, `FolderChange`, `isHostError`), `messages.mts` (`RuntimeEvent` union: status, history, user-message, assistant-started/-delta/-completed, activity, conversations-changed, runtime-error, turn-started, turn-completed, document-changed, document-opened, files-changed), `types.mts`.
- `models/`: `services.mts` (`ServiceStore` in `<state>/profile`: custom OpenAI-compatible / Anthropic / Responses endpoints, keys kept out of logs; `modelFor`, `transport`, `APIS`), `catalog.mts` + `catalog.snapshot.json` (public model metadata, `npm run catalog:update`), `probe.mts` (`discoverModels`; the connection test is `TurnRunner.probeService`), `selection.mts` (`selectionFor`, `configurationIssue`, `recoverHistory`), `validate.mts`, `sdk.mts`/`sdk-loader.mts` (pi-ai streaming).
- `network/`: `system-proxy.mts` (`resolveSystemProxy`: Windows and env proxies) and `fetch.mts` (`networkFetch`, `systemProxy`, `closeNetwork`). All model traffic goes through `networkFetch` on the route `resolveSystemProxy` picked.
- `conversations/`: `store.mts` (`ConversationStore`, `<state>/conversations.json`, keyed by folder id; read once, then kept in memory, and every save rewrites the file), `references.mts` (user-attached files and observations: `storeReference`, `readReferences`, `referenceSummary`), `types.mts`, `reference-types.ts` (shared with the window).
- `turn/`: `instructions.mts` (system prompt and the bundled skill), `runner.mts` (`TurnRunner`: one turn at a time, interrupt, folder checkpoint before and after, event stream; a running turn saves its conversation at most every 500 ms, its start and end save at once), `activity.mts` (`toolActivity`: the Chinese one-liners the window shows per tool call), `context-budget.mts` (`clearOldToolOutput`: once a conversation passes 60 % of the model's context, estimated at 3 characters per token and 3000 per image, the oldest tool results become a short note until it is under 40 %; the newest four and all user and model text stay. Applied to the stored transcript before each turn and to the request inside a long turn; only what still does not fit fails the turn).
- `tools/`: 16 tools (`schemas.mts`, `TOOL_SPECS`): open_circuit create_circuit define_circuit inspect_circuit render_circuit describe_component place_component set_attributes connect move_components delete_objects arrange_circuit simulate_circuit trace_circuit undo_edit read_observation, plus `files.mts` (read_file, write_file, list_files, exec_command inside the folder; references read-only). `context.mts` (`ToolContext`: current document, observe cache per revision, `edit` with revision check: a call's wire, place, delete and attribute edits go to the host as one `batch`, and so do its moves by different offsets, so each tool call is one undo step and a refused move moves nothing). `index.mts` assembles `circuitTools({context, vision})`.
- `tools/wiring.mts`: the router behind `connect`. `new Router(circuitView)` paints the observed definition on the 10 px grid (bodies, port and wire-end joints, wire interiors per net, the directions each port leaves its body); `route(from, to)` is A* from anywhere on the first net (its ports and every wire point) to anywhere on the second, with a cost per bend (4), per wire crossing (3) and per body cell (25, straight only, for ports boxed in by a tunnel or a neighbour); `commit(points)` adds a drawn route to its net so later routes of the same call branch off it. It never ends or bends on another net, never runs along a wire, and meets ports head-on. `connect` then observes the result and checks that exactly the requested nets were joined (`ROUTE_CHANGED_NETS` takes the wires back otherwise).
- `circuit-knowledge/`: Markdown the model can read (`index.md`, `digital-design.md`, `java-runtime.md`, `skills/circuit-organization/SKILL.md`, `references/arrangement.md`). Bundled read-only with the product.

## Does not own

Rendering, document identity, saving, history (host); layout algorithms (`packages/arranger`, called through `tools/layout.mts` in a worker thread); UI state.

## Public interface (methods over the host's `agent` op)

| method                                                      | args                                                                              | returns                                                                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| status                                                      |                                                                                   | snapshot: status, available, busy, conversationId, model, effort, services, defaultServiceId, messages, network, transmission, modelConfigurationError, modelCatalog |
| bind                                                        | `{documentId}`                                                                    | resumes the conversation of the host's current folder, remembers the document for the next ask; during a turn only the turn's folder binds                           |
| ask                                                         | `{question, references, documentId, circuit, selection, editMessageId?}`          | starts a turn; refused while one is running                                                                                                                          |
| stop                                                        |                                                                                   | interrupts the turn                                                                                                                                                  |
| markUndone                                                  | `{changeId}`                                                                      | marks a turn's file change as undone after the window undid it in the folder history                                                                                 |
| reconnect                                                   |                                                                                   | restarts the model stream after a network failure                                                                                                                    |
| conversations                                               | `{action?: "new" \| "select" \| "rename" \| "archive" \| "restore", id?, title?}` | the folder's conversation list and the active one                                                                                                                    |
| models                                                      | `{refresh}`                                                                       | models per service                                                                                                                                                   |
| selectModel                                                 | `{model, effort}`                                                                 |                                                                                                                                                                      |
| configure / removeProvider / defaultProvider / bindProvider | service management                                                                |                                                                                                                                                                      |
| discover / probe                                            | `{id}`                                                                            | reachability and model list of a service                                                                                                                             |
| stageReferences / readReferences                            | `{documentId, references}` / `{ids}`                                              | attachments for the next question                                                                                                                                    |

Events reach the window as host events on topic `agent`, in order, with a sequence number; the window replays missed ones from `status`. `status` alone rebuilds the conversation: each turn's record (`type: "turn"`) carries `status`, `error` (Chinese; `已停止` after a stop), `startedAt`, `elapsedMs` and `change` (the folder change it made, `undone` once undone). `transmission` is the retry notice while the model service is busy, null otherwise.

Host ops the tools use: status read source open new edit undo observe observeXml template catalog render simulate trace folderCreate folderCheckpoint observationList observationGet observationImage. Each turn starts with `folderCheckpoint {title: "文件改动"}` and ends with another titled after the question, so the user's file history shows one undoable entry per turn (`files-changed` event).

## Invariants

- The conversation scope is the folder id from host `status`; without an open folder `ask` fails with `请先打开工作文件夹`.
- A tool never caches a view across revisions: `ToolContext.edit` sends the revision it read and surfaces `StaleRevision` to the model as an error it can retry after re-reading.
- Component ids are positions (`c<x>_<y>`); the model is told so in the instructions and must not expect ids to survive a move.
- Model-facing errors are `CircuitToolError` with the host's Chinese message and `code`; never a stack trace.
- Credentials: keys live only in `<state>/profile`; nothing in this package logs request headers or writes keys elsewhere.

## Status

Works end to end: a real-model turn on a large project (rename a pin label in a subcircuit) went through this runner, and `npm run test:native` runs a scripted turn through the real sidecar, tools and host. With the scripted model, a full adder from an empty folder (create, place, connect, simulate, arrange, render) takes about 0.5 s; a place, connect, move and arrange turn on a 700-component definition of a 1 MB file about 4 s, half of it `arrange_circuit`.

## Remaining tasks

1. Done: a real turn on the course project (rename one pin label in a subcircuit) edits the file, shows the checkpoint and undoes cleanly. What broke was a gateway that answers HTTP 200 and then an error event inside the stream; `retryingStream` in `turn/runner.mts` restarts such requests with backoff. Next real turns should be larger edits (place + connect, arrange) to find the next break.
2. Done: `arrange_circuit` verifies the arranged XML through the host's `observeXml` before its `edit replace`; the apply→verify→undo path is gone.
3. Done: `npm run test:native` ends with a scripted AI turn through this runner (`scripts/workbench/agent-scenarios.mts`); `scripts/workbench/scripted-model.mts` and `scripts/workbench/turns/` drive longer turns on a preview host without a model.
4. Done: `tools/errors.mts` uses `protocol/host.mts`'s `isHostError` (host refusals arrive as `Error` objects carrying the HostError fields).
5. Old features not carried over, pick up only when a user asks: conversation fork (`git show HEAD:packages/agent-runtime/core/conversation-fork.mts`), context transfer between conversations (`core/context-transfer.mts`), Codex CLI backend (`core/codex-backend.mts`).

## Verify

```sh
npm run check -w @vibe-logisim/agent-runtime
npm run test:runtime        # network, references, instructions
npm run bundle:agent        # the product bundle; output in .workbench-cache/agent-product
```
