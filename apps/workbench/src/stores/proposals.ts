import { createStore } from "zustand/vanilla";

/** A proposal the user discarded. */
export interface DiscardedProposal {
  documentId: string;
  proposalId: string;
}

export interface ProposalsState {
  /** The proposal discarded last in this workbench. Every proposal list
   * (useProposals) keeps its own records and drops this one when it changes. */
  discarded: DiscardedProposal | null;
  setDiscarded(documentId: string, proposalId: string): void;
}

export function createProposalsStore() {
  return createStore<ProposalsState>()((set) => ({
    discarded: null,
    setDiscarded: (documentId, proposalId) =>
      set({ discarded: { documentId, proposalId } }),
  }));
}
