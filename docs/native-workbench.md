# Native workbench development

The workbench uses React for the editor, Tauri for the desktop shell, and Rust for documents and simulation sessions. This implementation is under development. The published Electron application is documented in the [v0.5.0 development guide](https://github.com/FIY-pc/vibe-logisim/blob/v0.5.0/docs/development.md).

## Start here

Install Node.js 24, rustup, and JDK 17 or newer. Rust uses the version in `rust-toolchain.toml`. Tauri additionally needs the platform prerequisites in [its development guide](https://v2.tauri.app/start/prerequisites/): WebView2 and MSVC on Windows; GTK3 and WebKit2GTK 4.1 on Linux.

From the repository root:

```sh
npm ci
npm run setup
npm run desktop
```

`setup` downloads the checksum-pinned Logisim-ITA runtime into `.workbench-cache`. Set `VIBE_LOGISIM_JAR` to an absolute path to use another supported runtime. The Java bridge cache is keyed by the runtime and source digests.

For browser development, run `npm run dev` and open `http://127.0.0.1:5173`. This starts Vite and the Rust HTTP development host. Desktop uses Tauri IPC directly; the HTTP host is a development tool and binds only to loopback. File pickers and opening external login pages require the desktop.

Desktop state is stored in Tauri's application data directory. Browser development uses `.workbench-state`; `VIBE_WORKBENCH_STATE` selects another directory and `VIBE_WORKBENCH_PORT` sets the host port. Profiles remain separate. The model-service settings offer an explicit `sessions.json` import from the old application. Import merges a selected conversation group into the current workspace and skips records already imported. Authentication files and credentials are not copied.

## Ownership and contracts

| Area                  | Entry                                      | Responsibility                                                                    |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| Document core         | `crates/workspace-core`                    | Source XML, revision checks, atomic saving, undo, recovery, folder identity       |
| Compatibility adapter | `crates/logisim-adapter`                   | Java process lifecycle, native catalog/properties/geometry, rendering, simulation |
| Application host      | `crates/workbench-host`                    | Typed commands, document/simulation binding, sidecar callbacks                    |
| Desktop               | `apps/workbench/src-tauri`                 | Window, native dialogs, IPC and application lifecycle                             |
| Editor UI             | `apps/workbench/src/components/Canvas.tsx` | Selection, placement, wiring, navigation and input feedback                       |
| Conversation UI       | `apps/workbench/src/components/Chat.tsx`   | Runtime settings, history, actual streamed events and explicit source application |
| Runtime adapter       | `packages/agent-runtime`                   | Node sidecar, built-in/Codex runtime dispatch, tool contract and scratch files    |
| Simulation evidence | `crates/workbench-host/src/observations.rs` | Revision-bound captures, exact watches and persistent observation records |

Shared runtime modules live in `packages/agent-runtime/core`; Java bridge sources live in `crates/logisim-adapter/java`. The previous desktop imports the shared runtime through small compatibility adapters. The native workbench has no imports into `apps/desktop`.

The document core has no UI, Java, Node or network dependency. Both desktop and browser transports call the same Rust application host. `Request`, document types and model edit schemas are generated from Rust:

```sh
npm run contracts
npm run check:contracts
```

Edit the Rust definitions, then regenerate. Do not edit generated TypeScript or JSON schema by hand. Invalid revisions reject the entire edit. Component and wire selectors are revision-local; obtain new selectors after structural changes.

The host pushes agent events and simulation frames through Tauri events or the browser development SSE connection. Agent snapshots carry an event cursor so reconnecting does not append streamed text twice. Simulation frames use a latest-value channel; slow consumers do not accumulate a frame queue. Host shutdown closes live streams before terminating child processes.

Simulation belongs to a document revision and root circuit. Entering a subcircuit instance changes the view within that running root. Starting or operating another circuit replaces the transient session. Stimuli do not change source revisions, write source files or enter undo history. RAM edits apply to the selected running instance. ROM edits change the draft and remain undoable until explicitly saved. Both reject stale values. Button release only applies to its original live session; leaving or closing a circuit cannot restart a simulation through a delayed release event.

Signal traces capture settled native steps independently of rendering. A trace retains at most 512 samples and reports the number removed from its window. These are logical steps and ticks, not a uniformly sampled physical time axis. Retained observations freeze source revision, root circuit, instance path, selected ports, trace and image. Capturing an observation does not pause simulation. Comparisons require matching circuit identity and compare only explicitly shared watched ports.

`Save` writes document changes to their source path and rejects external source changes. Reload checks both draft and disk versions and retains the previous draft in undo history. Close checks the draft revision before discarding changes and stops the document's simulation. Save As transfers the document identity to the new path; reopening the old file creates a separate document. Replacing an existing target checks its observed digest and rejects targets already open as another document.

Edits are checkpointed separately from source files before the host responds. Recovery restores these drafts. An OS file lock restricts each recovery directory to one host process. Conversations retain their runtime; switching runtimes creates a new conversation when the current one has history. The host derives the conversation workspace from document membership in the open folder; files outside that folder keep separate conversations. Imported built-in conversations retain their model transcript. Imported Codex conversations retain visible history and transfer a bounded text context when continued in a new native thread. Viewing imported Codex history does not install or start Codex.

Codex tool and instruction contracts belong to the original native thread. A changed contract starts a new thread and uses the same text handoff as a Codex import: the complete visible prefix and original thread references remain local, while at most 24,000 characters of explicitly untrusted text are passed to the model. Truncation is reported; tool results and runtime state are not reconstructed. A handoff stays pending until `turn/start` returns a turn ID, so failed starts can retry after restart. Native history is merged with the retained prefix by message identity. Only subsequent native messages support editing or branching; reverting the turn that carried the handoff makes it pending again.

Runtime scratch-file changes remain proposals until explicitly applied. Review compares the captured original source with the candidate, lists component, wire, definition and project-setting changes, and renders either version through Logisim without replacing a live simulation. Source comparison retains the exact XML. A proposal's original digest must match its recorded revision; an outdated proposal remains readable but cannot overwrite a newer draft. Whole-document application is one undo step and does not save the source file.

Project folders contain text, image and PDF previews. PDF character maps, fonts and decoding resources are bundled for offline viewing. Quoting selected text or a PDF page appends it to the conversation draft without sending it. The runtime can list and read text files in the bound project and inspect retained observations; binary documents are referenced through the preview. File operations reject paths escaping the open folder, including through symlinks.

File-tree menus provide path copying, revealing files in the system file manager, renaming, moving, and moving to the system trash. Dragging within the tree moves an entry into a folder. Mutations carry the project identity, reject existing destinations and self-descendant moves, and retain open document identity when paths change. Trashing a directory with an unsaved open draft is rejected; clean open documents close only after the OS trash operation succeeds. A symlink is moved or trashed as an entry without moving its target. Windows recycling explicitly requests `FOFX_RECYCLEONDELETE`; it does not fall back to permanent deletion.

The UI retains the established editor regions, 1–4 tool shortcuts, A for the palette, document dirty indicator, nearby undo controls and current-circuit simulation commands. Memory, trace and observation controls remain adjacent to the editing and simulation tasks they serve.

`simulate_circuit` evaluates independent input vectors against labeled output pins. `trace_circuit` starts a fresh sequential run with exact watched ports and tick-indexed input events. Both use a separate Java worker and request queue, leaving the visible simulation, source file and undo history untouched. Native errors discard that verification worker. Results carry their source revision; missing expectations remain unchecked, and unknown outputs do not pass numerical assertions.

For selection moves, the host prepares a candidate and compares Logisim's bit-net partitions before committing one undo step. A move that changes port connectivity is rejected. This check applies to selection movement; free wire drawing and direct source edits use their own edit paths.

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
npm run test:native
npm run test:compatibility
npm run build
npm run bundle:agent
```

`test:native` runs the Java adapter and Pi runtime against temporary circuits and a local HTTP model fixture. It requires no model credentials. Document, simulation and tool-transport scenarios are in [verify.mts](../scripts/workbench/verify.mts); routing scenarios are in [editing-scenarios.mts](../scripts/workbench/editing-scenarios.mts). Memory, trace and observation scenarios are in [simulation-scenarios.mts](../scripts/workbench/simulation-scenarios.mts). The independent [compatibility-check.mts](../scripts/workbench/compatibility-check.mts) workload covers custom symbols, local subcircuits, nested external `.circ` libraries, cross-directory Save As and a generated 3,072-component circuit. Provider compatibility and model behavior require separate checks. `test:runtime` verifies a local authenticated HTTP proxy and installer failure, cancellation and retry with synthetic archives. It does not download or log into Codex.

`test:files` runs on Linux with temporary project files and an isolated freedesktop trash. It checks move identity, undo preservation, stale-project and unsafe-path rejection, dirty-delete protection, and that trashed content remains recoverable. It does not manipulate the user's files or trash.

`node scripts/workbench/context-transfer-check.mts` replays the app-server request boundary with synthetic history. It checks failed-start retries, ACK handling, restart retention, bounded import/contract handoffs and prefix preservation through native edit/fork responses. It starts no runtime process and makes no model request; actual native protocol compatibility is checked separately.

`npm run test:codex` explicitly downloads the checksum-pinned optional Codex runtime and checks native history resume, fork position, inherited tool results and restart recovery in a temporary unauthenticated profile. It creates no model turns and does not inspect an existing account or conversation. This check is separate from the default checks because it downloads the optional runtime and requires the runtime's platform isolation support.

`bundle:agent` builds the Node application code and SDK into `.workbench-cache/agent-product`, with dependency notices. Set `VIBE_LOGISIM_AGENT_ROOT` to that absolute directory when running `test:native` to exercise the bundled code.

## Desktop packaging

Linux x64 and Windows x64 resources and packages are built on their respective platforms with:

```sh
npm run package:desktop
npm run test:product
npm run test:desktop
```

The first command downloads checksum-pinned inputs, builds a Java runtime with `jlink`, precompiles the compatibility bridge, bundles the Node adapter, and produces a Debian package under `target/release/bundle/deb` plus `.workbench-cache/Vibe-Logisim-linux-x64.tar.gz`. On Windows, the same command produces an NSIS installer under `target/release/bundle/nsis` and a portable `.workbench-cache/Vibe-Logisim-win32-x64.zip`. The installer includes WebView2 setup; the portable archive requires WebView2 already installed and starts with `start.cmd`.

The Linux archive starts with `start.sh`; it requires GTK 3 and WebKitGTK 4.1. Node.js, Java and the Logisim runtime are included. The application does not require a development checkout. Runtime licenses and Logisim source accompany the resources.

`test:product` copies those resources and the Rust host into a temporary directory outside the checkout, removes system runtimes from the child `PATH`, and runs the native editing, simulation, history-import and local-model scenarios. It does not exercise the desktop webview or prove compatibility with another Linux distribution.

`test:desktop` extracts the portable archive outside the checkout into a path containing spaces and non-ASCII characters, then starts the actual desktop twice with an isolated profile and no system runtimes on `PATH`. It requires the bundled frontend to mount and complete IPC, runs native NOT-gate vectors, starts the built-in runtime, and checks that reopening preserves the draft identity and revision. It requires a display server on Linux; CI uses Xvfb. This startup check does not replace interactive UI acceptance.

`VIBE_WORKBENCH_RESOURCES` selects an assembled resource directory. Packaged Tauri builds otherwise use the application resource directory; debug builds use the checkout. `VIBE_WORKBENCH_STATE` also applies to desktop builds. The Java bridge can reuse precompiled classes for the pinned jar or compile the included sources against another configured jar.

The [CI workflow](../.github/workflows/native-workbench.yml) runs integration and Linux/Windows packaging checks on pull requests. On an ephemeral Windows runner, it additionally builds a version `0.0.0` installer from the same source, installs it, upgrades to the current version, checks draft recovery through the installed desktop, and uninstalls it. The installed check uses Tauri's normal resource lookup, without a resource-directory override. This verifies installer upgrade mechanics; it does not claim migration from Electron. Package artifacts are uploaded only for manually triggered runs. Check reports omit machine paths and document identifiers.

The desktop installation check is opt-in through `VIBE_WORKBENCH_INSTALL_CHECK` and requires an explicit absolute `VIBE_WORKBENCH_STATE`. Both test scripts create their own temporary state; diagnostic webviews also keep their cache and local storage there. Normal application startup does not run the fixture. Linux packages should be built on the oldest supported distribution. Windows installation and upgrade results require an actual Windows workflow run.

The sidecar reads proxy environment variables first, then Windows Internet Settings or manual KDE/GNOME proxy settings. Model discovery, connection tests, built-in model requests and optional-runtime downloads share the same HTTP proxy transport; Codex receives matching proxy environment variables. Automatic proxy scripts are reported as unsupported instead of silently trying a direct connection. Proxy environment variables can be used with those setups. Native system settings are read at connection time, without changing OS settings.

## Validation boundaries

The local-model fixture verifies tool/image transport, project text access, observation access, conversation switching, rename/archive/restore, branching and message replacement. It does not prove remote provider compatibility or authenticated Codex model behavior. The separate locked-runtime check covers native resume and fork without an account. Session import deliberately excludes provider credentials.

Remaining release validation includes Windows installation and upgrades, compatibility with supported Linux distributions, broader course-runtime component coverage, and real-service Codex continuation. Synthetic checks cover a custom two-port symbol, local subcircuit navigation, two levels of relative `.circ` libraries, library changes between queries and explicit simulation restarts, malformed library rejection, and cross-directory Save As. External Java plugins, arbitrary custom symbols and complex processor/memory workloads remain outside that coverage. These checks are separate from the implemented editing, simulation, file, history and packaging paths. The published Electron host remains available until those migration checks are complete.

## Synthetic compatibility measurements

Run the independent workload against a release host to measure the native boundary:

```sh
cargo build -p vibe-workbench-host --bin vibe-workbench-host --release
VIBE_WORKBENCH_RESOURCES="$PWD" \
VIBE_VERIFY_HOST="$PWD/target/release/vibe-workbench-host" \
node scripts/workbench/compatibility-check.mts
```

The script creates and removes its own files. It reports host startup, native observation, 1,200 × 800 viewport rendering, simulation startup and acknowledged input changes. It uses no model service. The first native request may include Java bridge compilation. These are host API and JVM measurements, not webview frame rates or pointer-response measurements.

One Linux x64 release run of the 3,072-component, 2,048-wire combinational grid measured 53 ms to open, 3.16 s for the first complete observation, 353–417 ms for repeated observations, 37–93 ms for viewport rendering, 1.28 s to start simulation and 1.6–3.5 ms for acknowledged input changes. The observation payload was about 11.7 MB; first observation remains the slowest measured operation. These single-machine results are a workload baseline, not a performance comparison with the published desktop or a guarantee for other circuits.

Static observations are cached only within the immutable artifact and external-dependency set, with at most two 16 MB results for each of two loaded files. Changed external library contents invalidate read and independent-verification workers. A running interactive simulation retains its transient state; explicitly starting it again loads the current library contents in a new process.

Feedback diagnostics contain only version, platform, architecture and boolean runtime/recovery state. The dialog previews the exact JSON before export; replacing a selected target checks its observed digest. Opening the public feedback page requires an explicit save action and does not submit an issue. Release checks read the project’s public Atom feed with an eight-second timeout and a 2 MB limit, retain the automatic-check preference and never download or install an update. Development versions are identified as such instead of being reported as the latest release.
