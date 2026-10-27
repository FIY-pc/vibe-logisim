# Workbench development reference

The workbench uses React for the editor, Tauri for the desktop shell, and Rust for documents and simulation sessions.

## Start here

Install Node.js 24, rustup, and JDK 17 or newer. Rust uses the version in `rust-toolchain.toml`. Tauri additionally needs the platform prerequisites in [its development guide](https://v2.tauri.app/start/prerequisites/): WebView2 and MSVC on Windows; GTK3 and WebKit2GTK 4.1 on Linux.

From the repository root:

```sh
npm ci
npm run setup
npm run desktop
```

`setup` downloads the checksum-pinned Logisim-ITA runtime into `.workbench-cache`. Set `VIBE_LOGISIM_JAR` to an absolute path to use another supported runtime. The Java bridge cache is keyed by the runtime and source digests.

For browser development, run `npm run dev` and open `http://127.0.0.1:5173`. This starts Vite and the Rust HTTP development host. Desktop uses Tauri IPC directly; the HTTP host is a development tool and binds only to loopback. File pickers require the desktop.

Desktop state is stored in Tauri's application data directory. Browser development uses `.workbench-state`; `VIBE_WORKBENCH_STATE` selects another directory and `VIBE_WORKBENCH_PORT` sets the host port.

## Ownership and contracts

| Area                  | Entry                                   | Responsibility                                                                    |
| --------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| Document core         | `crates/circuit-document`               | Source XML, revision checks, atomic saving, undo, recovery, folder identity       |
| Compatibility adapter | `crates/logisim-runtime`                | Java process lifecycle, native catalog/properties/geometry, rendering, simulation |
| Application host      | `crates/workbench-host`                 | Typed commands, document/simulation binding, sidecar callbacks                    |
| Desktop               | `apps/workbench/src-tauri`              | Window, native dialogs, IPC and application lifecycle                             |
| Editor UI             | `apps/workbench/src/editor/`            | Editor picture, selection, placement, wiring, navigation, input feedback          |
| Conversation UI       | `apps/workbench/src/conversation/`      | Model service settings, history, actual streamed events and folder checkpoints    |
| Runtime adapter       | `packages/agent-runtime`                | Node sidecar, model service access and the tool contract                          |
| Simulation evidence   | `crates/workbench-host/src/simulation/` | Revision-bound captures, exact watches and persistent observation records         |

AI modules are implemented in TypeScript under `packages/agent-runtime/src`; Java bridge sources live in `crates/logisim-runtime/java`. Each module directory has a README describing its interface, invariants and open tasks; [architecture](architecture.md) is the map.

The document core has no UI, Java, Node or network dependency. Both desktop and browser transports call the same Rust application host. `Request`, document types and model edit schemas are generated from Rust:

```sh
npm run contracts
npm run check:contracts
```

Edit the Rust definitions, then regenerate. Do not edit generated TypeScript or JSON schema by hand. Invalid revisions reject the entire edit. Component and wire selectors are revision-local; obtain new selectors after structural changes.

The host pushes agent events and simulation frames through Tauri events or the browser development SSE connection. Agent snapshots carry an event cursor so reconnecting does not append streamed text twice. Simulation frames use a latest-value channel; slow consumers do not accumulate a frame queue. Each frame carries what changed in the run's picture since the frame that consumer last received (wire and junction colors, the drawing ops of changed components), so a skipped frame loses nothing and the window draws the running circuit without asking for images. Host shutdown closes live streams before terminating child processes.

Simulation belongs to a document revision and root circuit. Entering a subcircuit instance changes the view within that running root. Starting or operating another circuit replaces the transient session. Stimuli do not change source revisions, write source files or enter undo history. RAM edits apply to the selected running instance. ROM edits are structural document changes and remain undoable; they follow the document saving policy. Both reject stale values. Button release only applies to its original live session; leaving or closing a circuit cannot restart a simulation through a delayed release event.

Signal traces capture settled native steps independently of rendering. A trace retains at most 512 samples and reports the number removed from its window. These are logical steps and ticks, not a uniformly sampled physical time axis. Retained observations freeze source revision, root circuit, instance path, sampled ports, trace and image. Their summary uses the explicit watched set, or up to 24 named signal components when no watches are selected. Capturing an observation does not pause simulation. Comparisons require matching circuit identity and compare only explicitly shared watched ports.

Structural edits to existing documents inside the open project folder automatically save to their source path. Untitled documents and documents outside that folder require `Save`. Both paths reject external source changes; a failed automatic save preserves the edit and exposes a retry. Reload checks both draft and disk versions and retains the previous draft in undo history. Close checks the draft revision before discarding changes and stops the document's simulation. Save As transfers the document identity to the new path; reopening the old file creates a separate document. Replacing an existing target checks its observed digest and rejects targets already open as another document.

Each open document has a recovery journal, separate from its source file: a snapshot of the document with its undo and redo steps, then one record per change holding only that change. A change is written before the host responds and synced to disk in the background; a record cut short by a crash is dropped on restart. Recovery restores these drafts with their undo and redo steps. An OS file lock restricts each recovery directory to one host process. The host derives the conversation workspace from document membership in the open folder; files outside that folder keep separate conversations.

The runtime edits the files in the open folder directly. Each AI turn records a folder checkpoint; the conversation lists the changed files, and the user can review and undo them from there.

Document history stores immutable content-addressed versions separately from undo and redo. Each document's history is one append-only file; a version is stored as a patch against its predecessor when that is much smaller than the whole file. Open and explicit save operations establish baselines. Each structural change records its exact predecessor; review can compare that step or compare a selected version with the current document. Restoring a version appends a new history entry and remains one undo step. Historical library paths and digests are retained; if an external library changes, exact historical rendering is unavailable rather than silently using the new library. Source comparison remains available.

`node scripts/workbench/history-check.mts` exercises document history with independent synthetic circuits: baselines, before/after and current comparison, restore and undo, source conflicts, restart and changed external libraries.

Project folders contain text, image and PDF previews. PDF character maps, fonts and decoding resources are bundled for offline viewing. Quoting selected text, an image, a PDF page or a retained observation adds an immutable reference to the conversation draft without sending it. PDF references include the rendered page, including scanned pages without extracted text. Sent messages retain those snapshots and page numbers. References belong to their conversation workspace, and sending failures preserve the draft. The runtime can list and read text files in the bound project and inspect retained observations; binary documents are referenced through the preview. File operations reject paths escaping the open folder, including through symlinks.

File-tree menus provide path copying, revealing files in the system file manager, renaming, moving, and moving to the system trash. External imports preview conflicts before applying keep-both, replace or skip choices. File-operation history stores bounded content snapshots; undo checks for later edits before restoring anything. Issued file references retain a logical identity across app-controlled moves, saves and restores, and reject unconfirmed external replacements. Dragging within the tree moves an entry into a folder. Mutations carry the project identity, reject existing destinations and self-descendant moves, and retain open document identity when paths change. Trashing a directory with an unsaved open draft is rejected; clean open documents close only after the OS trash operation succeeds. A symlink is moved or trashed as an entry without moving its target. Windows recycling explicitly requests `FOFX_RECYCLEONDELETE`; it does not fall back to permanent deletion.

The editor keeps file and component resources, the circuit list and properties on the left, alongside the conversation on the right. Regions can be resized or collapsed; narrow windows use drawers. Tool shortcuts 1–4, A for the palette, the document dirty indicator, nearby undo controls and current-circuit simulation commands remain available. Memory, trace and observation controls remain adjacent to the editing and simulation tasks they serve.

The right-hand history panel lists the immutable document history. Historical restoration appends a change and remains undoable; unavailable dependencies remain visible.

The document title opens file information and a ZIP export containing the current circuit, its external library closure, and observations and verification records from that source revision. Export rewrites packaged library references to relative paths and reports missing dependencies before writing. Metadata distinguishes the original source revision from the rewritten archive entry; retained evidence does not claim to verify those rewritten bytes. The archive excludes unrelated project materials and earlier versions.

`simulate_circuit` evaluates independent input vectors against labeled output pins. `trace_circuit` starts a fresh sequential run with exact watched ports and tick-indexed input events. Both use a separate Java worker and request queue, leaving the visible simulation, source file and undo history untouched. Native errors discard that verification worker. Results carry their source revision; missing expectations remain unchecked, and unknown outputs do not pass numerical assertions.

For selection moves, the host prepares the moved layout and compares Logisim's bit-net partitions before committing one undo step. A move that changes port connectivity is rejected. This check applies to selection movement; free wire drawing and direct source edits use their own edit paths.

## Verification

Use the check that covers the changed boundary:

```sh
npm run check
npm run check:rust
npm run check:contracts
npm run test:core
npm run test:runtime
npm run test:ui
npm run test:files
npm run test:interfaces
npm run test:history
npm run test:native
npm run test:compatibility
npm run build
npm run bundle:agent
```

`test:native` runs the Java adapter against temporary circuits. It requires no model service. Document, simulation and folder scenarios are in [verify.mts](../scripts/workbench/verify.mts); routing scenarios are in [editing-scenarios.mts](../scripts/workbench/editing-scenarios.mts). Memory, trace and observation scenarios are in [simulation-scenarios.mts](../scripts/workbench/simulation-scenarios.mts). The independent [compatibility-check.mts](../scripts/workbench/compatibility-check.mts) workload covers custom symbols, local subcircuits, nested external `.circ` libraries, cross-directory Save As and a generated 3,072-component circuit. Provider compatibility and model behavior require separate checks. `test:runtime` verifies proxy selection with a local authenticated HTTP proxy, reference storage and the built-in runtime instructions. It makes no model request.

`test:files` runs on Linux with temporary project files and an isolated freedesktop trash. It checks move identity, undo preservation, stale-project and unsafe-path rejection, dirty-delete protection, and that trashed content remains recoverable. It does not manipulate the user's files or trash.

`bundle:agent` builds the Node application code and SDK into `.workbench-cache/agent-product`, with dependency notices. Set `VIBE_LOGISIM_AGENT_ROOT` to that absolute directory when running `test:native` to exercise the bundled code.

## Desktop packaging

Build packages on the target platform:

```sh
npm run package:desktop
npm run test:product
npm run test:desktop
```

See [distribution](distribution.md) for package names, resource layout, system requirements, installer checks and tagged releases. Windows installation and upgrade checks run on an ephemeral CI runner. Local desktop checks use isolated state and do not use model credentials.

`VIBE_WORKBENCH_RESOURCES` selects an assembled resource directory. Packaged Tauri builds otherwise use the application resource directory; debug builds use the checkout. The Java bridge can reuse precompiled classes for the pinned jar or compile the included sources against another configured jar.

The sidecar reads proxy environment variables first, then Windows Internet Settings or manual KDE/GNOME proxy settings. Model discovery, connection tests and model requests share the same HTTP proxy transport. Automatic proxy scripts are reported as unsupported. Native system settings are read at connection time, without changing OS settings.

## Validation boundaries

The native checks use synthetic circuits and no model service. They do not prove remote provider compatibility or model behavior.

The compatibility workload covers a custom two-port symbol, local subcircuit navigation, two levels of relative `.circ` libraries, changed dependencies, malformed libraries, cross-directory Save As and a generated large circuit. External Java plugins, arbitrary custom symbols and remote provider behavior require separate checks. Passing these workloads does not imply every component, circuit or Linux distribution is covered.

## Synthetic compatibility measurements

Run the independent workload against a release host to measure the native boundary:

```sh
cargo build -p vibe-workbench-host --bin vibe-workbench-host --release
VIBE_WORKBENCH_RESOURCES="$PWD" \
VIBE_VERIFY_HOST="$PWD/target/release/vibe-workbench-host" \
node scripts/workbench/compatibility-check.mts
```

The script creates and removes its own files. It reports host startup, native observation, 1,200 × 800 viewport rendering, simulation startup and acknowledged input changes. It uses no model service. The first native request may include Java bridge compilation. These are host API and JVM measurements, not webview frame rates or pointer-response measurements.

Static observations are cached only within the immutable artifact and external-dependency set, with at most two 16 MB results for each of two loaded files. Changed external library contents invalidate read and independent-verification workers. A running interactive simulation retains its transient state; explicitly starting it again loads the current library contents in a new process.

Feedback diagnostics contain version, platform, architecture, runtime/recovery state, the runtime version observed from an actual Java response, and bounded failure categories with counts and timestamps. Failures are counted for the current host session; source paths, raw exception strings and request contents are excluded. The dialog previews the exact JSON before export; replacing a selected target checks its observed digest. Opening the public feedback page requires an explicit save action and does not submit an issue. Release checks read the project’s public Atom feed with an eight-second timeout and a 2 MB limit, retain the automatic-check preference and never download or install an update. Development versions are identified as such instead of being reported as the latest release.
