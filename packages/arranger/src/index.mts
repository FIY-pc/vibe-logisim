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
  readability,
  READABILITY_NAMES,
  READABILITY_WEIGHTS,
} from "./readability.mts";
export type { Readability, ReadabilityComparison } from "./readability.mts";
export { resolveUnknownWidths } from "./circuit.mts";
export type { Report } from "./circuit.mts";
export { assertFloatingIsolation } from "./loose-wires.mts";
export { organizationContext } from "./organization.mts";
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
