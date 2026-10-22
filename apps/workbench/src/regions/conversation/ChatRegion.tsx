import { Chat } from "../../components/Chat";
import { useConversationReferences } from "../../lib/conversationReferences";
import { showRight } from "../../stores/shell";
import {
  useConversation,
  useDocuments,
  useFiles,
  useNotices,
  useSelection,
  useShell,
  useSimulation,
  useView,
} from "../../workbench/hooks";
import { useWorkbench } from "../../workbench/provider";

/** The conversation tab. */
export function ChatRegion() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc, circuit } = view;
  const selection = useSelection();
  const sim = useSimulation((state) => state.sim);
  const folder = useFiles((state) => state.folder);
  const quotation = useConversation((state) => state.quotation);
  const referenceDrop = useConversation((state) => state.referenceDrop);
  const visible = useShell(
    (state) => state.right === "chat" && showRight(state),
  );
  const mergeDocument = useDocuments((state) => state.mergeDocument);
  const { setNotice, onError } = stores.notices.getState();
  const { navigation } = actions;
  const followConversationReference = useConversationReferences({
    doc,
    folder,
    onCircuit: (name, id) => navigation.focusObject(view, sim, name, id),
    onDocument: actions.workspace.showDocument,
    onPreview: stores.files.getState().setPreview,
    onNotice: setNotice,
    onError,
  });
  return (
    <Chat
      onLocate={(change) => navigation.locateChange(view, sim, change)}
      visible={visible}
      doc={doc}
      circuit={circuit?.name || null}
      onError={onError}
      onDocument={mergeDocument}
      folder={folder}
      selection={selection}
      quotation={quotation}
      referenceDrop={referenceDrop}
      onFollowReference={(href, message) =>
        followConversationReference(href, message.context)
      }
      onQuoted={(id) =>
        stores.conversation
          .getState()
          .setQuotation((current) => (current?.id === id ? null : current))
      }
    />
  );
}
