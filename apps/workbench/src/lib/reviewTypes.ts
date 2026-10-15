import type { ProposalReview } from "../generated/ProposalReview";
import type { VerificationRecord as NativeVerificationRecord } from "../generated/VerificationRecord";
import type { ComparisonObject } from "../generated/ComparisonObject";
import type { Bounds } from "./types";
export type { HistoryEntry } from "../generated/HistoryEntry";
export type { HistoryList } from "../generated/HistoryList";
export type { ProposalChange as ReviewChange } from "../generated/ProposalChange";
export type { ComparisonDetail } from "../generated/ComparisonDetail";
export type { ConnectionEndpoint } from "../generated/ConnectionEndpoint";
export type ReviewObject = ComparisonObject;
export type VerificationRecord = Omit<NativeVerificationRecord, "result"> & {
  result: VerificationResult;
};
interface Value {
  bits: string;
  value: number | null;
}
export interface VerificationResult {
  passed?: number;
  failed?: number;
  unchecked?: number;
  completed?: boolean;
  requestedTicks?: number;
  rows?: {
    index: number;
    inputs: Record<string, number>;
    expected: Record<string, number>;
    outputs: Record<string, Value>;
    oscillating: boolean;
    status: "passed" | "failed" | "unchecked";
  }[];
  samples?: {
    tick: number;
    oscillating: boolean;
    signals: Record<string, Value>;
  }[];
}
export type Review = Omit<ProposalReview, "evidence"> & {
  evidence?: VerificationRecord[];
};
export interface ReviewPreview {
  image: string | null;
  missing: boolean;
  warnings?: string[];
  bounds?: Bounds;
}
export interface LocateChange {
  circuit: string;
  revision: string;
  object: ReviewObject;
}
