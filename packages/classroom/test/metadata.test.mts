import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ServiceStore } from "../../agent-runtime/src/models/services.mts";

test("historical local model metadata cannot display a misplaced provider key", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vibe-public-metadata-"));
  const secret = "sk-historical-real-secret-0123456789";
  try {
    await writeFile(
      path.join(directory, "builtin-provider.json"),
      JSON.stringify({
        version: 2,
        defaultId: "old",
        services: [
          {
            id: "old",
            name: "课堂",
            baseUrl: "https://classroom.example/api/classrooms/one/ai/v1",
            api: "openai-completions",
            apiKey: "classroom-access-token",
            model: secret,
            models: [secret],
            effort: "none",
            contextWindow: 64000,
            vision: false,
          },
        ],
      }),
    );
    const store = new ServiceStore(directory);
    assert.ok(!JSON.stringify(store.list()).includes(secret));
    assert.ok(!JSON.stringify(store.visible()).includes(secret));
    assert.throws(
      () =>
        store.save({
          name: "mistake",
          baseUrl: "https://model.example/v1",
          apiKey: secret,
          model: secret,
        }),
      /不能包含 API 密钥/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
