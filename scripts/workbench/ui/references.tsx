import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import { Chat } from "../../../apps/workbench/src/conversation/Chat";
import { useChatReferences } from "../../../apps/workbench/src/conversation/ChatReferences";
import { Workbench } from "./workbench";
export async function verifyReferencesUI() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const old = (globalThis as any).__command;
  let api: any, resolve: any, reject: any;
  const staged: any[][] = [];
  let readFailure = false;
  const errors: unknown[] = [];
  let quoted = "";
  (globalThis as any).__command = (request: any) => {
    if (request.op === "folderRead") {
      if (readFailure) throw new Error("source unavailable");
      return { text: request.path, revision: "r1", pathVersion: 1 };
    }
    if (request.method === "stageReferences") {
      staged.push(request.args.references);
      return new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
    }
    return [];
  };
  function ReferenceFixture({
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
  function Fixture(props: Parameters<typeof ReferenceFixture>[0]) {
    return (
      <Workbench>
        <ReferenceFixture {...props} />
      </Workbench>
    );
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
    const selections = [
      {
        ...first,
        id: "upper",
        label: "notes.pdf",
        path: "notes.pdf",
        page: 20,
        region: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
      },
      {
        ...first,
        id: "lower",
        label: "notes.pdf",
        path: "notes.pdf",
        page: 20,
        region: { x: 0.1, y: 0.6, width: 0.3, height: 0.2 },
      },
      {
        ...first,
        id: "upper-again",
        label: "notes.pdf",
        path: "notes.pdf",
        page: 20,
        region: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
      },
    ];
    localStorage.setItem(
      "references-regions:references",
      JSON.stringify(selections),
    );
    await act(async () =>
      root.render(<Fixture draftKey="references-regions" />),
    );
    assert.deepEqual(
      api.references,
      selections,
      "Identical labels must not discard distinct reference records",
    );
    const labels = Array.from(
      container.querySelectorAll(".reference-chips .ui-button"),
      (node) => node.getAttribute("aria-label"),
    );
    assert.deepEqual(labels, [
      "notes.pdf · 第 20 页 · 选区 1",
      "notes.pdf · 第 20 页 · 选区 2",
      "notes.pdf · 第 20 页 · 选区 1",
    ]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="取消引用 notes.pdf · 第 20 页 · 选区 2"]',
        )!
        .click(),
    );
    assert.deepEqual(
      api.references.map((ref: any) => ref.id),
      ["upper", "upper-again"],
      "Remove only the selected reference ID",
    );
    // The file intake path prepares more than eight references and keeps a
    // failed request with its source draft, even while another is staging.
    const quotation = {
      id: "many-files",
      documentId: "doc",
      files: {
        folderId: "folder",
        paths: Array.from({ length: 12 }, (_, i) => `notes-${i}.txt`),
      },
    };
    await act(async () =>
      root.render(
        <Fixture draftKey="references-regions" quotation={quotation} />,
      ),
    );
    assert.equal(staged.at(-1)!.length, 12);
    const failSource = reject;
    await act(async () =>
      root.render(
        <Fixture
          draftKey="references-B"
          quotation={{ ...quotation, id: "other-draft" }}
        />,
      ),
    );
    await act(async () => failSource(new Error("staging unavailable")));
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(api.pending, true, "A failure cannot end B's pending work");
    await act(async () => resolve([second]));
    assert.equal(api.unresolved, false);
    assert.deepEqual(api.references, [second]);
    await act(async () =>
      root.render(<Fixture draftKey="references-regions" />),
    );
    assert.equal(api.pending, false);
    assert.equal(api.unresolved, true);
    assert.match(
      container.querySelector('[role="alert"]')!.textContent!,
      /staging unavailable/,
    );
    assert.deepEqual(
      api.references.map((ref: any) => ref.id),
      ["upper", "upper-again"],
    );
    const click = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (item) => item.textContent === label,
      );
      assert(button);
      await act(async () => button.click());
    };
    await click("重试添加引用");
    assert.equal(api.pending, true);
    assert.equal(
      staged.at(-1)!.length,
      12,
      "Retry uses the captured quotation after the producer clears it",
    );
    const added = quotation.files.paths.map((label, i) => ({
      ...second,
      id: `added-${i}`,
      label,
    }));
    await act(async () => resolve(added));
    assert.equal(api.references.length, 14);
    assert.equal(api.unresolved, false);
    assert.equal(container.querySelector('[role="alert"]'), null);
    readFailure = true;
    await act(async () =>
      root.render(
        <Fixture
          draftKey="references-regions"
          quotation={{ ...quotation, id: "read-failure" }}
        />,
      ),
    );
    assert.match(
      container.querySelector('[role="alert"]')!.textContent!,
      /source unavailable/,
    );
    assert.equal(
      api.references.length,
      14,
      "Preparation failure retains earlier attachments",
    );
    await click("取消添加");
    assert.equal(
      api.unresolved,
      false,
      "Cancel restores sending with the existing references",
    );
    assert.equal(api.references.length, 14);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: 12-file reference intake, draft-scoped late failures, retry/cancel, and snapshot ACK preservation",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as any).__command = old;
    localStorage.removeItem("references-A:references");
    localStorage.removeItem("references-B:references");
    localStorage.removeItem("references-regions:references");
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
    failStage = false,
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
      if (failStage) throw new Error("reference service unavailable");
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
    failStage = true;
    await render("D", true);
    await settle();
    assert.match(
      container.querySelector('.composer [role="alert"]')!.textContent!,
      /reference service unavailable/,
    );
    const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
    assert.equal(
      input.disabled,
      false,
      "A local attachment error keeps the editor usable",
    );
    assert.equal(input.value, "keep this shared conversation draft");
    const send =
      container.querySelector<HTMLButtonElement>('[aria-label="发送"]')!;
    assert.equal(
      send.disabled,
      true,
      "Resolve or cancel the failed attachment before sending",
    );
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "取消添加",
    )!;
    await act(async () => cancel.click());
    assert.equal(send.disabled, false);
    assert.equal(container.querySelector('.composer [role="alert"]'), null);
    assert.equal(
      container.querySelectorAll(".composer .reference-chips > span").length,
      2,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: document binding and running turns preserve drafts; failed attachments keep the full composer editable and cancel restores sending",
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
