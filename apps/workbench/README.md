# workbench

The window. React 19 + Zustand, one `Workbench` per mount (`app/createWorkbench.ts`): eight stores, four action groups, one host subscription. Every mutation of circuit state goes to the host; the window keeps only view state (selection, tool, viewport, open panels, drafts) and the last snapshot it was given.

## Owns

- `app/`: composition and lifecycle. `createWorkbench` builds `Stores{notices, settings, shell, conversation, documents, files, editor, simulation}` and `Actions{workspace, editor, simulation, navigation}`; `start.ts` subscribes; `router.ts` applies host events (`simulation`, `resync`, `warning`, connection loss); `keyboard.ts` the shortcut dispatcher; `view.ts` the `View{doc, circuit, scope}` every component reads; `provider.tsx` the React context; `hooks.ts` selectors; `reaction.ts` store-to-store reactions.
- `shared/`: `transport.ts` (`command(request)`: Tauri `invoke("command")` on desktop, `POST /api/command` in the browser; `openPath`/`savePath` file dialogs), `events.ts` (`subscribeEvents`: Tauri `workbench-event` or SSE), `host-error.ts`, `notices.ts`, `settings.ts`, `shortcuts.ts` (the key table, user-editable), small controls (`DecisionDialog`, `IconButton`, `PropertyField`, `TextPrompt`, `Select` — the only drop-down list; built on Radix UI so the list is drawn by the app, never the platform's native `<select>` popup).
- `shell/`: frame and chrome: `WorkspaceLayout`, `Titlebar`, `Rail` (left tool rail), `Aside` (right column: chat, files, inspector…), `Notices`, `DecisionRegion` (blocking questions), `Feedback*`, `ShortcutSettings*`, `store.ts` (which panels are open, pending host calls).
- `workspace/`: the folder and open files: `documents.ts` (open documents, active id, workspace refresh), `filesStore.ts` + `Files.tsx` (folder tree, file history with undo, imports), `FilePreview` (PDF, images, text), `ProjectInfo` (summary, export), `Welcome`, `FolderPrompt`, `NewFilePrompt`, `SourceNotices` (file changed on disk / missing), `actions.ts`.
- `editor/`: the canvas and editing: `Canvas.tsx` (rendering from the host's PNG plus overlays for selection, wires in progress, placement ghost), `store.ts` (tool, selection, viewport, placement), `actions.ts` (edit, undo, redo, move, delete, attributes through host ops), `usePlacement`/`useMovePreview`, `EditorToolbar`, `Inspector` + `PlacementInspector` (attributes via `properties`/`template`), `PaletteRegion` (`catalog`), `Connections*`/`connectivity.ts` (signal tracing on the observed nets), `CircuitList`/`CircuitActions`/`CircuitPrompts`/`Breadcrumbs`/`navigation.ts` (subcircuit navigation), `FindDialog`, `InterfaceEditor` (subcircuit pins and symbol), `SourceDialog`, `arrange.ts` + `arrange-worker.ts` (`packages/arranger` in a module worker for the user's own "整理" action), `symbol-geometry.ts`, `componentLabels.ts`.
- `simulation/`: `store.ts` (run state, frames, instance path), `actions.ts`/`simulation.ts` (`simulationAct`/`Navigate`/`Viewport`/`Stop`), `simulationInputs.ts` (poke, input values, buttons), `SimulationControls`/`SimulationDock`/`SimulationTransportRegion`/`SimulationMenuRegion`, `InstanceBar`, `MemoryPanel`, `Waveform`, `Observations` (kept observations), `SimulationAlerts`, `CaptureNotice`.
- `conversation/`: `Chat.tsx` (binding to the folder's conversation, sending, stopping, replaying `agent` events by sequence), `turns.ts` (splits the messages into one segment per question, the summary line of a finished turn), `Turn.tsx` (one turn: live steps, the folded summary, the end line, the files card with undo), `ConversationContent` (markdown, copy, scroll following, conversation picker), `ChatReferences` + `references.ts`/`conversationReferences.ts` (attached files and observations), `ModelPicker`, `ProviderSettings` (services, keys, probe), `store.ts`.
- `history/`: `DocumentHistory` (per-document history list), `HistoryReview` (review of one entry with before/after render and `sourceDiff.ts`), `ChangesRegion`.
- `generated/`: TypeScript copies of the host types. Never edited by hand; `npm run contracts`.
- `src-tauri/`: `main.rs` (creates `Host`, exposes the `command` invoke, forwards `Event`s as `workbench-event`, shuts the host down on exit), `installation_check.rs` (bundled runtimes present), `tauri.conf.json`.

## Does not own

Any rule about documents, saving, history, simulation lifetime or AI scope. If the window has to check something to stay correct, that check belongs in the host; the window only displays the host's answer.

## How data flows

- Read: a component calls `useWorkbench()` → store state. Stores are filled from host results (`status`, `read`, `observe`, `simulationSnapshot`…) by the action modules.
- Write: an action builds `{op, ...}` → `command()` → host → the result replaces the relevant store slice (edit results carry `view`, `selection`, `title`). No optimistic edits: the canvas shows the host's revision.
- Push: `router.ts` → simulation frames into `simulation.store`; `resync` → re-read workspace and simulation; `warning` → notice. `agent` events go to `Chat.tsx`, which owns the sequence gap check and replays from `status`.
- Shortcuts: `shared/shortcuts.ts` table (1 选择, 2 布线, 3 操作输入, 4 平移, A 元件库, Ctrl+K 时钟, Ctrl+T 一步, Ctrl+Z 撤销, Ctrl+S 保存, Ctrl+, 快捷键) → `app/keyboard.ts` → actions.

## Dependencies

React 19, Zustand 5, Vite, `@tauri-apps/api` + dialog/opener plugins, `lucide-react` (icons), `react-markdown` + `remark-gfm` (chat), `pdfjs-dist` (file preview), `packages/arranger` (worker), `packages/agent-runtime/src/conversations/reference-types.ts` (type only).

## Status

Builds, type-checks, 30 UI scenarios pass (`npm run test:ui`, jsdom with a scripted host). The domain split is new; file names inside each folder are stable, cross-folder imports go through `app/` or `shared/` only.

## Remaining tasks

1. Done: the toolbar delete button posts `deleteRequest` on the editor store and the canvas commits it with the same mask as the Delete key (`editor/EditorToolbarRegion.tsx`, `editor/Canvas.tsx`).
2. Done: the conversation shows one turn per question as the Codex app does (`conversation/Turn.tsx`, `turns.ts`): while it runs, reasoning, text and tool lines appear as they stream; when it ends, everything before the last text folds into one summary line with the elapsed time, the answer and the files card stay, and a failure or stop ends the turn with one line. The turn record from the runtime carries status, error, elapsed time and the file change, so a reload rebuilds the same view from `status`.
3. Editing latency is a host matter, but the window must not add to it: `useMovePreview` should send one `movePreview` per animation frame at most. Verify with the 1 MB course file.
4. Old UI for reference only: `git show HEAD:apps/workbench/src/components/Canvas.tsx` etc. (132 files under `components/ regions/ stores/ lib/ actions/ workbench/` at `HEAD`). Do not port features back without a user asking.

## Verify

```sh
npm run check -w @vibe-logisim/workbench && npm run build
npm run test:ui
npm run dev            # browser at http://127.0.0.1:5173 with the Rust host
npm run desktop        # Tauri window
```
