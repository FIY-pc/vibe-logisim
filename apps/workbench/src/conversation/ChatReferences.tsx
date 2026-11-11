import { Button, IconButton, MessageComposer, Text } from "../design/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useExternalStoreRuntime,
  SimpleImageAttachmentAdapter,
  MessageNotSentError,
  type Attachment,
  type AttachmentAdapter,
  type CreateAttachment,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { Message } from "./ConversationContent";
import { Paperclip, X } from "lucide-react";
import { command } from "../shared/transport";
import type { JsonValue } from "../generated/serde_json/JsonValue";
import type {
  Quotation,
  ReferenceSummary,
  StoredReference,
} from "./references";
import { DialogFrame, DialogBody } from "../shared/Dialog";
import { useWorkbench } from "../app/provider";
import type { PreviewFile } from "../workspace/FilePreview";
import { fileReference } from "../workspace/fileReference";
import { usesFolderPreview } from "../workspace/materialPreview";

const EMPTY_MESSAGES: Message[] = [];
const REFERENCE_MIME = "application/x-vibe-reference";
const IMAGE_TYPES = "image/png,image/jpeg,image/webp";
const referenceAttachment = (
  reference: ReferenceSummary,
): CreateAttachment => ({
  id: reference.id,
  name: reference.label,
  type: reference.hasImage ? "image" : "document",
  contentType: REFERENCE_MIME,
  content: [{ type: "data", name: "vibe-reference", data: reference }],
});
const attachmentReference = (
  attachment: Attachment,
): ReferenceSummary | undefined => {
  const part = attachment.content?.find(
    (part) => part.type === "data" && part.name === "vibe-reference",
  );
  return part?.type === "data" ? (part.data as ReferenceSummary) : undefined;
};

