# Circuit diagnostics

Read-only geometric measures over a circuit as the native Logisim runtime observes it. The agent exposes them through `inspect_circuit({layoutReview: {}})`.

`readability(focus)` reports component and wire counts, extents, crossings, bends, close parallel wires, wires over bodies or labels, port grazes, body/label overlaps and pin directions. Existing thresholds, weights and the aggregate `score` are retained for continuity. They are heuristic review signals, not a guarantee that a drawing is readable or a criterion for applying edits. In particular, labels use bounding approximations and some connected wires are excluded.

The package does not lay out components, route wires, rewrite XML or apply changes. Native observations and rendered views remain the evidence for reviewing a finding. Automatic arrangement and its candidate-selection/application logic have been removed.

`src/readability.mts` owns the measures; `src/circuit.mts` provides observed attribute and net-key helpers; `src/types.mts` describes their native inputs. `test/fixtures/readability/` retains the native before/after observations and circuits for each measure. There are no runtime dependencies.

```sh
npm run test:diagnostics
```
