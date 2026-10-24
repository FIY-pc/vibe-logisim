# arranger

Deterministic placement and routing of one Logisim circuit definition, plus the structural checks an arranged result must pass. Pure TypeScript: no I/O, no processes, no Java. The caller (AI tool or the editor's 整理 action) observes the circuit through the host, calls `arrange`, and applies the returned XML through the host; this package never sees a file.

## Owns

- `arrangement.mts`: `arrange(request)` → `Arrangement{xml, placements, checks, readability}`; `verifyArrangement`; identity and protection helpers (`identityMap`, `protectedNodes`, `interfaceOf`, `netlistSignature`, `copperPreserved`, `outsideUnchanged`); `readability` (crossings, label overlaps, flag wires, stagger, aligned runs).
- Layout pipeline: `organization.mts` (`organizationContext`: stages, banks, control groups from names and nets), `grouped-layout.mts` + `layout-solver.mts` (`solveGroups`: group placement with ELK via `elk-layout.mts`/`elk-worker.mts`), `stage-packing.mts`, `group-packing.mts`, `bank-order.mts`, `compaction.mts`, `fixed-geometry.mts`/`grouped-geometry.mts` (component bodies from observed bounds), `schematic-layout.mts` (`resolveUnknownWidths`), `routing.mts` + `control-routing.mts` + `wire-geometry.mts` (orthogonal routing, tunnel columns for long spans), `loose-wires.mts` (`assertFloatingIsolation`), `layout-annotations.mts`, `xml.mts` (emit `<comp>`/`<wire>` for one `<circuit>`).
- `tool-errors.mts`: `CircuitToolError`, `ERROR_SCHEMA` (shared error shape for model-facing tools); `py.mts` (`PyValueError`, kept for the ported Python logic's error texts).
- `types.mts`: `Component`, `Wire`, `End`, `NetBit`, `Bounds`, `Focus`, `Attribute` as observed by the host's `observe` op.

## Does not own

Deciding _when_ to arrange, applying results, verifying against the real runtime (host `observe` after apply), user interaction.

## Public interface

```ts
import {
  arrange,
  verifyArrangement,
  readability,
  organizationContext,
  solveGroups,
  resolveUnknownWidths,
  assertFloatingIsolation,
  CircuitToolError,
  ERROR_SCHEMA,
} from "@vibe-logisim/arranger";
const result = await arrange({ xml, circuit, focus, options, solve });
// xml: the whole .circ file; circuit: the definition to arrange; focus: the host's observe result for it;
// options (Report): organization, pinnedComponentIds, keepTunnels, localiseConstants, panelBelowY, columnGap, maxLayerSpan, tunnelSpan;
// solve: group solver, default solveGroups.
result.xml; // the whole file with this definition rearranged, every other byte unchanged → host edit {kind:"replace"}
result.placement; // componentId -> [dx, dy] for every part the engine moved
result.fixedComponentIds; // pinned parts, loose-wire anchors and the panel, kept in place
verifyArrangement(result, observedAfter); // netlist signature, interface, protected nodes; throws CircuitToolError
readability(focus); // crossings, label overlaps, flag wires, stagger, aligned runs
```

ELK runs in a worker (`elk-worker.mts`); callers wanting isolation use `packages/agent-runtime/src/tools/layout.mts` (`arrangeInWorker`, Node `worker_threads`) or `apps/workbench/src/editor/arrange.ts` (browser module worker).

## Invariants and Logisim pitfalls

- The netlist signature of the output equals the input's (`netlistSignature`); `verifyArrangement` throws otherwise and the caller must not keep the result.
- Protected nodes (interface pins, nodes the request names) keep their coordinates.
- Storage and stage boundaries come from the observation alone: `storage` on a component (`delay` for registers, flip-flops and subcircuits whose every input only reaches storage inside; `state` for counters, random sources and storage that feeds itself) and `registered` on the input ends of subcircuit instances. Component and circuit names never influence the layout. A sheet is laid out stage by stage only when at least two register-to-register stages each hold max(3, 10 %) of its parts; otherwise registers are ordinary nodes of the flow.
- Emitted wires are split at every junction so a `+` crossing is never produced (Logisim's WireRepair would merge it).
- Bodies may graze by 1–8 px on neighbouring grid cells; collision means at least 10 px overlap both ways.
- Spans longer than `options.tunnelSpan` become tunnel pairs instead of wires, matching how course circuits are drawn by hand.
- Output is deterministic for identical input; tests compare XML byte for byte.

## Dependencies

`elkjs` 0.12 only.

## Status

Ported from the v0.5.0 Python arranger with its fixtures; 13 tests (`npm run test:arranger`). Used by the AI's `arrange_circuit` and the editor.

## Remaining tasks

1. Done: `arrange_circuit` observes the arranged XML through the host's `observeXml` and runs `verifyArrangement` before anything is applied; a rejected layout never touches the file.
2. Measured on a 713-component, 1000-wire definition of a 1 MB file (dev Node 24, sidecar): `arrange` 650–800 ms, `readability` before and after 70 ms, `verifyArrangement` 100 ms (300 ms before `circuitElement` kept the last two files parsed), the whole `arrange_circuit` call about 1.6 s including observation, worker start and apply. Within budget. What is left is the router: `Router.path` (A*) is half of `arrange`; the next gain is there, not in ELK.
3. Readability metrics were calibrated on hand-drawn course circuits; when adding a metric, add a fixture under `test/fixtures` that shows the before/after.

## Verify

```sh
npm run test:arranger
npm run check -w @vibe-logisim/arranger
```
