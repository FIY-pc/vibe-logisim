// Deterministic placement and routing of one Logisim circuit definition, and
// the structural checks an arranged definition must pass. Pure: no I/O, no
// processes, no Java. The caller observes files natively and keeps the
// results.
export {
  arrange,
  copperPreserved,
  identityMap,
  interfaceOf,
  netlistSignature,
  outsideUnchanged,
  protectedNodes,
  verifyArrangement,
} from "./arrangement.mts";
export type {
  ArrangeRequest,
  Arrangement,
  ArrangementChecks,
  IdentityMap,
  NetGroup,
  NetlistSignature,
} from "./arrangement.mts";
export {
  compareReadability,
  predictedFocus,
  readability,
  READABILITY_NAMES,
  READABILITY_WEIGHTS,
} from "./readability.mts";
export type { Readability, ReadabilityComparison } from "./readability.mts";
export type { GroupSolver } from "./grouped-layout.mts";
export { solveGroups } from "./layout-solver.mts";
export { assertFloatingIsolation } from "./loose-wires.mts";
export { organizationContext } from "./organization.mts";
export { PyValueError } from "./py.mts";
export { resolveUnknownWidths } from "./schematic-layout.mts";
export type { Report } from "./schematic-layout.mts";
export { CircuitToolError, ERROR_SCHEMA } from "./tool-errors.mts";
export type {
  Attribute,
  Bounds,
  Component,
  End,
  Focus,
  NetBit,
  Wire,
  WireBundle,
  XY,
} from "./types.mts";
