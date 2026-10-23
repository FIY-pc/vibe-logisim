# agent-runtime

The AI turn. A Node sidecar the host spawns once per application run; it holds the user's model services, the per-folder conversations, and the tools the model uses. It owns no circuit state: every tool call is a host request on the live document, so the user sees edits appear in the editor as they happen and can undo them with the same history as their own edits.

## Owns

- `worker.mts`: process entry. Reads `{kind:"request", id, method, args}` lines on stdin, answers `{kind:"result"}`, pushes `{kind:"event"}`, and calls the host with `{kind:"host", id, request}` answered by `{kind:"hostResult"}`. Sends `{kind:"ready"}` after start. Argument: the state directory.
- `protocol/`: the shapes shared with the host and the window: `host.mts` (`HostClient`, `HostStatus`, `HostFolder`, `FolderChange`, `isHostError`), `messages.mts` (`RuntimeEvent` union: status, history, user-message, user-message-delivery, assistant-started/-delta/-completed, activity, conversations-changed, runtime-error, turn-started, turn-completed, document-changed, document-opened, files-changed), `types.mts`.
- `models/`: `services.mts` (`ServiceStore` in `<state>/profile`: custom OpenAI-compatible / Anthropic / Responses endpoints, keys kept out of logs; `modelFor`, `transport`, `APIS`), `catalog.mts` + `catalog.snapshot.json` (public model metadata, `npm run catalog:update`), `probe.mts` (`discoverModels`; the connection test is `TurnRunner.probeService`), `selection.mts` (`selectionFor`, `configurationIssue`, `recoverHistory`), `validate.mts`, `sdk.mts`/`sdk-loader.mts` (pi-ai streaming).
- `network/`: `system-proxy.mts` (`resolveSystemProxy`: Windows and env proxies) and `fetch.mts` (`networkFetch`, `systemProxy`, `closeNetwork`). All model traffic goes through `networkFetch` on the route `resolveSystemProxy` picked.
- `conversations/`: `store.mts` (`ConversationStore`, `<state>/conversations.json`, keyed by folder id), `references.mts` (user-attached files and observations: `storeReference`, `readReferences`, `referenceSummary`), `types.mts`, `reference-types.ts` (shared with the window).
- `turn/`: `instructions.mts` (system prompt and the bundled skill), `runner.mts` (`TurnRunner`: one turn at a time, steer and interrupt, folder checkpoint before and after, event stream), `activity.mts` (`toolActivity`: the Chinese one-liners the window shows per tool call).
- `tools/`: 16 tools (`schemas.mts`, `TOOL_SPECS`): open_circuit create_circuit define_circuit inspect_circuit render_circuit describe_component place_component set_attributes connect move_components delete_objects arrange_circuit simulate_circuit trace_circuit undo_edit read_observation, plus `files.mts` (read_file, write_file, list_files, exec_command inside the folder; references read-only). `context.mts` (`ToolContext`: current document, observe cache per revision, `edit` with revision check). `index.mts` assembles `circuitTools({context, vision})`.
- `circuit-knowledge/`: Markdown the model can read (`index.md`, `digital-design.md`, `java-runtime.md`, `skills/circuit-organization/SKILL.md`, `references/arrangement.md`). Bundled read-only with the product.

## Does not own

Rendering, document identity, saving, history (host); layout algorithms (`packages/arranger`, called through `tools/layout.mts` in a worker thread); UI state.

## Public interface (methods over the host's `agent` op)

