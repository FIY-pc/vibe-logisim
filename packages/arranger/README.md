# arranger

Deterministic placement and routing of one Logisim circuit definition, plus the structural checks an arranged result must pass. Pure TypeScript: no I/O, no processes, no Java. The caller (AI tool or the editor's 整理 action) observes the circuit through the host, calls `arrange`, and applies the returned XML through the host; this package never sees a file.

## How it lays a circuit out

One netlist, one ELK layered graph, the method netlistsvg and most schematic generators use:

1. **Netlist** (`model.mts`, `buildModel`): from the host's observation (`Focus`), never from guessed geometry. Parts touching port to port move together as one unit; a Text within 60 px of a part is its caption and moves with it, and so is a Text by the part's own Tunnels (Tunnels whose copper reaches that part alone: a group heading over its flags). Parts that stay: pinned ones, the observation panel at the top of a sheet, parts standing on unfinished or independent copper, everything inside a frame drawn with wires. Each net is one record (ports, width, labels) and is drawn one way (`classifyNets`): a wire; a Tunnel at each port (nets the author drew with Tunnels on a sheet drawn with them, `keepTunnels`, `namedLinks`, controls reaching 12 ports, nets reaching a part that stays); a private constant at each port; or untouched.
2. **Bit-slice arrays** (`array.mts`): instances of one part, each fed bit k of a bus by a Splitter, giving bit k to another Splitter and joined to the next by a chain (a ripple adder of full-adder instances), are drawn ahead of the layout as a staircase: the instances step down to the right, each bit drops from its Splitter and turns into its instance, each output runs right and drops into its Splitter, the chain steps from one instance to the next, the Pins alone on the buses and the chain's ends stand beside them. The bits of one bus nest without crossing, and the array becomes one unit carrying its own wires. ELK cannot draw this itself: it puts a Splitter's bit ports in one block and bends each bit next to its instance, so the buses cross in a wedge. Only Splitters with their bits below (feeding ports on the left of the instances) or above (reading ports on the right) and bit 0 at the right end are drawn this way; any other array is left to ELK.
3. **Units** (`layout.mts`, `shapeUnit`): each unit is one ELK node holding its parts, captions and the Tunnels and constants of its ports, so nothing is placed or routed over them. Neighbouring flags that would overlap fan out up and down (sideways ports) or into a V (ports on top or bottom); constants of one value on neighbouring ports share a comb; a flag that would stand on the wire leaving a neighbouring wired port steps aside on a dog-leg lead when that is clear. Wired ports become `FIXED_POS` ELK ports at their real offsets.
4. **Placement and routing** (`runElk`): ELK layered, direction RIGHT, orthogonal routing, Brandes–Köpf placement, 10 px grid spacings. East-facing Pins take the first layer and west-facing Pins the last, in their drawn order; the signal flow (`flowOrder`) is the model order, so a ripple chain steps left to right instead of stacking in a column; a storage output that closes a loop to logic drawn before it counts as feedback, so a counter's register wire goes back around while the registers between pipeline stages keep their place. A net reaching several ports of one layer from further back gets a junction node in the layer before them, so it comes in as one trunk with short taps (a rail) instead of a line per port (`railsOf`); the layout with rails and the one without are both kept as candidates. On a tunnel sheet each row is laid out first with every net as an edge, and that order kept when only the wired nets are routed.
5. **Compaction** (`compaction.mts`, `compactRow`): ELK makes a layer as wide as its widest node, so each row is compacted across and then down without changing what crosses what.
6. **Connection rules** (`wiring.mts`): the routes are held against Logisim's rules; a net whose copper would join another net, touch a foreign port or cross a body is drawn with Tunnels instead and the layout runs again (at most 6 rounds); so is a wire net between rows.
7. **Emit** (`emit.mts`): moved parts get new locations, replaced Tunnels and constants are removed and new ones written, every wire is rewritten split at each bend and junction, group headings become real Text. It also returns the observation the file should load as (`predicted`), for scoring candidates before the host sees them.
8. **Choice** (`arrangement.mts`, `arrange`): the layout is made under several ELK variants (`VARIANTS`: seeds, model order on and off, the sketch's own order, longest-path layering; as many as fit about 400 unit-layouts), each with and without rails, and the one whose predicted drawing scores lowest is returned. The variants run in up to three families: with the array drawn ahead (when there is one), the parts one by one, and, when any flag stepped aside, the parts one by one with every flag in line; ELK's layout of a large sheet changes with the shape of any of its nodes, so neither of the last two is better everywhere.

With `options.organization` (`organization.mts`), each group is an ELK compound node with its heading (real Text, so the observation and the score see it) in its top padding; groups of one row are one graph, left to right in the given order (partitioning), rows stack from the top, a stage is a compound node around its groups. ELK's interactive strategies and its model-order cycle breaking do not work on nested graphs, so grouped rows use greedy cycle breaking and no model order.

## Owns

- `arrangement.mts`: `arrange(request)` → `Arrangement{xml, placement, predicted, report, …}`; `verifyArrangement`; identity and protection helpers (`identityMap`, `protectedNodes`, `interfaceOf`, `netlistSignature`, `copperPreserved`, `outsideUnchanged`).
- `model.mts`, `array.mts`, `layout.mts`, `wiring.mts`, `compaction.mts`, `emit.mts`, `organization.mts` (`organizationContext`: the placement graph a caller organizes), `elk-worker.mts` (ELK's layered core in-process), `circuit.mts` (attributes, Logisim geometry the engine writes itself, interface signature, `spliceCircuit`), `xml.mts` (parse/serialise like ElementTree; the rest of the file stays byte for byte), `fixed-geometry.mts`, `loose-wires.mts` (`assertFloatingIsolation`).
- `readability.mts`: `readability(focus)` measures a drawing as it loads (crossings, bends, close parallels, wires over bodies, wires grazing ports, labels on wires, overlapping bodies and labels, pins facing away from their net) and weighs them into one `score` (`READABILITY_WEIGHTS`); `compareReadability(before, after)` says whether a drawing is clearer and which measures got worse; `READABILITY_NAMES` names the measures for messages.
- `tool-errors.mts`: `CircuitToolError`, `ERROR_SCHEMA` (shared error shape for model-facing tools).
- `types.mts`: `Component`, `Wire`, `End`, `NetBit`, `Bounds`, `Focus`, `Attribute` as observed by the host's `observe` op.

## Does not own

Deciding _when_ to arrange, applying results, verifying against the real runtime (host `observeXml` before apply), user interaction.

## Public interface

```ts
import {
  arrange,
  verifyArrangement,
  readability,
  compareReadability,
  READABILITY_NAMES,
  organizationContext,
  resolveUnknownWidths,
  assertFloatingIsolation,
  CircuitToolError,
  ERROR_SCHEMA,
} from "@vibe-logisim/arranger";
const result = await arrange({ xml, circuit, focus, options });
// xml: the whole .circ file; circuit: the definition to arrange; focus: the host's observe result for it;
// options (Report): organization, pinnedComponentIds, keepTunnels, localiseConstants, panelBelowY.
result.xml; // the whole file with this definition rearranged, every other byte unchanged → host edit {kind:"replace"}
result.placement; // componentId -> [dx, dy] for every part the engine moved
result.fixedComponentIds; // pinned parts, loose-wire anchors, the panel and frames, kept in place
result.predicted; // the observation the result should load as (scored before anything is applied)
result.report; // engine "elk", variant, units/parts/nets by kind, tunnels added/removed, rounds, elkMs, drawnWithTunnels, candidates (every layout tried with its score); layoutGroups/layoutStages with organization
const checks = verifyArrangement(result, observedAfter); // netlist signature, interface, protected nodes; throws CircuitToolError
checks.readabilityBefore; checks.readabilityAfter; // readability of the two native observations
compareReadability(before, after); // {clearer, worse: [metric], better: [metric]}: apply only when clearer
```

Never worse than not arranging: callers observe the arranged XML natively (`observeXml`), verify it, and apply it only when `compareReadability(checks.readabilityBefore, checks.readabilityAfter).clearer`; otherwise the file stays as it is and the caller says which measures would have got worse. The AI's `arrange_circuit` and the editor's 整理 both follow this. ELK runs in a worker: `packages/agent-runtime/src/tools/layout.mts` (`arrangeInWorker`, Node `worker_threads`, 60 s) and `apps/workbench/src/editor/arrange.ts` (browser module worker).

## Invariants and Logisim pitfalls

- The netlist signature of the output equals the input's (`netlistSignature`); `verifyArrangement` throws otherwise and the caller must not keep the result. Constants of one value and width may share copper (they drive the same value).
- Protected nodes (interface pins, nodes the request names) keep their coordinates; without a custom appearance the Pins keep their order per facing, so instances keep their ports.
- Emitted wires are split at every bend and junction: Logisim joins wires only at their ends, and its load-time repair merges collinear ends, so a straight wire with branches ending on its middle would not connect as drawn.
- Every size, offset and spacing given to ELK is a multiple of the 10 px grid, so its coordinates come back on the grid; a layout off the grid is discarded.
- Bodies may graze by 1–8 px on neighbouring grid cells; collision means at least 10 px overlap both ways. A sideways Tunnel's body is 23 px tall (y − 11 to y + 12).
- Component and circuit names never influence the layout. Output is deterministic for identical input.
- Readability counts what a reader trips over, on the drawing as Logisim loads it: two wires of different nets 10 px apart side by side, a wire across or touching a body it does not connect to, a wire of another net within 10 px of a port, a wire through a label, bodies overlapping by 10 px both ways or a label on a body or label by 3 px, a Pin facing away from another port of its net, crossings and bends. Lower `score` is clearer; weights are `READABILITY_WEIGHTS` plus one point per 200 px of wire. Each measure has a before/after fixture in `test/fixtures/readability/`.

## Dependencies

`elkjs` 0.12 only.

## Status

Used by the AI's `arrange_circuit` and the editor's 整理. Measured through the host (native observation of the arranged file, score before → after, lower is clearer): full adder 54.9 → 23.3, 2:1 mux 39.5 → 11.5, 4:1 mux 235.5 → 72.7, 2-to-4 decoder 156.7 → 51.3 (15 → 11 crossings), 4-bit ripple adder 203.7 → 91.1 (a staircase), 3-bit counter 222.6 → 47.4, ripple adder of full-adder instances 335.8 → 49.9. A 4-bit adder of four full-adder instances fed by two Splitters into a third: 118.5 → 82.7 (a staircase; crossings 17 → 12, bends 39 → 25, wire 5690 → 4330 px, no Tunnels); grouped by bit with Tunnels between the groups, 43.7 → 35.2 (no flag on a wire), and arranging that grouped drawing again without groups keeps each heading over its group, 43.7 → 31.5. Hand-drawn sheets drawn with Tunnels come out clearer: 80–300 parts 1057 → 487, 961 → 293, 675 → 228 and a 303-part single-cycle CPU 1102 → 479; smaller ones 447 → 237, 583 → 109; a 713-part pipeline sheet 2991 → 1206 in about 7 s, its stages still left to right. One 97-part sheet stays as it is: the small drawing under its observation panel is mostly Tunnels and constants, so it is taken for part of the panel.

## Remaining tasks

1. Adjacent Tunnels on a part's ports 10 px apart with wired ports right above and below them (many-input gates) have no room to fan out, and their flags overlap as in the hand drawing; a single flag on a wired port's wire steps aside, two between wired ports do not. Making such flags their own small ELK nodes, with the lead an ELK edge, would let crossing minimisation place them.
2. Many output Pins fed from neighbouring ports of one part stand in a tall column with long leads; a hand drawing puts them in a staircase next to the ports. That is a satellite like the Tunnel fans, with Pins instead of flags.
3. On the 713-part pipeline sheet the stages read left to right, but the fetch and decode parts, joined to each other by Tunnels rather than wires, fill a block on the left about three times as tall as the rest of the sheet. Packing Tunnel-joined parts by their drawn position, or wrapping a layer that grows far taller than its neighbours, would even it out.
4. A row of instances, the textbook drawing of a ripple adder, needs each Splitter's bit 0 at the end nearest the first instance. A Splitter facing south and left-handed has bit 0 at its right end, so its bits would cross each other in a row; the array is drawn as a staircase instead, and the 12 crossings left on the 4-bit adder are the ones the ports' order forces (B's bits across A's, the carry across the next instance's A and B). Turning a Splitter around (facing, appearance) is an attribute change the arranger does not make. Arrays whose Splitters face other ways are left to ELK.
5. The family with every flag in line doubles the layouts tried on a sheet where a flag stepped aside: the 303-part sheet takes about 7 s instead of 5, the 713-part sheet 7 s instead of 5.5.

## Verify

```sh
npm run test:arranger   # equivalence checks, split junctions, headings clear, the scores of six small circuits, the bit-slice array
npm run check -w @vibe-logisim/arranger
```
