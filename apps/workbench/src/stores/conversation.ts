import { createStore } from "zustand/vanilla";
import type { Quotation } from "../lib/references";
import { field, type Update } from "./setter";

export interface ConversationState {
  /** References queued for the conversation composer; it clears them once taken. */
  quotation: Quotation | null;
  setQuotation(quotation: Update<Quotation | null>): void;
}

export function createConversationStore() {
  return createStore<ConversationState>()((set) => ({
    quotation: null,
    setQuotation: field(set, "quotation"),
  }));
}
