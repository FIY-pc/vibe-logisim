import { useEffect, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { command } from "../lib/transport";
import type { JsonValue } from "../generated/serde_json/JsonValue";
import type {
  Quotation,
  ReferenceSummary,
  StoredReference,
} from "../lib/references";
import "./ChatReferences.css";

interface Receipt {
  key: string;
  ids: string[];
}
const runtime = <T,>(method: string, args: unknown) =>
  command<T>({ op: "agent", method, args: args as JsonValue });
const keyFor = (key: string) => key + ":references";
function load(key: string): ReferenceSummary[] {
  if (!key) return [];
  try {
    return JSON.parse(localStorage.getItem(keyFor(key)) || "[]");
  } catch {
    return [];
  }
}
export function useChatReferences({
  draftKey,
  workspaceKey,
  documentId,
  quotation,
  onQuoted,
  onError,
  ready,
}: {
  draftKey: string;
  workspaceKey: string;
  documentId?: string;
  quotation: Quotation | null;
  onQuoted: (id: string) => void;
  onError: (error: unknown) => void;
  ready: boolean;
}) {
  const [record, setRecord] = useState({
    key: draftKey,
    references: load(draftKey),
  });
  const [pending, setPending] = useState(false),
    [failure, setFailure] = useState(false);
  const [preview, setPreview] = useState<StoredReference | null>(null);
  const staging = useRef<string | null>(null);
  const liveKey = useRef(draftKey);
  liveKey.current = draftKey;
  const references = record.key === draftKey ? record.references : [];
  const persist = (key: string, refs: ReferenceSummary[]) => {
    localStorage.setItem(keyFor(key), JSON.stringify(refs));
    if (liveKey.current === key) setRecord({ key, references: refs });
  };
  useEffect(() => {
    setRecord({ key: draftKey, references: load(draftKey) });
    setPreview(null);
    setFailure(false);
  }, [draftKey]);
  const stage = async () => {
    if (
      !quotation ||
      !ready ||
      !draftKey ||
      quotation.documentId !== documentId ||
      staging.current === quotation.id
    )
      return;
    const captured = { key: draftKey, quotation };
    staging.current = quotation.id;
    setPending(true);
    setFailure(false);
    try {
      if (load(captured.key).length + quotation.references.length > 8)
        throw new Error("每条问题最多引用 8 处资料或观察");
      const added = await runtime<ReferenceSummary[]>("stageReferences", {
        workspaceKey,
        documentId,
        references: quotation.references,
      });
      const current = load(captured.key);
      if (current.length + added.length > 8)
        throw new Error("每条问题最多引用 8 处资料或观察");
      persist(captured.key, [...current, ...added]);
      onQuoted(captured.quotation.id);
    } catch (error) {
      setFailure(true);
      onError(error);
    } finally {
      setPending(false);
      staging.current = null;
    }
  };
  useEffect(() => {
    void stage();
  }, [quotation?.id, ready, draftKey, documentId]);
  const open = async (id: string) => {
    const capturedKey = draftKey;
    try {
      const [ref] = await runtime<StoredReference[]>("readReferences", {
        workspaceKey,
        ids: [id],
      });
      if (liveKey.current === capturedKey) setPreview(ref);
    } catch (error) {
      onError(error);
    }
  };
  const chips = (refs: ReferenceSummary[], removable = false) => (
    <div className="reference-chips">
      {refs.map((ref) => (
        <span key={ref.id}>
          <button
            title={ref.path || ref.label}
            onClick={() => void open(ref.id)}
          >
            <Paperclip size={13} />
            {ref.label}
            {ref.page ? ` · 第 ${ref.page} 页` : ""}
            {ref.truncated ? " · 摘录" : ""}
          </button>
          {removable && (
            <button
              aria-label={`取消引用 ${ref.label}`}
              onClick={() =>
                persist(
                  draftKey,
                  references.filter((r) => r.id !== ref.id),
                )
              }
            >
              <X size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
  return {
    references,
    pending,
    receipt: (): Receipt => ({
      key: draftKey,
      ids: references.map((r) => r.id),
    }),
    acknowledge: (receipt: Receipt) =>
      persist(
        receipt.key,
        load(receipt.key).filter((ref) => !receipt.ids.includes(ref.id)),
      ),
    composer: (
      <>
        {chips(references, true)}
        {pending && <span role="status">正在添加引用…</span>}
        {failure && <button onClick={() => void stage()}>重试添加引用</button>}
        {preview && (
          <ReferencePreview
            reference={preview}
            onClose={() => setPreview(null)}
          />
        )}
      </>
    ),
    renderContext: (context?: { references?: ReferenceSummary[] }) =>
      context?.references?.length ? chips(context.references) : null,
  };
}
function ReferencePreview({
  reference,
  onClose,
}: {
  reference: StoredReference;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      className="reference-preview"
      ref={dialog}
      aria-label={`引用 ${reference.label}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <strong>
          {reference.label}
          {reference.page ? ` · 第 ${reference.page} 页` : ""}
        </strong>
        <button aria-label="关闭引用" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {reference.image && <img src={reference.image} alt={reference.label} />}
      {reference.text && <pre>{reference.text}</pre>}
      {reference.truncated && <p>此引用保留前 24,000 个字符。</p>}
    </dialog>
  );
}
