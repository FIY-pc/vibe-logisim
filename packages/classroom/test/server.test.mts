import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createClassroomServer } from "../src/server.mts";
import type { WorkSnapshot } from "../src/types.ts";

test("classroom lifecycle, role isolation, immutable evidence, AI scope and persistence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vibe-classroom-test-"));
  const prompts: string[] = [];
  let failure: "none" | "json" | "length" | "http" = "none";
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    prompts.push(JSON.stringify(input.messages));
    assert.equal(req.headers.authorization, "Bearer test-provider-key");
    assert.equal(input.stream, false);
    if (failure === "http") {
      res.writeHead(503);
      res.end("unavailable");
      return;
    }
    if (failure === "json") {
      res.end("not-json");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { content: "依据提交证据：建议复习进位逻辑。" },
            finish_reason: failure === "length" ? "length" : "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const providerPort = (provider.address() as any).port;
  const options = {
    database: path.join(root, "classroom.sqlite"),
    teacherCode: "teacher-invite",
    ai: {
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: "test-provider-key",
      model: "test-model",
    },
  };
  let app = createClassroomServer(options);
  const listen = async () => {
    await new Promise<void>((resolve) =>
      app.server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(app.server.address() as any).port}`;
  };
  let base = await listen();
  const request = async (
    route: string,
    method = "GET",
    body?: unknown,
    token?: string,
    status = 200,
  ) => {
    const response = await fetch(base + "/api" + route, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = (await response.json()) as any;
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  try {
    await request("/classrooms", "GET", undefined, undefined, 401);
    const account = (username: string, role = "student", extra = {}) => ({
      username,
      password: "a-long-password",
      role,
      name: username,
      studentNo: username,
      ...extra,
    });
    await request(
      "/auth/register",
      "POST",
      account("fake-teacher", "teacher"),
      undefined,
      403,
    );
    const t = await request(
      "/auth/register",
      "POST",
      account("teacher", "teacher", { teacherCode: "teacher-invite" }),
      undefined,
      201,
    );
    const t2 = await request(
      "/auth/register",
      "POST",
      account("other-teacher", "teacher", { teacherCode: "teacher-invite" }),
      undefined,
      201,
    );
    const s = await request(
      "/auth/register",
      "POST",
      account("student-1"),
      undefined,
      201,
    );
    const s2 = await request(
      "/auth/register",
      "POST",
      account("student-2"),
      undefined,
      201,
    );
    const outsider = await request(
      "/auth/register",
      "POST",
      account("outsider"),
      undefined,
      201,
    );
    await request(
      "/auth/login",
      "POST",
      { username: "teacher", password: "wrong-password" },
      undefined,
      401,
    );
    assert.equal(
      (await request("/auth/login", "POST", account("teacher"))).user.id,
      t.user.id,
    );
    await request("/classrooms", "POST", { title: "spoof" }, s.token, 403);
    const c = (
      await request(
        "/classrooms",
        "POST",
        { title: "全加器", task: "完成一位全加器", capacity: 2 },
        t.token,
        201,
      )
    ).classroom;
    await request("/classrooms/join", "POST", { code: c.code }, s.token);
    await request(
      "/classrooms/join",
      "POST",
      { code: c.code.toLowerCase() },
      s.token,
    );
    await request("/classrooms/join", "POST", { code: c.code }, s2.token);
    await request(
      "/classrooms/join",
      "POST",
      { code: c.code },
      outsider.token,
      409,
    );
    await request(`/classrooms/${c.id}`, "GET", undefined, t2.token, 404);
    await request(`/classrooms/${c.id}`, "GET", undefined, outsider.token, 404);
    const snapshot: WorkSnapshot = {
      name: "adder.circ",
      xml: '<project><circuit name="main"/></project>',
      revision: "r1",
      circuit: "main",
      components: 3,
      wires: 2,
      conversationId: "conversation-1",
      messages: [
        { id: "q1", type: "user", text: "进位为什么错误？" },
        {
          id: "tool1",
          type: "activity",
          text: "simulate failed",
          status: "error",
        },
      ],
      status: "working",
      progress: 50,
      note: "测试中",
    };
    const id = randomUUID();
    await request(
      `/classrooms/${c.id}/submissions`,
      "POST",
      { id, snapshot },
      s.token,
      201,
    );
    await request(
      `/classrooms/${c.id}/submissions`,
      "POST",
      { id, snapshot },
      s.token,
    );
    await request(
      `/classrooms/${c.id}/submissions`,
      "POST",
      { id, snapshot: { ...snapshot, progress: 90 } },
      s.token,
      409,
    );
    const detail = await request(
      `/classrooms/${c.id}`,
      "GET",
      undefined,
      t.token,
    );
    assert.equal(detail.members.length, 2);
    assert.equal(
      detail.members.find((m: any) => m.user.id === s.user.id).latest.questions,
      1,
    );
    assert.equal(
      detail.members.find((m: any) => m.user.id === s.user.id).latest
        .toolErrors,
      1,
    );
    const own = await request(`/classrooms/${c.id}`, "GET", undefined, s.token);
    assert.equal(own.members.length, 1);
    assert.equal(own.classroom.code, undefined);
    await request(
      `/classrooms/${c.id}/submissions/${id}`,
      "GET",
      undefined,
      s2.token,
      404,
    );
    assert.equal(
      (
        await request(
          `/classrooms/${c.id}/submissions/${id}`,
          "GET",
          undefined,
          t.token,
        )
      ).submission.snapshot.xml,
      snapshot.xml,
    );
    await request(`/classrooms/${c.id}/analysis`, "POST", {}, s.token, 403);
    await request(
      `/classrooms/${c.id}/analysis`,
      "POST",
      { studentId: outsider.user.id },
      t.token,
      404,
    );
    for (const mode of ["http", "json", "length"] as const) {
      failure = mode;
      await request(
        `/classrooms/${c.id}/analysis`,
        "POST",
        { studentId: s.user.id },
        t.token,
        502,
      );
      assert.equal(
        (await request(`/classrooms/${c.id}`, "GET", undefined, t.token))
          .analyses.length,
        0,
        "failed or incomplete reports are never saved",
      );
    }
    failure = "none";
    const report = (
      await request(
        `/classrooms/${c.id}/analysis`,
        "POST",
        { studentId: s.user.id },
        t.token,
      )
    ).report;
    assert.deepEqual(report.evidence, [id]);
    assert.equal(report.coveredStudents, 1);
    assert.equal(report.totalStudents, 2);
    assert.ok(prompts[0].includes("进位为什么错误"));
    assert.ok(!prompts[0].includes("student-2"));
    assert.ok(!prompts[0].includes("test-provider-key"));
    await request(`/classrooms/${c.id}`, "PATCH", { archived: true }, t.token);
    await request(
      `/classrooms/${c.id}/submissions`,
      "POST",
      { id: randomUUID(), snapshot },
      s.token,
      409,
    );
    await app.close();
    app = createClassroomServer(options);
    base = await listen();
    const restored = await request(
      `/classrooms/${c.id}`,
      "GET",
      undefined,
      t.token,
    );
    assert.equal(restored.classroom.archived, true);
    assert.equal(restored.analyses[0].id, report.id);
    assert.equal(
      restored.members.find((m: any) => m.user.id === s.user.id)
        .submissionCount,
      1,
    );
    await request("/auth/logout", "POST", {}, s.token);
    await request("/auth/me", "GET", undefined, s.token, 401);
    const cors = await fetch(base + "/api/health", {
      headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(cors.status, 403);
  } finally {
    await app.close();
    provider.closeIdleConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
