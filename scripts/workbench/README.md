# scripts/workbench

Development, verification and packaging scripts. All plain `.mts` run by Node 24 directly (no build step); `npm run check:scripts` type-checks them. Nothing here is shipped except what `bundle-agent.mts` and `package.mts` produce.

## Groups

- Run: `dev.mts` (Vite + Rust host for the browser), `setup.mts` (downloads the pinned Java and Logisim runtimes into `.workbench-cache`, `runtime-lock.json`), `simulation-client.mts` (CLI client for the host, used by scenario scripts), `event-stream.mts` (SSE reader).
- Verify against the real host and JVM (`npm run test:native` and friends): `verify.mts` (editing, document, agent protocol scenarios; `editing-scenarios.mts`, `viewport-scenarios.mts`, `simulation-scenarios.mts`), `simulation-controls-check.mts`, `interface-check.mts`, `history-check.mts`, `verify-files.mts` (`file-history-scenarios.mts`, `file-reference-scenarios.mts`), `compatibility-check.mts` (external libraries, custom symbols, large synthetic circuits), `feedback-check.mts`. Edit results carry only what changed; `document-views.mts` (`documentViews()`) keeps the whole view per document for a script and applies each result's `change` to it.
- Measure: `editing-latency.mts [rounds] [circuit]` starts a host (debug build, or `VIBE_VERIFY_HOST`) with timing on and runs `measureEditing` from `editing-scenarios.mts` on the synthetic 1 MB project of `fixtures/course-size.mts`: the canvas's `symbols` request for the whole page, then move, wire, place, delete and attribute edits each followed by the one `symbols` request the canvas sends per revision (only the kinds it lacks), as p50/p95 per request (`kinds` = kinds asked; `drawn` = the edit, plus the symbols when a kind was missing: when the canvas can draw the new picture, one frame before it is on screen), then the host's p50 per stage and request kind.
- Verify the window: `verify-ui.mts` bundles `ui/scenarios.tsx` with esbuild and runs it in jsdom with a scripted host; one file per area under `ui/` (`workbench`, `files`, `history`, `project-info`, `references`, `reference-links`, `conversation-summaries`, `ai-settings`, `editor-request-lifetimes`, `restored-interactions`).
- Verify the sidecar without a model (`npm run test:runtime`): `network-check.mts` (proxy resolution), `reference-check.mts` (attachments), `builtin-runtime-check.mts` (instructions and skill bundle).
- AI turns without a model: `scripted-model.mts` is an OpenAI-compatible Chat Completions endpoint whose every answer comes from a script that sees the question and each tool call of the turn with its parsed result (`startScriptedModel(script)`, `scriptedProfile(url)` for `<state>/profile/builtin-provider.json`; CLI `--port 8903 --script <module>` for a preview host). The sidecar, tools, host and window run for real. `agent-scenarios.mts` is the turn `verify.mts` runs (one `place_component` call of two parts: one document history entry "放置 2 个元件", `document-changed`, `files-changed`, the question in `history` and none of the conversation in `status`, undoing the folder checkpoint restores the file). `turns/` holds longer scripts for preview hosts: `full-adder.mts` (new file, place, connect, simulate, arrange, simulate, render; "不整理" stops after the first check), `small-circuits.mts` (new file, one small gate-level circuit named by a word of the question: 2:1 and 4:1 mux, decoder, 4-bit adder, counter, accumulator, built-in mux, inverter row; place where a person would sketch it, connect, check, arrange, check, render; "不整理" stops before arranging) and `large-edit.mts` (on whatever definition is open: read all pages, place a gate and a pin, connect two existing outputs, move, arrange, compare netlist signatures, render; works on any project).
- Product: `bundle-agent.mts` (esbuild bundle of `worker.mts` and `arrange-worker.mts` plus knowledge files and licences into `.workbench-cache/agent-product`), `prepare-product.mts` (runtimes, bundle, resources into the Tauri resource dir), `package.mts` (installer, portable zip, deb; `--upgrade-baseline` for the Windows upgrade test), `verify-product.mts`, `verify-desktop.mts` (launches the packaged app), `verify-windows-install.mts`, `windows-file-operation.mts`, `windows-java-utf8.mts`, `verify-java.mts`, `verify-node.mts`.
- Maintenance: `update-model-catalog.mts` (`npm run catalog:update` → `packages/agent-runtime/src/models/catalog.snapshot.json`).

## Conventions

- A scenario script starts its own host with a temporary state directory and a temporary copy of its fixture; it never touches the developer's state or files.
- Scripts print one line per scenario and exit non-zero on the first failure; there is no test framework, assertions are `node:assert`.
- Paths into the source tree are relative to the repository root (`path.join(root, …)`); when a module moves, these scripts are the first thing to break, so `npm run check:scripts` is part of `npm run check`.

## Remaining tasks

1. Done: `verify.mts` runs a scripted AI turn (`agent-scenarios.mts`) at the end of its scenarios.

## Verify

```sh
npm run check:scripts
npm run test:native && npm run test:ui && npm run test:runtime
```