| method                                                      | args                                                                                      | returns                                                                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| status                                                      |                                                                                           | snapshot: status, available, busy, canSteer, conversationId, turnId, model, effort, services, defaultServiceId, messages, network, transmission, modelConfigurationError, modelCatalog |
| bind                                                        | `{documentId}`                                                                            | resumes the conversation of the host's current folder, remembers the document for the next ask; during a turn only the turn's folder binds                                             |
| ask                                                         | `{question, references, documentId, circuit, selection, expectedTurnId?, editMessageId?}` | starts a turn (or steers the running one when `expectedTurnId` matches)                                                                                                                |
| stop                                                        |                                                                                           | interrupts the turn                                                                                                                                                                    |
| markUndone                                                  | `{changeId}`                                                                              | marks a turn's file change as undone after the window undid it in the folder history                                                                                                   |
| reconnect                                                   |                                                                                           | restarts the model stream after a network failure                                                                                                                                      |
| conversations                                               | `{action?: "new" \| "select" \| "rename" \| "archive" \| "restore", id?, title?}`         | the folder's conversation list and the active one                                                                                                                                      |
| models                                                      | `{refresh}`                                                                               | models per service                                                                                                                                                                     |
| selectModel                                                 | `{model, effort}`                                                                         |                                                                                                                                                                                        |
| configure / removeProvider / defaultProvider / bindProvider | service management                                                                        |                                                                                                                                                                                        |
| discover / probe                                            | `{id}`                                                                                    | reachability and model list of a service                                                                                                                                               |
| stageReferences / readReferences                            | `{documentId, references}` / `{ids}`                                                      | attachments for the next question                                                                                                                                                      |

Events reach the window as host events on topic `agent`, in order, with a sequence number; the window replays missed ones from `status`. `status` alone rebuilds the conversation: each turn's record (`type: "turn"`) carries `status`, `error` (Chinese; `已停止` after a stop), `startedAt`, `elapsedMs` and `change` (the folder change it made, `undone` once undone). `transmission` is the retry notice while the model service is busy, null otherwise.

Host ops the tools use: status read source open new edit undo observe template catalog render simulate trace folderCreate folderCheckpoint observationList observationGet observationImage. Each turn starts with `folderCheckpoint {title: "文件改动"}` and ends with another titled after the question, so the user's file history shows one undoable entry per turn (`files-changed` event).

## Invariants

- The conversation scope is the folder id from host `status`; without an open folder `ask` fails with `请先打开工作文件夹`.
- A tool never caches a view across revisions: `ToolContext.edit` sends the revision it read and surfaces `StaleRevision` to the model as an error it can retry after re-reading.
- Component ids are positions (`c<x>_<y>`); the model is told so in the instructions and must not expect ids to survive a move.
- Model-facing errors are `CircuitToolError` with the host's Chinese message and `code`; never a stack trace.
- Credentials: keys live only in `<state>/profile`; nothing in this package logs request headers or writes keys elsewhere.

## Status

Compiles and type-checks; the JSONL protocol, status/bind/conversations/models and the "no service" refusal are smoke-tested against a fake host. **The first real-model turn through this runner has not been run yet**; the 10-22 course-project turns went through the previous sidecar. Running one is the first task below.

## Remaining tasks

1. Done: a real turn on the course project (rename one pin label in a subcircuit) edits the file, shows the checkpoint and undoes cleanly. What broke was a gateway that answers HTTP 200 and then an error event inside the stream; `retryingStream` in `turn/runner.mts` restarts such requests with backoff. Next real turns should be larger edits (place + connect, arrange) to find the next break.
2. `tools/arrange.mts` `TODO(arrange)`: when the host gains `observeXml`, verify the arranged XML before `edit replace` and drop the apply→verify→undo path.
3. Re-add the sidecar turn scenario in `scripts/workbench/verify.mts` (`TODO(agent-runtime)`): a scripted provider that returns one tool call, asserting the `document-changed` and `files-changed` events and the folder checkpoint.
4. Unify `isHostError` (`tools/errors.mts` checks plain objects, `protocol/host.mts` Error instances); keep the `protocol` one.
5. Old features not carried over, pick up only when a user asks: conversation fork (`git show HEAD:packages/agent-runtime/core/conversation-fork.mts`), context transfer between conversations (`core/context-transfer.mts`), Codex CLI backend (`core/codex-backend.mts`).

## Verify

```sh
npm run check -w @vibe-logisim/agent-runtime
npm run test:runtime        # network, references, instructions
npm run bundle:agent        # the product bundle; output in .workbench-cache/agent-product
```
