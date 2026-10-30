import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ServiceStore } from "../../agent-runtime/src/models/services.mts";
import { DatabaseSync } from "node:sqlite";
import { classroomProviders } from "../src/ai-provider.mts";

test("historical server metadata is redacted before classroom access or teacher library responses", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE classrooms(id TEXT PRIMARY KEY,teacher_id TEXT); INSERT INTO users VALUES('teacher'),('student'); INSERT INTO classrooms VALUES('room','teacher')",
  );
  const providers = classroomProviders(db, ":memory:");
  const secret = "sk-historical-upstream-key-0123456789";
  try {
    providers.save("room", {
      name: "课堂服务",
      baseUrl: "https://provider.example/v1",
      api: "openai-completions",
      apiKey: secret,
      model: "model",
      effort: "none",
      contextWindow: 64000,
      vision: false,
      enabled: true,
    });
    const row = db
      .prepare("SELECT config FROM classroom_providers WHERE class_id='room'")
      .get() as any;
    db.prepare(
      "UPDATE classroom_providers SET config=? WHERE class_id='room'",
    ).run(
      JSON.stringify({
        ...JSON.parse(row.config),
        model: secret,
        models: [secret],
      }),
    );
    assert.ok(!JSON.stringify(providers.visible("room")).includes(secret));
    assert.ok(
      !JSON.stringify(providers.issue("room", "student")).includes(secret),
    );
    providers.remember("room", "teacher");
    assert.ok(!JSON.stringify(providers.list("teacher")).includes(secret));
  } finally {
    db.close();
  }
});

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
