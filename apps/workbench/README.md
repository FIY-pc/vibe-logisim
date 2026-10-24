# workbench

The window. React 19 + Zustand, one `Workbench` per mount (`app/createWorkbench.ts`): eight stores, four action groups, one host subscription. Every mutation of circuit state goes to the host; the window keeps only view state (selection, tool, viewport, open panels, drafts) and the last snapshot it was given.

## Owns

- `app/`: composition and lifecycle. `createWorkbench` builds `Stores{notices, settings, shell, conversation, documents, files, editor, simulation}` and `Actions{workspace, editor, simulation, navigation}`; `start.ts` subscribes; `router.ts` applies host events (`simulation`, `resync`, `warning`, connection loss); `keyboard.ts` the shortcut dispatcher; `view.ts` the `View{doc, circuit, scope}` every component reads; `provider.tsx` the React context; `hooks.ts` selectors; `reaction.ts` store-to-store reactions.
- `shared/`: `transport.ts` (`command(request)`: Tauri `invoke("command")` on desktop, `POST /api/command` in the browser; `openPath`/`savePath` file dialogs), `events.ts` (`subscribeEvents`: Tauri `workbench-event` or SSE), `host-error.ts`, `notices.ts`, `settings.ts`, `shortcuts.ts` (the key table, user-editable), small controls (`DecisionDialog`, `IconButton`, `PropertyField`, `TextPrompt`, `Select` — the only drop-down list, `Checkbox`, `useAutoSize` for growing text areas). Every layer is drawn by the app, never by the platform or its theme: `Menu`/`MenuItem` (button menus, the "···" ones included) and `ContextMenu` (right-click) on Radix menus, `Select` and `Checkbox` on Radix, `Dialog.tsx` (`useModal`: focus starts on `data-autofocus` or the dialog and returns to the opener; `DialogClose`), `layer.ts` (portal container inside the open dialog, focus return), and `Tooltips` — one hint layer for `data-tip` (`tip(text, shortcut)`, `fullText(text)` for labels cut short); native `title` is not used. Commands that open a dialog or a file picker end with "…", commands that act at once do not.
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
3. Done: the window adds no waiting of its own to an edit. `useMovePreview` sends at most one `movePreview` per animation frame, one at a time, never the same position twice, and the latest position when the one in flight returns. The canvas draws a new revision of the circuit on screen at once and observes it when the picture has arrived (requests sent together reach the host in either order, and the worker takes one at a time); the commit overlay covers the gap, and the previous observation keeps hit testing until the new one arrives. Panning, zooming and opening another circuit still wait 80 ms for the view to settle, and a newly shown circuit is observed first because fitting needs its bounds.
4. Old UI for reference only: `git show HEAD:apps/workbench/src/components/Canvas.tsx` etc. (132 files under `components/ regions/ stores/ lib/ actions/ workbench/` at `HEAD`). Do not port features back without a user asking.
5. Check the window in the desktop web views, not only in Chrome: WebKitGTK (Linux) and WebView2 (Windows). Things the browser preview cannot show: hints on disabled buttons (Chrome sends them no pointer events, so they show none), scrollbar styling, the 140 ms layer fade, and focus returning to a menu's button after its dialog closes.
6. Waveform rows and kept observations name a signal `label [port index]`. The inspector names ports (数据, 地址…) from the observed connections; carry that name in `TraceSignal` and in the observation's signal label (`crates/workbench-host/src/simulation/observations.rs`) so the three read alike.
7. Text fields keep the web view's own context menu (cut, copy, paste, spelling). If WebKitGTK's looks out of place next to the app's menus, give fields an app `ContextMenu` with the same commands.
8. Parts from third-party libraries (`.jar`) keep the runtime's names; built-in libraries and parts are translated in `editor/componentLabels.ts`, keyed by native factory name. Add a part there when the runtime gains one.

## Verify

```sh
npm run check -w @vibe-logisim/workbench && npm run build
npm run test:ui
npm run dev            # browser at http://127.0.0.1:5173 with the Rust host
npm run desktop        # Tauri window
```
