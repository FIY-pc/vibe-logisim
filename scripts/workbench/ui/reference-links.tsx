import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../../../apps/workbench/src/components/Chat";
import { useProposals } from "../../../apps/workbench/src/lib/useProposals";
import {
  locateCircuitReference,
  parseConversationReference,
  useConversationReferences,
} from "../../../apps/workbench/src/lib/conversationReferences";
export async function verifyReferenceLinksAndCandidates() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node),
    globals = globalThis as any;
  const previous = {
    command: globals.__command,
    subscribe: globals.__subscribe,
  };
  const calls: any[] = [],
    errors: unknown[] = [],
    previews: any[] = [],
    visits: any[] = [];
  const folder = { id: "link-folder", path: "/fixture", name: "fixture" };
  const doc: any = {
    id: "link-doc",
    name: "link.circ",
    path: "/fixture/link.circ",
    revision: "r1",
    main: "main",
    circuits: [
      {
        name: "main",
        components: [
          {
            id: "c0",
            name: "Pin",
            library: "0",
            attributes: {},
            location: { x: 100, y: 100 },
          },
        ],
        wires: [],
        attributes: {},
      },
    ],
    canUndo: false,
    canRedo: false,
  };
  const context = {
    projectId: doc.id,
    revisionId: doc.revision,
    circuit: "main",
    folderId: folder.id,
    workspaceKey: folder.id,
    pathVersion: 0,
  };
  let gate: ((value: any) => void) | null = null,
    delayed = false;
  const proposal = (id: string, documentId = doc.id) => ({
    id,
    documentId,
    createdAt: id.charCodeAt(0),
    revision: "r1",
    original: "<project/>",
    xml: "<project><circuit name='main'/></project>",
  });
  let persisted: any[] = [proposal("a")],
    listDelay = false,
    listResolve: ((value: any) => void) | null = null,
    rejectDiscard = false;
  globals.__subscribe = () => () => {};
  globals.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "observe")
      return {
        focus: {
          components: [
            {
              componentId: "c100_100",
              factoryName: "Pin",
              location: { x: 100, y: 100 },
              bounds: { x: 90, y: 90, width: 20, height: 20 },
              ends: [],
            },
          ],
          wires: [],
        },
      };
    if (request.op === "folderResolve")
      return delayed
        ? new Promise((resolve) => {
            gate = resolve;
          })
        : { folderId: folder.id, path: "renamed/notes.txt", pathVersion: 1 };
    if (request.op === "folderRead")
      return {
        folderId: folder.id,
        text: "saved notes",
        revision: "file-v1",
        pathVersion: 1,
      };
    if (request.op === "agent") {
      if (request.method === "proposals")
        return listDelay
          ? new Promise((resolve) => {
              listResolve = resolve;
            })
          : persisted.filter(
              (item) => item.documentId === request.args.documentId,
            );
      if (request.method === "discardProposal") {
        if (rejectDiscard) throw new Error("discard failed");
        persisted = persisted.filter((item) => item.id !== request.args.id);
        return {};
      }
      if (request.method === "conversations")
        return {
          conversations: [{ id: "chat", title: "chat", archived: false }],
        };
      return {
        eventCursor: 0,
        conversationId: "chat",
        runtime: "builtin",
        status: "idle",
        available: true,
        busy: false,
        services: [{ id: "fixture" }],
        messages: [
          { id: "user", type: "user", text: "inspect", context },
          { id: "answer", type: "assistant", text: "[打开资料](notes.txt)" },
        ],
      };
    }
    throw new Error("Unexpected request " + request.op);
  };
  const render = (element: React.ReactNode) =>
    act(async () => {
      root.render(element);
    });
  try {
    for (const href of [
      "../private",
      "%2e%2e/private",
      "%252e%252e/private",
      "/etc/passwd",
      "file:///etc/passwd",
      "workspace://file?folderId=x&path=../bad",
    ])
      assert.throws(() => parseConversationReference(href));
    const direct: any = {
      kind: "circuit",
      projectId: doc.id,
      revisionId: "r1",
      circuit: "main",
      componentId: "c0",
    };
    assert.equal(
      (await locateCircuitReference(direct, undefined, doc)).id,
      "c0",
    );
    assert.equal(calls.filter((call) => call.op === "observe").length, 0);
    assert.equal(
      (
        await locateCircuitReference(
          { ...direct, componentId: "c100_100" },
          undefined,
          doc,
        )
      ).id,
      "c0",
    );
    await assert.rejects(
      locateCircuitReference({ ...direct, revisionId: "old" }, undefined, doc),
      /此前版本/,
    );
    await assert.rejects(
      locateCircuitReference({ ...direct, projectId: "other" }, undefined, doc),
      /另一份文档/,
    );
    await assert.rejects(
      locateCircuitReference(
        { ...direct, componentId: "c100_100" },
        undefined,
        {
          ...doc,
          circuits: [
            {
              ...doc.circuits[0],
              components: [
                ...doc.circuits[0].components,
                { ...doc.circuits[0].components[0], id: "c1" },
              ],
            },
          ],
        },
      ),
      /唯一确定/,
    );
    await render(
      <Chat
        visible
        doc={doc}
        circuit="main"
        folder={folder}
        selection={[]}
        quotation={null}
        onQuoted={() => {}}
        onDocument={() => {}}
        onError={(error) => errors.push(error)}
        onFollowReference={(href, message) =>
          visits.push({ href, context: message.context })
        }
      />,
    );
    await act(async () =>
      node.querySelector<HTMLButtonElement>(".message-reference")!.click(),
    );
    assert.deepEqual(
      visits[0],
      { href: "notes.txt", context },
      "Assistant links inherit their own turn context",
    );

    let follow: ReturnType<typeof useConversationReferences>;
    function ReferenceHarness({
      currentFolder = folder,
    }: {
      currentFolder?: typeof folder;
    }) {
      follow = useConversationReferences({
        doc,
        folder: currentFolder,
        onCircuit: (name, id) => visits.push({ name, id }),
        onDocument: () => {},
        onPreview: (file) => previews.push(file),
        onNotice: () => {},
        onError: (error) => errors.push(error),
      });
      return null;
    }
    await render(<ReferenceHarness />);
    await act(async () => follow!("notes.txt", context));
    assert.equal(previews[0].path, "renamed/notes.txt");
    assert.equal(previews[0].pathVersion, 1);
    assert.equal(
      calls.filter((call) => call.op === "folderResolve").at(-1).path_version,
      0,
    );
    assert.equal(
      calls.filter((call) => call.op === "folderRead").at(-1).folder_id,
      folder.id,
    );
    const count = previews.length;
    delayed = true;
    await act(async () => follow!("notes.txt", context));
    await render(
      <ReferenceHarness currentFolder={{ ...folder, id: "other-folder" }} />,
    );
    await act(async () =>
      gate!({ folderId: folder.id, path: "late.txt", pathVersion: 1 }),
    );
    assert.equal(
      previews.length,
      count,
      "A late file result cannot open in a different workspace",
    );
    await act(async () => follow!("notes.txt", context));
    assert.match(String(errors.pop()), /另一工作区/);

    let candidates: ReturnType<typeof useProposals>;
    function CandidateHarness({
      id = doc.id,
      connection = 0,
    }: {
      id?: string;
      connection?: number;
    }) {
      candidates = useProposals(id, connection, (error) => errors.push(error));
      return (
        <div>
          {candidates.proposals.map((item) => (
            <span key={item.id}>{item.id}</span>
          ))}
        </div>
      );
    }
    listDelay = true;
    await render(<CandidateHarness />);
    const firstList = listResolve!;
    await act(async () => {
      persisted.push(proposal("b"));
      candidates!.receive(proposal("b"));
    });
    listDelay = false;
    await act(async () => firstList([proposal("a")]));
    assert.deepEqual(
      candidates!.proposals.map((item) => item.id),
      ["a", "b"],
      "A delayed snapshot cannot erase the candidate received after it began",
    );
    rejectDiscard = true;
    await act(async () => candidates!.discard(proposal("a")));
    assert.equal(candidates!.proposals.length, 2);
    assert.match(String(errors.pop()), /discard failed/);
    rejectDiscard = false;
    await act(async () => candidates!.discard(proposal("a")));
    assert.deepEqual(
      candidates!.proposals.map((item) => item.id),
      ["b"],
    );
    listDelay = true;
    await render(<CandidateHarness connection={1} />);
    const staleList = listResolve!;
    await render(<CandidateHarness id="another-document" />);
    const currentList = listResolve!;
    await act(async () => staleList([proposal("a")]));
    await act(async () => currentList([]));
    assert.equal(
      candidates!.proposals.length,
      0,
      "Document changes cannot show an older document's candidate list",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: message links keep turn scope, resolve native geometry and moved file identity, reject ambiguous/stale/cross-workspace targets; durable candidates survive delayed lists and discard failures",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    globals.__command = previous.command;
    globals.__subscribe = previous.subscribe;
  }
}