interface AttachmentJob {
  key: string;
  quotation: Quotation;
  imageFile?: File;
  error: string | null;
}
function referenceLocation(
  ref: ReferenceSummary,
  references: ReferenceSummary[],
) {
  const parts = ref.page ? [`第 ${ref.page} 页`] : [];
  if (ref.region) {
    const key = (item: ReferenceSummary) =>
      item.region &&
      [
        item.region.x,
        item.region.y,
        item.region.width,
        item.region.height,
      ].join(":");
    const regions = [
      ...new Set(
        references
          .filter(
            (item) =>
              item.region &&
              item.path === ref.path &&
              item.folderId === ref.folderId &&
              item.revision === ref.revision &&
              item.page === ref.page,
          )
          .map(key),
      ),
    ];
    parts.push(`选区 ${regions.indexOf(key(ref)) + 1}`);
  }
  if (ref.truncated) parts.push("摘录");
  return parts.join(" · ");
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
  documentId,
  quotation,
  onQuoted,
  onError,
  ready,
  busy = false,
  sendDisabled = false,
  messages = EMPTY_MESSAGES,
  onSend,
}: {
  draftKey: string;
  documentId?: string;
  quotation: Quotation | null;
  onQuoted: (id: string) => void;
  onError: (error: unknown) => void;
  ready: boolean;
  busy?: boolean;
  sendDisabled?: boolean;
  messages?: Message[];
  onSend?: (text: string, ids: string[]) => Promise<void>;
}) {
  const workbench = useWorkbench();
  const [record, setRecord] = useState({
    key: draftKey,
    references: load(draftKey),
  });
  const [text, setText] = useState("");
  const [jobs, setJobs] = useState<AttachmentJob[]>([]);
  const [preview, setPreview] = useState<StoredReference | null>(null);
  const taken = useRef<string | null>(null);
  const liveKey = useRef(draftKey);
  liveKey.current = draftKey;
  const references = record.key === draftKey ? record.references : [];
  const currentJobs = jobs.filter((job) => job.key === draftKey);
  const pending = currentJobs.some((job) => job.error === null);
  const callbacks = useRef({ onSend, onError, documentId, draftKey });
  callbacks.current = { onSend, onError, documentId, draftKey };
  const stageRef = useRef<(job: AttachmentJob) => Promise<ReferenceSummary[]>>(
    null!,
  );
  const adapter = useMemo<AttachmentAdapter>(
    () => ({
      accept: IMAGE_TYPES + "," + REFERENCE_MIME,
      async add({ file }) {
        const source = { ...callbacks.current };
        const job: AttachmentJob = {
          key: source.draftKey,
          quotation: {
            id: crypto.randomUUID(),
            documentId: source.documentId,
            references: [],
          },
          imageFile: file,
          error: null,
        };
        setJobs((current) => [...current, job]);
        const [reference] = await stageRef.current(job);
        return {
          ...referenceAttachment(reference),
          id: reference.id,
          type: "image",
          file,
          status: { type: "requires-action", reason: "composer-send" },
        };
      },
      async send(attachment) {
        return {
          ...attachment,
          content: attachment.content || [],
          status: { type: "complete" },
        };
      },
      async remove() {},
    }),
    [],
  );
  const uiMessages = useMemo<ThreadMessageLike[]>(
    () =>
      messages
        .filter(
          (message) => message.type === "user" || message.type === "assistant",
        )
        .map((message) => ({
          id: message.id,
          role: message.type === "user" ? "user" : "assistant",
          content: message.text || "",
          ...(message.type === "user"
            ? {
                attachments: message.context?.references?.map((reference) => ({
                  ...referenceAttachment(reference),
                  id: reference.id,
                  type: reference.hasImage ? "image" : "document",
                  status: { type: "complete" as const },
                })),
              }
            : {}),
        })),
    [messages],
  );
  const assistant = useExternalStoreRuntime({
    messages: uiMessages,
    convertMessage: (message) => message,
    isRunning: busy,
    isDisabled: !ready,
    isSendDisabled: sendDisabled || currentJobs.length > 0,
    adapters: {
      attachments: adapter,
      threadList: { threadId: draftKey || "unbound" },
    },
    async onNew(message) {
      const key = draftKey;
      const question = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const refs = (message.attachments || [])
        .map(attachmentReference)
        .filter((r): r is ReferenceSummary => !!r);
      try {
        await onSend?.(
          question,
          refs.map((r) => r.id),
        );
      } catch (error) {
        // The library restores the live draft. A conversation switched during
        // the host call still needs its persistent draft restored at its own key.
        if (liveKey.current !== key) {
          const newer = localStorage.getItem(key) || "";
          localStorage.setItem(
            key,
            [question, newer].filter(Boolean).join("\n"),
          );
          localStorage.setItem(
            keyFor(key),
            JSON.stringify([...refs, ...load(key)]),
          );
        }
        onError(error);
        throw new MessageNotSentError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
  const syncing = useRef(false);
  const persist = (key: string, refs: ReferenceSummary[]) => {
    if (!key) return;
    localStorage.setItem(keyFor(key), JSON.stringify(refs));
    if (liveKey.current !== key) return;
    const composer = assistant.thread.composer;
    syncing.current = true;
    const attachments = composer.getState().attachments;
    // Keep the library as the live attachment owner; localStorage only stores
    // reference IDs/metadata, never the image bytes or another live state machine.
    for (let index = attachments.length - 1; index >= 0; index--)
      if (!refs.some((ref) => ref.id === attachments[index].id))
        void composer.getAttachmentByIndex(index).remove();
    const existing = new Set(
      composer.getState().attachments.map((item) => item.id),
    );
    for (const ref of refs)
      if (!existing.has(ref.id))
        void composer.addAttachment(referenceAttachment(ref)).catch(onError);
    syncing.current = false;
    setRecord({ key, references: refs });
  };
  useEffect(() => {
    if (!draftKey || !ready) return;
    const composer = assistant.thread.composer;
    composer.setText(localStorage.getItem(draftKey) || "");
    persist(draftKey, load(draftKey));
    setPreview(null);
    const update = () => {
      if (syncing.current || liveKey.current !== draftKey) return;
      const state = composer.getState();
      const refs = state.attachments
        .map(attachmentReference)
        .filter((r): r is ReferenceSummary => !!r);
      setText(state.text);
      setRecord({ key: draftKey, references: refs });
      localStorage.setItem(draftKey, state.text);
      localStorage.setItem(keyFor(draftKey), JSON.stringify(refs));
    };
    update();
    const unsubscribe = composer.subscribe(update);
    const offError = composer.unstable_on("attachmentAddError", (event) => {
      if (event.reason !== "adapter-error")
        onError(new Error("只支持 PNG、JPEG 和 WebP 图片"));
    });
    return () => {
      unsubscribe();
      offError();
    };
  }, [draftKey, ready, assistant]);
  const stage = async (job: AttachmentJob) => {
    setJobs((current) =>
      current.map((item) => (item === job ? { ...item, error: null } : item)),
    );
    const matches = (item: AttachmentJob) =>
      item.key === job.key && item.quotation.id === job.quotation.id;
    try {
      const quote = job.quotation;
      const inputs = quote.files ? [] : [...quote.references];
      if (job.imageFile) {
        const file = job.imageFile;
        if (file.size > 8 * 1024 * 1024)
          throw new Error("图片超过 8 MB，请缩小后重试");
        const imageAdapter = new SimpleImageAttachmentAdapter();
        const image = await imageAdapter.send(await imageAdapter.add({ file }));
        const part = image.content[0];
        if (part?.type !== "image") throw new Error("图片读取失败");
        inputs.push({
          kind: "material",
          label: file.name || "截图.png",
          path: "",
          image: part.image,
        });
      }
      if (quote.files) {
        for (const path of quote.files.paths)
          inputs.push(await fileReference(quote.files.folderId, path));
      }
      const added = await runtime<ReferenceSummary[]>("stageReferences", {
        documentId: quote.documentId,
        references: inputs,
      });
      persist(job.key, [...load(job.key), ...added]);
      setJobs((current) => current.filter((item) => !matches(item)));
      return added;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setJobs((current) =>
        current.map((item) =>
          matches(item) ? { ...item, error: message } : item,
        ),
      );
      throw error;
    }
  };
  stageRef.current = stage;
  useEffect(() => {
    if (
      !quotation ||
      !ready ||
      !draftKey ||
      quotation.documentId !== documentId ||
      taken.current === quotation.id
    )
      return;
    // Take ownership once, while the source draft is known. A later reply or
    // failure belongs to this draft, even if the visible conversation changes.
    taken.current = quotation.id;
    const job = { key: draftKey, quotation, error: null };
    setJobs((current) => [...current, job]);
    onQuoted(quotation.id);
    void stage(job).catch(() => {});
  }, [quotation?.id, ready, draftKey, documentId]);
  const open = async (id: string) => {
    const capturedKey = draftKey;
    try {
      const [ref] = await runtime<StoredReference[]>("readReferences", {
        ids: [id],
      });
      if (liveKey.current !== capturedKey) return;
      const folder = workbench.stores.files.getState().folder;
      if (
        ref?.kind === "material" &&
        ref.path &&
        folder &&
        (!ref.folderId || ref.folderId === folder.id)
      ) {
        try {
          const file = await command<PreviewFile>({
            op: usesFolderPreview(ref.path) ? "folderPreview" : "folderRead",
            folder_id: folder.id,
            path: ref.path,
          });
          if (
            liveKey.current !== capturedKey ||
            workbench.stores.files.getState().folder?.id !== folder.id
          )
            return;
          // A changed source is opened as current data, without pretending its old region still matches.
          const unchanged =
            ref.revision === undefined || ref.revision === file.revision;
          workbench.stores.files.getState().setPreview({
            ...file,
            name: ref.label,
            path: ref.path,
            folderId: folder.id,
            ...(unchanged ? { page: ref.page, region: ref.region } : {}),
          });
          if (!unchanged)
            workbench.stores.notices
              .getState()
              .setNotice("资料已更新，已打开当前文件；引用仍保留当时内容。");
          return;
        } catch {
          /* A removed source remains readable as the saved quotation. */
        }
      }
      setPreview(ref);
    } catch (error) {
      if (liveKey.current === capturedKey) onError(error);
    }
  };
  const chips = (refs: ReferenceSummary[], removable = false) => (
    <div className={"reference-chips" + (removable ? " is-draft" : "")}>
      {refs.map((ref) => {
        const location = referenceLocation(ref, refs);
        const label = [ref.label, location].filter(Boolean).join(" · ");
        const region = ref.region;
        const details = [
          ref.path || ref.label,
          location,
          region &&
            `选区位置：左 ${Math.round(region.x * 100)}%，上 ${Math.round(region.y * 100)}%，宽 ${Math.round(region.width * 100)}%，高 ${Math.round(region.height * 100)}%`,
        ]
          .filter(Boolean)
          .join("\n");
        return (
          <span key={ref.id}>
            <Button
              variant="soft"
              color="gray"
              data-tip={details}
              aria-label={label}
              onClick={() => void open(ref.id)}
            >
              {ref.hasImage ? (
                <ReferenceThumbnail id={ref.id} label={ref.label} />
              ) : (
                <Paperclip size={16} />
              )}
              <span className="reference-label">
                <span className="reference-name">{ref.label}</span>
                {location && (
                  <Text kind="meta" className="reference-location">
                    {location}
                  </Text>
                )}
              </span>
            </Button>
            {removable && (
              <IconButton
                variant="ghost"
                color="gray"
                aria-label={`取消引用 ${label}`}
                onClick={() =>
                  persist(
                    draftKey,
                    references.filter((r) => r.id !== ref.id),
                  )
                }
              >
                <X size={16} />
              </IconButton>
            )}
          </span>
        );
      })}
    </div>
  );
  return {
    assistant,
    text,
    setText: (value: string) => assistant.thread.composer.setText(value),
    send: () => assistant.thread.composer.send(),
    addImage: (file: File) => assistant.thread.composer.addAttachment(file),
    addFiles: (folderId: string, paths: string[]) => {
      const job: AttachmentJob = {
        key: draftKey,
        quotation: {
          id: crypto.randomUUID(),
          documentId,
          files: { folderId, paths },
        },
        error: null,
      };
      setJobs((current) => [...current, job]);
      void stage(job).catch(() => {});
    },
    references,
    pending,
    unresolved: currentJobs.length > 0,
    composer: (
      <>
        {(references.length > 0 || pending) && (
          <MessageComposer.Attachments
            role="region"
            aria-label="待发送引用"
            tabIndex={0}
          >
            {chips(references, true)}
            {pending && (
              <Text kind="meta" role="status">
                正在添加引用…
              </Text>
            )}
          </MessageComposer.Attachments>
        )}
        {currentJobs.some((job) => job.error !== null) && (
          <div
            className="reference-failures"
            role="region"
            aria-label="引用问题"
          >
            {currentJobs
              .filter((job) => job.error !== null)
              .map((job) => (
                <div key={job.quotation.id} className="reference-failure">
                  <Text as="p" color="red" role="alert">
                    未能添加引用：{job.error}
                  </Text>
                  <div>
                    <Button
                      variant="ghost"
                      color="gray"
                      disabled={
                        !ready || job.quotation.documentId !== documentId
                      }
                      data-tip={
                        job.quotation.documentId !== documentId
                          ? "切回引用所属文档后重试"
                          : undefined
                      }
                      onClick={() => void stage(job).catch(() => {})}
                    >
                      重试添加引用
                    </Button>
                    <Button
                      variant="ghost"
                      color="gray"
                      onClick={() =>
                        setJobs((current) =>
                          current.filter((item) => item !== job),
                        )
                      }
                    >
                      取消添加
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        )}
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
  return (
    <DialogFrame
      title={`${reference.label}${reference.page ? ` · 第 ${reference.page} 页` : ""}`}
      className="reference-preview"
      maxWidth="850px"
      maxHeight="88dvh"
      aria-label={`引用 ${reference.label}`}
      closeLabel="关闭引用"
      onClose={onClose}
    >
      <DialogBody>
        {reference.image && <img src={reference.image} alt={reference.label} />}
        {reference.text && <pre>{reference.text}</pre>}
        {reference.truncated && (
          <Text as="p" kind="meta">
            此引用保留前 24,000 个字符。
          </Text>
        )}
      </DialogBody>
    </DialogFrame>
  );
}

function ReferenceThumbnail({ id, label }: { id: string; label: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let active = true;
    void (async () => {
      const [reference] = await runtime<StoredReference[]>("readReferences", {
        ids: [id],
      });
      if (active) setSrc(reference?.image);
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);
  return src ? (
    <img className="reference-thumbnail" src={src} alt={label} />
  ) : (
    <Paperclip size={16} />
  );
}
