# arranger

Deterministic placement and routing of one Logisim circuit definition, plus the structural checks an arranged result must pass. Pure TypeScript: no I/O, no processes, no Java. The caller (AI tool or the editor's 整理 action) observes the circuit through the host, calls `arrange`, and applies the returned XML through the host; this package never sees a file.

## Owns

- `arrangement.mts`: `arrange(request)` → `Arrangement{xml, placement, predicted, report, …}`; `verifyArrangement`; identity and protection helpers (`identityMap`, `protectedNodes`, `interfaceOf`, `netlistSignature`, `copperPreserved`, `outsideUnchanged`).
- `readability.mts`: `readability(focus)` measures a drawing as it loads (crossings, bends, close parallels, wires over bodies, wires grazing ports, labels on wires, overlapping bodies and labels, pins facing away from their net) and weighs them into one `score` (`READABILITY_WEIGHTS`); `compareReadability(before, after)` says whether a drawing is clearer and which measures got worse; `READABILITY_NAMES` names the measures for messages; `predictedFocus` builds the observation an arranged file should load as, for scoring candidates before the host sees them.
- `flow-layout.mts`: `flowLayout(xml, circuit, focus, variant)` lays out a small definition by signal flow with ELK's layered algorithm (inputs left, outputs right, gates in columns, every connection a wire, parallel wires 20 px apart), the way gate-level circuits are drawn by hand.
- Layout pipeline (column engine, for sheets): `organization.mts` (`organizationContext`: stages, banks, control groups from names and nets), `grouped-layout.mts` + `layout-solver.mts` (`solveGroups`: group placement with ELK via `elk-layout.mts`/`elk-worker.mts`), `stage-packing.mts`, `group-packing.mts`, `bank-order.mts`, `compaction.mts`, `fixed-geometry.mts`/`grouped-geometry.mts` (component bodies from observed bounds), `schematic-layout.mts` (`resolveUnknownWidths`), `routing.mts` + `control-routing.mts` + `wire-geometry.mts` (orthogonal routing, tunnel columns for long spans), `loose-wires.mts` (`assertFloatingIsolation`), `layout-annotations.mts`, `xml.mts` (emit `<comp>`/`<wire>` for one `<circuit>`).
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
  compareReadability,
  READABILITY_NAMES,
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
result.predicted; // the observation the result should load as (scored before anything is applied)
result.report.engine; // "flow" or "columns"; result.report.candidates lists every layout tried with its score
const checks = verifyArrangement(result, observedAfter); // netlist signature, interface, protected nodes; throws CircuitToolError
checks.readabilityBefore; checks.readabilityAfter; // readability of the two native observations
readability(focus); // {crossings, bends, closeParallels, wireOverBody, portGrazes, labelsOnWires, overlaps, labelOverlaps, pinsOffSide, score, …}
compareReadability(before, after); // {clearer, worse: [metric], better: [metric]}: apply only when clearer
```

Which layout: a definition without free text, unfinished wires or stacked copies, of at most 80 parts other than Tunnels and at most max(2, parts / 10) Tunnels (a sheet drawn with tunnels stays a sheet), arranged without explicit organization, pins, kept tunnels, panel or spacing options, is laid out by signal flow and once by the column engine, and the candidate whose predicted drawing has the lowest readability score wins. Anything else goes to the column engine alone, as before. Signal flow is ELK layered with Brandes–Köpf node placement on a 10 px grid; input Pins in the first layer and output Pins in the last, in their drawn order. ELK's crossing minimisation depends on its random seed and on the model order, so `FLOW_VARIANTS` tries the sketch's own order, network-simplex layering under several seeds with and without model order, and longest-path layering, as many as fit 400 part-layouts (all nine up to 44 parts, five at 80); each takes 10–80 ms.

Never worse than not arranging: callers observe the arranged XML natively (`observeXml`), verify it, and apply it only when `compareReadability(checks.readabilityBefore, checks.readabilityAfter).clearer`; otherwise the file stays as it is and the caller says which measures would have got worse. The AI's `arrange_circuit` and the editor's 整理 both follow this.

ELK runs in a worker (`elk-worker.mts`); callers wanting isolation use `packages/agent-runtime/src/tools/layout.mts` (`arrangeInWorker`, Node `worker_threads`) or `apps/workbench/src/editor/arrange.ts` (browser module worker).

## Invariants and Logisim pitfalls

- The netlist signature of the output equals the input's (`netlistSignature`); `verifyArrangement` throws otherwise and the caller must not keep the result.
- Protected nodes (interface pins, nodes the request names) keep their coordinates.
- Storage and stage boundaries come from the observation alone: `storage` on a component (`delay` for registers, flip-flops and subcircuits whose every input only reaches storage inside; `state` for counters, random sources and storage that feeds itself) and `registered` on the input ends of subcircuit instances. Component and circuit names never influence the layout. A sheet is laid out stage by stage only when at least two register-to-register stages each hold max(3, 10 %) of its parts; otherwise registers are ordinary nodes of the flow.
- Emitted wires are split at every junction so a `+` crossing is never produced (Logisim's WireRepair would merge it).
- Bodies may graze by 1–8 px on neighbouring grid cells; collision means at least 10 px overlap both ways.
- Spans longer than `options.tunnelSpan` become tunnel pairs instead of wires, matching how course circuits are drawn by hand.
- Output is deterministic for identical input; tests compare XML byte for byte.
- Readability counts what a reader trips over, on the drawing as Logisim loads it: two wires of different nets 10 px apart side by side (wires fed into neighbouring ports of one part excepted, the ports force it), a wire across or touching (within 2 px) a body it does not connect to, a wire of another net within 10 px of a port, a wire through a label, bodies overlapping by 10 px both ways (1–8 px grazes between neighbours are not counted) or a label on a body or label by 3 px, a Pin facing away from another port of its net (an east-facing Pin with one to its west, and so on), crossings and bends. Lower `score` is clearer; weights are `READABILITY_WEIGHTS` plus one point per 200 px of wire. Each measure has a before/after fixture in `test/fixtures/readability/`.

## Dependencies

`elkjs` 0.12 only.

## Status

Ported from the v0.5.0 Python arranger with its fixtures, plus the signal-flow layout and the readability measure; 23 tests (`npm run test:arranger`). Used by the AI's `arrange_circuit` and the editor's 整理, both of which apply a layout only when it reads more clearly.

## Remaining tasks

1. Done: `arrange_circuit` observes the arranged XML through the host's `observeXml` and runs `verifyArrangement` before anything is applied; a rejected layout never touches the file. The editor's 整理 does the same in its worker.
2. Measured on a 713-component, 1000-wire definition of a 1 MB file (dev Node 24, sidecar): a scripted place, connect, move and arrange turn takes about 4 s, `arrange_circuit` 1.5 s of it (column engine; the flow layout is not tried on a sheet that size). `readability` before and after 100 ms. What is left is the router: `Router.path` (A*) is half of `arrange`; the next gain is there, not in ELK.
3. Done: readability measures for small circuits, each with a before/after fixture (`test/fixtures/readability/<measure>.circ`, `test/readability.test.mts`); when adding a measure, add one there. Scripted gate-level circuits, score before → after arranging (native observation): full adder 54.9 → 24.3, 2:1 mux 39.5 → 11.6, 4:1 mux 235.5 → 73.9, 2-to-4 decoder 156.7 → 77.6, 4-bit ripple adder 203.7 → 102.3, 3-bit counter 222.6 → 48.2; every one with no wire grazing a port, no close parallels, no overlaps, no label on a wire, no pin facing away.
4. Decoders and other circuits whose inputs fan out to every gate still cross a lot (the 2-to-4 decoder goes from 15 to 16 crossings while its grazes and close parallels go away): a hand drawing runs each input and its complement down a vertical rail and taps it; ELK has no notion of rails.
5. Mid-size sheets drawn with tunnels (about 80–300 parts) arrange no clearer than drawn by hand with the column engine, so the never-worse rule leaves them as they are. Making the column engine beat a hand-drawn tunnel sheet is the next step for sheets.

## Verify

```sh
npm run test:arranger
npm run check -w @vibe-logisim/arranger
```
