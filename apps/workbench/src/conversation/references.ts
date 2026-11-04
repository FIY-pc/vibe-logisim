export type {
  ReferenceInput,
  ReferenceSummary,
  StoredReference,
  ReferenceRegion,
} from "../../../../packages/agent-runtime/src/conversations/reference-types";
import type { ReferenceInput } from "../../../../packages/agent-runtime/src/conversations/reference-types";
export type Quotation = {
  id: string;
  documentId: string;
} & (
  | { references: ReferenceInput[]; files?: never }
  | { files: { folderId: string; paths: string[] }; references?: never }
);
