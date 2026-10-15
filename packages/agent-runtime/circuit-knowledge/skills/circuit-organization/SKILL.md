---
name: circuit-organization
description: Build, extend or organize readable teaching circuits, including ordinary course assignments and from-scratch construction without an explicit layout request. Use for substantial circuit construction or layout changes; a local logic fix only needs review of the affected area.
---

# Circuit organization

Deliver a circuit that a person can trace, explain and continue editing. Functional correctness, preservation of required structures, and readable organization must all be satisfied before claiming completion. Use the user's actual circuit and constraints; no CPU-specific template or universal group count is assumed.

## Understand what can change

- Identify the requested definitions, external interfaces, existing useful organization and explicitly protected objects or paths. A geometric top-panel detector only suggests protection; it cannot interpret a course requirement.
- For a template, retain a baseline and the concrete protected objects before changing them. Direct XML edits have no automatic fixed-object guarantee. A submit receipt lists definition changes, not proof that a fixed panel survived.
- Preserve the user's scope. A small repair need not rearrange an otherwise readable circuit. For a complete build, keep track of all newly created or substantially changed definitions, including subcircuits completed earlier in the turn.

## Choose organization while constructing

Identify the main signal path and the smallest independently understandable operations. Place related field extraction, constants and small terminal logic close to their users. A small connected operation usually needs one group; one heading per symbol obscures it.

Before building a large definition, record a short organization intent in CIRCUIT-WORK.md: what the reader follows first, which actual parts implement each operation, which branches belong beside it, and which connections should remain directly visible. This can evolve with the design. A stage label alone is not an implemented functional group; find the parts that perform the operation. Keep author notes separate from electrical membership. Maintain behavior/protection/diagram work per changed definition so a completed child does not disappear from the final review scope.

For a larger circuit, separate the main path from its control, monitoring and display branches. Attach each branch near what it explains. Repeated register/lane banks benefit from regular spacing and aligned fields. Use stages only when they express the circuit's meaning; do not force all branches into a single horizontal strip.

Choose connection representation by the reader's tracing task:

- Keep useful local relationships visible with short wires. Naming every adjacent connection can produce zero crossings while forcing the reader to mentally reconstruct the entire circuit.
- Use named remote references where a long wire adds more clutter than information. Give them recognizable, consistent names and preserve enough visible main-path structure to explain the circuit. Ctrl/Cmd+click in the workspace can navigate a signal's source and uses within the current definition.
- For repeated shared controls, prefer a straight trunk with short branches when there is a clear corridor. Do not replace an already legible CLK/RST comb with winding routes simply to reduce the number of tunnels. Named endpoints remain useful where a clean trunk does not fit.
- Bring a small output/terminal operation toward its producer instead of stretching a long wire just to reach a label.

Reserve space for native symbols **and their labels/value displays**, not just anchor coordinates. Bus Pins can be taller than their anchor spacing suggests. A label attached directly to a port can overlap its host or a neighboring flag. Obtain actual bounds or view the native rendering instead of guessing text width from the number of characters.

## Realize the plan

The built-in grouped arranger is available to turn semantic groups into geometry, local wires and named remote links, with native connectivity and interface checks. Read [the arrangement reference](references/arrangement.md) when using it. Direct `.circ` edits, scripts and alternative methods remain valid; the same delivery standard applies to their outputs.

An arrangement candidate has not been applied until `checkout_candidate` writes it. Direct file edits are already on disk; `submit_circuit` refreshes the shared canvas and gives a bounded diagnostic receipt. Neither action establishes intended behavior.

## Review the actual deliverable

When a layout is disappointing, name the specific reading problem and retain what already works. Compare a proposed revision against the last useful candidate, including its structure and tracing effort. These observed cases illustrate the decisions:

- A bank has a straight shared-control trunk and short branches, but one label overlaps. Repair the label reservation or nearby spacing; replacing the trunk with winding branches or one Tunnel per pin loses the original advantage.
- A staged page is too wide because a long author legend occupies a bank cell and branches stack in one column. Separate the annotation and adjust group/stage packing. Deleting the stages and protecting every signal as named-only may shrink the page while making the main operation harder to follow.
- A small terminal output sits at the end of a long empty wire. Move the terminal toward its producer, preserving the local motif. A remote multi-consumer reference may instead justify a named link; the decision follows what the reader needs to trace.

These are reasoning examples, not permission to change protected structures or mandatory choices for every circuit. Each revision should fix its stated problem without surrendering useful organization. The arranger's representationChoices and annotationOnlyGroups help expose such tradeoffs; they do not choose the semantic plan for you.

Use `inspect_circuit({circuit: "<exact definition name>", layoutReview: {}})` for compact, read-only evidence on the working file or an optional `candidateId`. It works without calling the arranger. The result identifies overlapping bounds and suggested `render_circuit` viewports. `readingPaths.nearbyNamedLinks` gives actual source/consumer ports with identical native bit nets but separate copper paths joined by the same Tunnel label. These examples identify a possible hidden local relationship, not a wiring prescription or a full graph: split/recombined buses, ambiguous drivers and recognized control ports are excluded. Submit includes the same review for the active definition and lists other changed definitions; this is not coverage of the whole task.

View the main diagram and newly created/substantially changed definitions at a scale where labels can be read. In a large diagram, use the reported local viewports or your own regions; a scaled-down whole-sheet image can hide dense pin and label collisions. Cover useful regions beyond the first bounded examples if the report is truncated.

Perform a reading task on the image: select a real principal signal and follow its producer, intervening operations/state and consumer. Identify the visible path and named jumps you actually used. If you can explain it only from the generator code or by searching a name on every adjacent port, the diagram has not yet made that relationship readable. Stage headings, aligned columns and zero connectivity warnings do not answer this question. Decide which jumps are useful remote references and which should become a connected local operation. Use the native port graph when a connection is uncertain.

Turn a confirmed reading problem into an edit and recheck its effect. Repeated label-on-port collisions or disconnected operations usually call for fixing the generating pattern or using grouped arrangement, not shrinking all text or inspecting another copy of the same pattern. Resolve overlaps that actually obscure reading; native rectangles can intersect without their visible strokes colliding. Preserve intentional contacts, protected structures and useful existing paths. Keep a short defect → decision → result note for meaningful revisions, with remaining problems still open. A render call or a lower warning count cannot close them.

After structural edits, establish behavior separately, including required observation/control features. After layout-only edits, preserve connectivity and interfaces. Judge the saved file, including changed subcircuits, before claiming completion. If genuinely blocked, state what remains unfinished and why; do not silently recast an unfinished diagram as optional polish.
