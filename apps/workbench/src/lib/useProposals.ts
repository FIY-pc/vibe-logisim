import { useCallback, useEffect, useRef, useState } from "react";
import { command } from "./transport";
import type { SourceProposal } from "../components/ProposalReview";
const discardedListeners = new Set<
  (documentId: string, proposalId: string) => void
>();
export function useProposals(
  documentId: string | undefined,
  connection: number,
  onError: (error: unknown) => void,
) {
  const [records, setRecords] = useState<Record<string, SourceProposal[]>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const epochs = useRef(new Map<string, number>());
  const bump = (id: string) =>
    epochs.current.set(id, (epochs.current.get(id) || 0) + 1);
  useEffect(() => {
    const discarded = (id: string, proposalId: string) => {
      bump(id);
      setRecords((old) => ({
        ...old,
        [id]: (old[id] || []).filter((item) => item.id !== proposalId),
      }));
    };
    discardedListeners.add(discarded);
    return () => {
      discardedListeners.delete(discarded);
    };
  }, []);
  const receive = useCallback((proposal: SourceProposal) => {
    if (!proposal.id || !proposal.documentId) return;
    bump(proposal.documentId);
    setRecords((old) => ({
      ...old,
      [proposal.documentId]: [
        ...(old[proposal.documentId] || []).filter(
          (item) => item.id !== proposal.id,
        ),
        proposal,
      ].sort((a, b) => a.createdAt - b.createdAt),
    }));
  }, []);
  useEffect(() => {
    if (!documentId) return;
    let live = true;
    void (async () => {
      while (live) {
        const epoch = epochs.current.get(documentId) || 0;
        const result = await command<SourceProposal[]>({
          op: "agent",
          method: "proposals",
          args: { documentId },
        });
        if (!live) return;
        if (epoch !== (epochs.current.get(documentId) || 0)) continue;
        if (!Array.isArray(result))
          throw new Error("候选列表格式无效，请重新连接运行时");
        setRecords((old) => ({
          ...old,
          [documentId]: result
            .filter((item) => item.documentId === documentId)
            .sort((a, b) => a.createdAt - b.createdAt),
        }));
        return;
      }
    })().catch((error) => {
      if (live) onError(error);
    });
    return () => {
      live = false;
    };
  }, [documentId, connection]);
  const active = useRef(new Set<string>());
  const discard = async (proposal: SourceProposal) => {
    if (active.current.has(proposal.id)) return false;
    active.current.add(proposal.id);
    setPending(new Set(active.current));
    try {
      await command({
        op: "agent",
        method: "discardProposal",
        args: { id: proposal.id, documentId: proposal.documentId },
      });
      for (const listener of discardedListeners)
        listener(proposal.documentId, proposal.id);
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      active.current.delete(proposal.id);
      setPending(new Set(active.current));
    }
  };
  return {
    proposals: documentId ? records[documentId] || [] : [],
    pending,
    receive,
    discard,
  };
}
