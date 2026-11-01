import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createClassroomServer } from "../src/server.mts";
import { analysisInput } from "../src/analysis.mts";
import type { ClassroomMember, WorkSnapshot } from "../src/types.ts";

test("classroom editing and reusable teacher models enforce ownership and reject misplaced keys; large compressed circuits round-trip", async () => {
  const app = createClassroomServer({
    database: ":memory:",
    teacherCode: "invite",
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${(app.server.address() as any).port}/api`;
  const call = async (
    route: string,
    token = "",
    body?: unknown,
    method = body ? "POST" : "GET",
    status = 200,
  ) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await response.json()) as any;
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  const register = (username: string, role: string) =>
    call(
      "/auth/register",
      "",
      {
        username,
        role,
        name: username,
        studentNo: username,
        password: "test-password",
        teacherCode: "invite",
      },
      "POST",
      201,
    );
  try {
    const teacher = await register("teacher", "teacher"),
      other = await register("other", "teacher"),
      student = await register("student", "student");
    const room = (
      await call("/classrooms", teacher.token, { title: "原课堂" }, "POST", 201)
    ).classroom;
    await call("/classrooms/join", student.token, { code: room.code });
    await call(
      `/classrooms/${room.id}`,
      student.token,
      { title: "bad" },
      "PATCH",
      403,
    );
    await call(
      `/classrooms/${room.id}`,
      other.token,
      { title: "bad" },
      "PATCH",
      404,
    );
    const edited = (
      await call(
        `/classrooms/${room.id}`,
        teacher.token,
        { title: "新课堂", task: "新任务", rubric: "新标准", capacity: 3 },
        "PATCH",
      )
    ).classroom;
    assert.equal(edited.title, "新课堂");
    assert.equal(edited.task, "新任务");
    assert.equal(edited.rubric, "新标准");
    assert.equal(edited.capacity, 3);
    assert.equal(edited.code, room.code);
    const secret = "sk-test-misplaced-0123456789abcdef";
    const config = {
      name: "教师模型",
      baseUrl: "https://model.example/v1",
      api: "openai-completions",
      apiKey: secret,
      model: "test-model",
      effort: "none",
      contextWindow: 64000,
      vision: false,
      enabled: true,
    };
    await call(
      "/ai-providers",
      teacher.token,
      { ...config, model: secret },
      "POST",
      400,
    );
    await call(
      `/classrooms/${room.id}/ai`,
      teacher.token,
      { ...config, name: secret },
      "POST",
      400,
    );
    await call("/ai-providers", student.token, undefined, "GET", 403);
    const template = (await call("/ai-providers", teacher.token, config))
      .provider;
    assert.ok(!JSON.stringify(template).includes(secret));
    assert.equal(
      (await call("/ai-providers", other.token)).providers.length,
      0,
    );
    await call(
      "/ai-providers",
      other.token,
      { ...config, id: template.id },
      "POST",
      400,
    );
    const second = (
      await call(
        "/classrooms",
        other.token,
        { title: "他人的课堂" },
        "POST",
        201,
      )
    ).classroom;
    await call(
      `/classrooms/${second.id}/ai`,
      other.token,
      { providerId: template.id, enabled: true },
      "POST",
      400,
    );
    await call(`/classrooms/${room.id}/ai`, teacher.token, {
      providerId: template.id,
      enabled: true,
    });
    const room2 = (
      await call(
        "/classrooms",
        teacher.token,
        { title: "第二课堂" },
        "POST",
        201,
      )
    ).classroom;
    await call(`/classrooms/${room2.id}/ai`, teacher.token, {
      providerId: template.id,
      enabled: true,
    });
    assert.equal(
      (await call("/ai-providers", teacher.token)).providers.length,
      1,
      "classrooms reuse a single library entry",
    );
    const access = await call(
      `/classrooms/${room.id}/ai/access`,
      student.token,
      {},
    );
    assert.match(access.apiKey, /^[a-f0-9]{64}$/);
    assert.notEqual(access.apiKey, secret);
    assert.ok(
      !JSON.stringify(
        await call(`/classrooms/${room.id}`, student.token),
      ).includes(secret),
    );
    const xml =
      "<project><!--" +
      "x".repeat(2300000) +
      '--><circuit name="main"/></project>';
    const snapshot: WorkSnapshot = {
      xml,
      name: "cpu.circ",
      revision: "r1",
      circuit: "main",
      components: 200,
      wires: 400,
      conversationId: "c1",
      messages: [{ id: "q1", type: "user", text: "检查译码逻辑" }],
      status: "working",
    };
    const id = randomUUID();
    const response = await fetch(`${base}/classrooms/${room.id}/submissions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${student.token}`,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: gzipSync(JSON.stringify({ id, snapshot })),
    });
    assert.equal(response.status, 201, await response.text());
    assert.equal(
      (await call(`/classrooms/${room.id}/submissions/${id}`, teacher.token))
        .submission.snapshot.xml,
      xml,
    );
    await call(`/classrooms/${room.id}/submissions`, student.token, {
      id,
      snapshot,
    });
    const id2 = randomUUID();
    await call(
      `/classrooms/${room.id}/submissions`,
      student.token,
      {
        id: id2,
        snapshot: {
          ...snapshot,
          messages: [
            ...snapshot.messages,
            { id: "a1", type: "assistant", text: "比较控制信号" },
          ],
        },
      },
      "POST",
      201,
    );
    assert.equal(
      (await call(`/classrooms/${room.id}/submissions/${id2}`, teacher.token))
        .submission.snapshot.xml,
      xml,
    );
    assert.equal(
      (await call(`/classrooms/${room.id}`, teacher.token)).members[0]
        .submissionCount,
      2,
    );
    await call(
      `/classrooms/${room.id}/submissions`,
      student.token,
      { id: randomUUID(), snapshot: { ...snapshot, xml: "" } },
      "POST",
      400,
    );
  } finally {
    await app.close();
  }
});

test("whole-class analysis has a global prompt budget and explicitly reports omitted evidence", () => {
  const roster: ClassroomMember[] = Array.from({ length: 500 }, (_, i) => ({
    user: {
      id: `student-${i}`,
      name: "学生姓名".repeat(8),
      username: `s${i}`,
      role: "student",
      studentNo: String(i),
    },
    joinedAt: "now",
    submissionCount: 3,
    latest: {
      id: `submission-${i}`,
      studentId: `student-${i}`,
      createdAt: "now",
      name: "cpu.circ",
      status: "working",
      revision: "r",
      components: 100,
      wires: 200,
      questions: 500,
      toolErrors: 3,
    },
  }));
  const read = (): WorkSnapshot => ({
    xml: "<project>" + "x".repeat(2300000) + "</project>",
    name: "cpu.circ",
    revision: "r",
    circuit: "main",
    components: 100,
    wires: 200,
    status: "working",
    conversationId: "c",
    messages: Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      type: i % 2 ? "assistant" : "user",
      text: "讨论进位逻辑".repeat(3000),
    })),
  });
  const input = analysisInput(
    { task: "完成 CPU", rubric: "功能验证" },
    "分析全班",
    roster,
    read,
    false,
    "fixture",
  );
  assert.ok(JSON.stringify(input.messages).length < 26000);
  assert.ok(input.includedStudents < 500);
  assert.ok(input.truncated);
  assert.ok(
    !JSON.stringify(input.messages).includes("<project>"),
    "whole-class mode omits raw XML",
  );
  assert.equal(input.evidence.length, input.includedStudents);
});
