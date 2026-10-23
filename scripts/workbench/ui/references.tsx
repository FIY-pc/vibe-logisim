import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../../../apps/workbench/src/conversation/Chat";
import { useChatReferences } from "../../../apps/workbench/src/conversation/ChatReferences";
import { Workbench } from "./workbench";
export async function verifyReferencesUI() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const old = (globalThis as any).__command;
  let api: any, resolve: any;
  const errors: unknown[] = [];
  let quoted = "";
  (globalThis as any).__command = (request: any) =>
    request.method === "stageReferences"
      ? new Promise((r) => {
          resolve = r;
        })
      : [];
  function Fixture({
    draftKey,
    quotation = null,
  }: {
    draftKey: string;
    quotation?: any;
  }) {
    api = useChatReferences({
      draftKey,
      documentId: "doc",
      quotation,
      onQuoted: (id) => {
        quoted = id;
      },
      onError: (e) => errors.push(e),
      ready: true,
    });
    return <>{api.composer}</>;
  }
  const first = {
    id: "first",
    kind: "material",
    label: "figure.png",
    hasImage: true,
  };
  try {
    localStorage.setItem("references-A:references", JSON.stringify([first]));
    await act(async () => root.render(<Fixture draftKey="references-A" />));
    const receipt = api.receipt();
    await act(async () =>
      root.render(
        <Fixture
          draftKey="references-A"
          quotation={{
            id: "incoming",
            documentId: "doc",
            references: [
              {
                kind: "material",
                label: "notes",
                path: "notes.txt",
                text: "notes",
              },
            ],
          }}
        />,
      ),
    );
    assert.equal(api.pending, true);
    await act(async () => root.render(<Fixture draftKey="references-B" />));
    const second = {
      id: "second",
      kind: "material",
      label: "notes",
      hasImage: false,
    };
    await act(async () => {
      resolve([second]);
    });
    assert.deepEqual(
      api.references,
      [],
      "A late attachment must stay in the conversation where it was added",
    );
    assert.equal(quoted, "incoming");
    await act(async () => api.acknowledge(receipt));
    assert.deepEqual(
      JSON.parse(localStorage.getItem("references-A:references")!),
      [second],
      "A send ACK must not erase references added after the send",
    );
    await act(async () => root.render(<Fixture draftKey="references-A" />));
    assert.equal(api.references[0].id, "second");
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="取消引用 notes"]',
    )!;
    await act(async () => remove.click());
    assert.deepEqual(api.references, []);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: reference drafts survive conversation switches and only the acknowledged snapshot is consumed",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as any).__command = old;
    localStorage.removeItem("references-A:references");
    localStorage.removeItem("references-B:references");
  }
  await verifyDocumentReferenceBinding();
}

async function verifyDocumentReferenceBinding() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    globals = globalThis as any;
  const old = { command: globals.__command, subscribe: globals.__subscribe };
  const listeners = new Set<any>(),
    binds: string[] = [],
    staged: string[] = [],
    errors: any[] = [];
  const key = "vibe.draft:folder:reference-binding:conversation";
  let bound = "",
    busy = false,
    sequence = 0,
    releaseBind: (() => void) | null = null;
  const state = () => ({
    eventCursor: sequence,
    runtime: "builtin",
    status: busy ? "busy" : "idle",
    available: true,
    busy,
    messages: [],
    model: "fixture",
    effort: "none",
    services: [{ id: "fixture" }],
    conversationId: "conversation",
  });
  globals.__subscribe = (listener: any) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  globals.__command = async (request: any) => {
    if (request.method === "conversations") return { conversations: [] };
    if (request.method === "bind") {
      binds.push(request.args.documentId);
      if (request.args.documentId === "B")
        await new Promise<void>((resolve) => {
          releaseBind = resolve;
        });
      bound = request.args.documentId;
    }
    if (request.method === "stageReferences") {
      assert.equal(
        request.args.documentId,
        bound,
        "Reference staging waits for the document binding, even inside one conversation workspace",
      );
      staged.push(bound);
      return [
        {
          id: "ref-" + bound,
          label: bound + " notes",
          kind: "material",
          hasImage: false,
        },
      ];
    }
    return state();
  };
  const doc = (id: string) => ({
    id,
    name: id + ".circ",
    revision: "r1",
    path: "/project/" + id + ".circ",
    main: "main",
    circuits: [],
  });
  const quotation = (id: string) => ({
    id: "quote-" + id,
    documentId: id,
    references: [
      {
        kind: "material" as const,
        path: "notes.txt",
        label: id + " notes",
        text: id + " notes",
      },
    ],
  });
  const render = (id: string, quote = false) =>
    act(async () =>
      root.render(
        <Workbench>
          <Chat
            visible
            doc={doc(id) as any}
            folder={
              {
                id: "folder:reference-binding",
                path: "/project",
                name: "project",
              } as any
            }
            circuit="main"
            selection={[]}
            quotation={quote ? quotation(id) : null}
            onQuoted={() => {}}
            onDocument={() => {}}
            onOpened={() => {}}
            onFilesChanged={async () => {}}
            onError={(e) => errors.push(e)}
          />
        </Workbench>,
      ),
    );
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const emit = () =>
    act(async () => {
      const event = {
        topic: "agent",
        data: { sequence: ++sequence, event: { type: "status", ...state() } },
      };
      for (const listener of listeners) listener(event);
    });
  try {
    localStorage.setItem(key, "keep this shared conversation draft");
    await render("A");
    await settle();
    assert.equal(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value,
      "keep this shared conversation draft",
    );
    await render("B", true);
    await settle();
    assert.equal(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value,
      "keep this shared conversation draft",
    );
    assert.deepEqual(staged, []);
    assert(releaseBind);
    await act(async () => releaseBind!());
    await settle();
    assert.deepEqual(binds, ["A", "B"]);
    assert.deepEqual(staged, ["B"]);
    // A running turn keeps its conversation; another document of the same
    // folder binds meanwhile, and its references wait for the next question.
    busy = true;
    await emit();
    await render("C", true);
    await settle();
    assert.deepEqual(binds, ["A", "B", "C"]);
    assert.deepEqual(staged, ["B", "C"]);
    busy = false;
    await emit();
    await settle();
    assert.deepEqual(binds, ["A", "B", "C"]);
    assert.equal(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value,
      "keep this shared conversation draft",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: same-workspace document changes retain conversation drafts, defer references until binding is ready, and bind beside a running turn",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globals.__command = old.command;
    globals.__subscribe = old.subscribe;
    localStorage.removeItem(key);
    localStorage.removeItem(key + ":references");
  }
}
