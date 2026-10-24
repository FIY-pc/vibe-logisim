/**
 * AI turns through the real sidecar, with a scripted model in place of a
 * model service. First turn: its tool call edits the open file as one undo
 * step, the turn checkpoints the folder, and undoing that checkpoint gives
 * the file back byte for byte. Second turn: it rewrites the open file with
 * write_file and then opens a definition only the file has; the tools read
 * the file again and the UI is told. It then rewrites the file once more
 * without opening it: the turn's checkpoint reads the document again and
 * the window gets a `documents` event. Undoing the turn restores both the
 * file and the open document.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Script } from "./scripted-model.mts";

export const QUESTION = "放一个非门和一个输入";

/** The model's side of the turn: one place_component call, then an answer. */
export const placeTwoParts: Script = ({ calls }) =>
  calls.length
    ? {
        text: calls[0].error
          ? `放置失败：${calls[0].error.code} ${calls[0].error.message}`
          : "已放置。",
      }
    : {
        tool: {
          name: "place_component",
          args: {
            components: [
              { factory: "NOT Gate", location: { x: 200, y: 200 } },
              { factory: "Pin", location: { x: 100, y: 200 } },
            ],
          },
        },
      };

export const QUESTION_REWRITE = "在文件里手写一个定义";

const definition = (name: string) =>
  `  <circuit name="${name}">\n    <a name="circuit" val="${name}"/>\n  </circuit>\n`;
const withDefinitions = (xml: unknown, ...names: string[]) =>
  String(xml).replace("</project>", names.map(definition).join("") + "</project>");

/** The model's side of the second turn: read, rewrite, open what it wrote, rewrite again. */
export const rewriteThenOpen: Script = ({ calls }) => {
  if (!calls.length)
    return { tool: { name: "read_file", args: { path: "turn.circ" } } };
  if (calls.length === 1)
    return {
      tool: {
        name: "write_file",
        args: { path: "turn.circ", content: withDefinitions(calls[0].result, "extra") },
      },
    };
  if (calls.length === 2)
    return {
      tool: {
        name: "open_circuit",
        args: { path: "turn.circ", circuit: "extra" },
      },
    };
  if (calls.length === 3)
    return {
      tool: {
        name: "write_file",
        args: { path: "turn.circ", content: withDefinitions(calls[0].result, "extra", "later") },
      },
    };
  const opened = calls[2];
  return {
    text: opened.error
      ? `打不开：${opened.error.code} ${opened.error.message}`
      : `看到了 ${opened.result.circuits.length} 个定义。`,
  };
};

/** Both turns, told apart by the question. */
export const agentScript: Script = (turn) =>
  turn.question === QUESTION_REWRITE ? rewriteThenOpen(turn) : placeTwoParts(turn);

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
  assert.match(await readFile(file, "utf8"), /name="NOT Gate"[\s\S]*name="Pin"/, "The edit did not reach the file");
  const history = await command({ op: "historyList", id: doc.id });
  assert.deepEqual(
    history.entries.filter((e: any) => e.kind === "edit").map((e: any) => e.title),
    ["放置 2 个元件"],
    "One tool call should be one edit",
  );
  const status = await command({ op: "agent", method: "status" });
  assert(
    JSON.stringify(status.messages).includes(QUESTION),
    "The conversation does not list the question",
  );
  await command({ op: "folderHistoryUndo", folder_id: opened.id, id: change.id });
  assert((await readFile(file)).equals(before), "Undoing the turn did not restore the file");

  const start = stream.events.length;
  const second = await command({
    op: "agent",
    method: "ask",
    args: { question: QUESTION_REWRITE, references: [], documentId: doc.id, circuit: "main", selection: [] },
  });
  const ended = await stream.wait(
    (e) => e.topic === "agent" && e.data?.event?.type === "turn-completed" && e.data.event.turnId === second.turnId,
    start,
  );
  const later = stream.events
    .slice(start)
    .filter((e) => e.topic === "agent")
    .map((e) => e.data.event);
  assert.equal(ended.data.event.status, "completed", JSON.stringify(later));
  assert.equal(
    later.findLast((e) => e.type === "assistant-completed")?.text,
    "看到了 2 个定义。",
    "The tools did not read the rewritten file",
  );
  const reloaded = later.find((e) => e.type === "document-changed" && e.document?.id === doc.id);
  assert.deepEqual(
    reloaded?.document.circuits.map((c: any) => c.name),
    ["main", "extra"],
    "The reload did not reach the UI",
  );
  assert(
    (await command({ op: "historyList", id: doc.id })).entries.some((e: any) => e.title === "读取磁盘版本"),
    "The reload is not in the document history",
  );
  const rewrite = later.find((e) => e.type === "files-changed")?.change;
  assert.deepEqual(rewrite?.files, [{ kind: "modified", path: "turn.circ" }]);
  // The second rewrite was never opened by a tool: the turn's checkpoint
  // read the document again and told the window.
  assert(
    stream.events.slice(start).some((e) => e.topic === "documents"),
    "The checkpoint's reload did not reach the window",
  );
  assert.deepEqual(
    (await command({ op: "read", id: doc.id })).circuits.map((c: any) => c.name),
    ["main", "extra", "later"],
    "The checkpoint did not read the rewritten file",
  );
  await command({ op: "folderHistoryUndo", folder_id: opened.id, id: rewrite.id });
  assert((await readFile(file)).equals(before), "Undoing the second turn did not restore the file");
  assert.deepEqual(
    (await command({ op: "read", id: doc.id })).circuits.map((c: any) => c.name),
    ["main"],
    "The open document did not follow the undo",
  );
}
