export type {
  ReferenceInput,
  ReferenceSummary,
  StoredReference,
} from "../../../../packages/agent-runtime/src/conversations/reference-types";
import type { ReferenceInput } from "../../../../packages/agent-runtime/src/conversations/reference-types";
export interface Quotation {
  id: string;
  documentId: string;
  references: ReferenceInput[];
}
