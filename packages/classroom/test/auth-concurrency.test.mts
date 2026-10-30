import { test } from "node:test";
import assert from "node:assert/strict";
import { createClassroomServer } from "../src/server.mts";

test("a shared classroom gateway can register a full class while one account is throttled", async () => {
  const app = createClassroomServer({
    database: ":memory:",
    teacherCode: "invite",
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${(app.server.address() as any).port}/api/auth`;
  const post = (route: string, body: unknown) =>
    fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const registrations = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        post("/register", {
          username: `student-${i}`,
          name: `Student ${i}`,
          studentNo: `S${i}`,
          password: "long-password",
          role: "student",
        }),
      ),
    );
    assert.deepEqual(
      registrations.map((r) => r.status),
      Array(25).fill(201),
    );
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        post("/login", { username: "unknown", password: "wrong-password" }),
      ),
    );
    assert.ok(attempts.every((r) => r.status === 401));
    assert.equal(
      (
        await post("/login", {
          username: "unknown",
          password: "wrong-password",
        })
      ).status,
      429,
    );
    assert.equal(
      (
        await post("/login", {
          username: "student-0",
          password: "long-password",
        })
      ).status,
      200,
    );
    const duplicates = await Promise.all(
      Array.from({ length: 2 }, () =>
        post("/register", {
          username: "duplicate",
          name: "D",
          studentNo: "D",
          role: "student",
          password: "long-password",
        }),
      ),
    );
    assert.deepEqual(duplicates.map((r) => r.status).sort(), [201, 409]);
  } finally {
    await app.close();
  }
});
