/**
 * One AI turn through the real sidecar, with a scripted model in place of a
 * model service: its tool call edits the open file, the turn checkpoints the
 * folder, and undoing that checkpoint gives the file back byte for byte.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Script } from "./scripted-model.mts";

export const QUESTION = "放一个非门";

/** The model's side of the turn: one place_component call, then an answer. */
export const placeOneGate: Script = ({ calls }) =>
  calls.length
    ? {
        text: calls[0].error
          ? `放置失败：${calls[0].error.code} ${calls[0].error.message}`
          : "已放置一个非门。",
      }
    : {
        tool: {
          name: "place_component",
          args: {
            components: [{ factory: "NOT Gate", location: { x: 200, y: 200 } }],
          },
        },
      };

export async function verifyAgentTurn(
  command: (request: any) => Promise<any>,
  stream: { events: any[]; wait: (p: (e: any) => boolean, from?: number) => Promise<any> },
  state: string,
) {
  const folder = path.join(state, "agent-project");
  await mkdir(folder);
  const opened = await command({ op: "folderOpen", path: folder });
  const file = path.join(folder, "turn.circ");
  let doc = await command({ op: "new", name: "turn.circ" });
  doc = await command({ op: "save", id: doc.id, revision: doc.revision, path: file });
  const before = await readFile(file);
  await command({ op: "agent", method: "bind", args: { documentId: doc.id } });
  const from = stream.events.length;
  const { turnId } = await command({
    op: "agent",
    method: "ask",
    args: { question: QUESTION, references: [], documentId: doc.id, circuit: "main", selection: [] },
  });
  const done = await stream.wait(
    (e) => e.topic === "agent" && e.data?.event?.type === "turn-completed" && e.data.event.turnId === turnId,
    from,
  );
  const events = stream.events
    .slice(from)
    .filter((e) => e.topic === "agent")
    .map((e) => e.data.event);
  assert.equal(done.data.event.status, "completed", JSON.stringify(events));
  assert(
    events.some((e) => e.type === "document-changed" && e.document?.id === doc.id),
    "The tool call did not report its edit",
  );
  const change = events.find((e) => e.type === "files-changed")?.change;
  assert.deepEqual(change?.files, [{ kind: "modified", path: "turn.circ" }]);
  assert.match(await readFile(file, "utf8"), /name="NOT Gate"/, "The edit did not reach the file");
  const status = await command({ op: "agent", method: "status" });
  assert(
    JSON.stringify(status.messages).includes(QUESTION),
    "The conversation does not list the question",
  );
  await command({ op: "folderHistoryUndo", folder_id: opened.id, id: change.id });
  assert((await readFile(file)).equals(before), "Undoing the turn did not restore the file");
}
