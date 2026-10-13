import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export async function verifyHistory(
  agent: (method: string, args?: any) => Promise<any>,
  state: string,
  originalId: string,
) {
  const current = await agent("conversations");
  const stored = JSON.parse(
    await readFile(path.join(state, "conversations.json"), "utf8"),
  );
  const builtin =
    stored.workspaces[current.workspaceKey].conversations[originalId];
  const file = path.join(state, "old-sessions.json");
  const content = JSON.stringify({
    schema: "vibe-logisim.codex-sessions/v1",
    workspaces: {
      old: {
        activeId: "builtin",
        conversations: {
          builtin: { ...builtin, id: "builtin", title: "旧版样例" },
          codex: {
            id: "codex",
            title: "旧版 Codex",
            threadId: "previous-native-thread",
            messages: [
              { id: "u1", type: "user", text: "之前的电路问题" },
              { id: "a1", type: "assistant", text: "之前的回答" },
            ],
          },
        },
      },
    },
  });
  await writeFile(file, content);
  const preview = await agent("previewHistory", { file });
  assert.equal(preview.workspaces[0].count, 2);
  const args = { file, revision: preview.revision, sourceKey: "old" };
  assert.deepEqual(await agent("importHistory", args), {
    imported: 2,
    skipped: 0,
  });
  assert.deepEqual(await agent("importHistory", args), {
    imported: 0,
    skipped: 2,
  });
  assert.equal(
    await readFile(file, "utf8"),
    content,
    "Import changed the original history",
  );
  const imported = await agent("conversations");
  const codex = imported.conversations.find(
    (c: any) => c.title === "旧版 Codex",
  );
  await agent("conversations", { action: "select", id: codex.id });
  const snapshot = await agent("status");
  assert.equal(snapshot.runtime, "codex");
  assert(snapshot.messages.some((m: any) => m.text === "之前的回答"));
  assert.equal(snapshot.migration.requiresContext, true);
  assert(
    !snapshot.runtimeInstall?.busy,
    "Viewing imported history downloaded Codex",
  );
  const builtinCopy = imported.conversations.find(
    (c: any) => c.title === "旧版样例",
  );
  await agent("conversations", { action: "select", id: builtinCopy.id });
  await agent("ask", { question: "沿用刚才的电路上下文继续" });
  let done: any;
  for (let n = 0; n < 200; n++) {
    done = await agent("status");
    if (!done.busy) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(done.busy, false);
  assert(!done.transmission, JSON.stringify(done.transmission));
  const merged = JSON.parse(
    await readFile(path.join(state, "conversations.json"), "utf8"),
  );
  const original =
    merged.workspaces[current.workspaceKey].conversations[originalId];
  assert.equal(
    original.messages.length,
    builtin.messages.length,
    "Continuation edited the original record",
  );
  const copy =
    merged.workspaces[current.workspaceKey].conversations[builtinCopy.id];
  assert(
    copy.runtimeMessages.length > builtin.runtimeMessages.length,
    "Native builtin context was discarded",
  );
  await writeFile(file, content + "\n");
  await assert.rejects(() => agent("importHistory", args), /已改变/);
  const v0 = path.join(state, "old-v0.json");
  await writeFile(
    v0,
    JSON.stringify({
      schema: "vibe-logisim.codex-sessions/v0",
      workspaces: {
        old: {
          threadId: "old",
          messages: [{ id: "v0", type: "user", text: "更早的记录" }],
        },
      },
    }),
  );
  const legacy = await agent("previewHistory", { file: v0 });
  assert.equal(legacy.workspaces[0].count, 1);
  await agent("conversations", { action: "select", id: originalId });
  console.log(
    "Verified history import: v0/v1 preview, merge without overwrite, repeat import, source revision guard, offline Codex history, builtin context continuation.",
  );
}
