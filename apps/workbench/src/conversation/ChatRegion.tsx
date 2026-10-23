import { Chat } from "./Chat";
import { useConversationReferences } from "./conversationReferences";
import { showRight } from "../shell/store";
import {
  useConversation,
  useDocuments,
  useFiles,
  useSelection,
  useShell,
  useView,
} from "../app/hooks";
import { useWorkbench } from "../app/provider";

/** The conversation tab. */
export function ChatRegion() {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc, circuit } = view;
  const selection = useSelection();
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
    onCircuit: (name, id) => navigation.focusObject(view, name, id),
    onDocument: actions.workspace.showDocument,
    onPreview: stores.files.getState().setPreview,
    onNotice: setNotice,
    onError,
  });
  return (
    <Chat
      visible={visible}
      doc={doc}
      circuit={circuit?.name || null}
      onError={onError}
      onDocument={mergeDocument}
      onOpened={actions.workspace.showDocument}
      onFilesChanged={async () => {
        await stores.documents.getState().refreshWorkspace(true);
        stores.files.getState().refreshTree();
      }}
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
