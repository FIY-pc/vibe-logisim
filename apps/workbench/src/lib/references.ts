export type {
  ReferenceInput,
  ReferenceSummary,
  StoredReference,
} from "../../../../packages/agent-runtime/src/reference-types";
import type { ReferenceInput } from "../../../../packages/agent-runtime/src/reference-types";
export interface Quotation {
  id: string;
  documentId: string;
  references: ReferenceInput[];
}
