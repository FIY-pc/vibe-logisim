import { test } from "node:test";
import assert from "node:assert/strict";
import { createClassroomServer } from "../src/server.mts";
import type { GradeRunner } from "../src/assessment-types.ts";

test("chapters, published lessons, hidden cases, immutable grading and classroom permissions", async () => {
  let release: (() => void) | undefined;
  const grade: GradeRunner = async (input) => {
    if (input.xml.includes("hold"))
      await new Promise<void>((r) => (release = r));
    return {
      rows: input.tests.map((t) => ({
        oscillating: false,
        outputs: {
          Y: {
            bits: "1",
            value: input.xml.includes("wrong") ? 99 : t.expected.Y,
          },
        },
      })),
    };
  };
  const app = createClassroomServer({
    database: ":memory:",
    teacherCode: "assessment-invite",
    grade,
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as any).port}/api`;
  const call = async (
    path: string,
    token = "",
    body?: any,
    status = 200,
    method = body ? "POST" : "GET",
  ) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await r.json()) as any;
    assert.equal(r.status, status, JSON.stringify(data));
    return data;
  };
  try {
    const teacher = await call(
      "/auth/register",
      "",
      {
        username: "assess-teacher",
        password: "local-test-password",
        name: "教师",
        role: "teacher",
        teacherCode: "assessment-invite",
      },
      201,
    );
    const student = await call(
      "/auth/register",
      "",
      {
        username: "assess-student",
        password: "local-test-password",
        name: "学生甲",
        studentNo: "A01",
        role: "student",
      },
      201,
    );
    const other = await call(
      "/auth/register",
      "",
      {
        username: "assess-other",
        password: "local-test-password",
        name: "学生乙",
        studentNo: "A02",
        role: "student",
      },
      201,
    );
    const room = (
        await call(
          "/classrooms",
          teacher.token,
          { title: "评测课堂", task: "组合逻辑" },
          201,
        )
      ).classroom,
      p = "/classrooms/" + room.id;
    await call("/classrooms/join", student.token, { code: room.code });
    await call("/classrooms/join", other.token, { code: room.code });
    await call(p + "/chapters", student.token, { title: "越权" }, 403);
    const chapter = await call(
      p + "/chapters",
      teacher.token,
      { title: "组合电路", position: 0 },
      201,
    );
    const config = {
      chapterId: chapter.id,
      title: "反相器",
      description: "# 实验说明",
      circuit: "main",
      templateName: "starter.circ",
      templateXml: '<project><circuit name="main"/></project>',
      published: false,
      position: 0,
      images: [],
      tests: [
        {
          id: "public",
          title: "公开",
          hidden: false,
          inputs: { A: 0 },
          expected: { Y: 1 },
        },
        {
          id: "secret",
          title: "教师私有场景",
          hidden: true,
          inputs: { A: 123456789 },
          expected: { Y: 987654321 },
        },
      ],
    };
    let l = (await call(p + "/lessons", teacher.token, config, 201)).lesson;
    assert.equal(
      (await call(p + "/curriculum", student.token)).chapters[0].lessons.length,
      0,
    );
    await call(p + "/lessons/" + l.id, student.token, undefined, 404);
    l = (
      await call(
        p + "/lessons/" + l.id,
        teacher.token,
        { ...config, version: l.version, published: true },
        200,
        "PATCH",
      )
    ).lesson;
    const studentLesson = (await call(p + "/lessons/" + l.id, student.token))
      .lesson;
    assert.equal(studentLesson.tests.length, 1);
    assert.equal(studentLesson.hiddenCount, 1);
    assert.ok(!JSON.stringify(studentLesson).includes("123456789"));
    await call(
      p + "/lessons/" + l.id,
      student.token,
      { ...config, version: l.version },
      403,
      "PATCH",
    );
    const submit = {
      version: l.version,
      clientId: crypto.randomUUID(),
      name: "answer.circ",
      xml: '<project><circuit name="hold"/></project>',
    };
    const accepted = (
      await call(
        p + "/lessons/" + l.id + "/attempts",
        student.token,
        submit,
        202,
      )
    ).attempt;
    const duplicate = (
      await call(p + "/lessons/" + l.id + "/attempts", student.token, submit)
    ).attempt;
    assert.equal(accepted.id, duplicate.id);
    assert.equal(
      (await call(p + "/attempts/" + accepted.id, student.token)).attempt
        .status,
      "running",
    );
    const updated = (
      await call(
        p + "/lessons/" + l.id,
        teacher.token,
        {
          ...config,
          version: l.version,
          published: true,
          tests: [{ ...config.tests[0], expected: { Y: 0 } }],
        },
        200,
        "PATCH",
      )
    ).lesson;
    await call(
      p + "/lessons/" + l.id + "/attempts",
      other.token,
      { ...submit, clientId: crypto.randomUUID() },
      409,
    );
    release!();
    let result: any;
    for (let i = 0; i < 50; i++) {
      result = (await call(p + "/attempts/" + accepted.id, student.token))
        .attempt;
      if (result.status === "passed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(result.status, "passed");
    assert.equal(result.total, 2);
    assert.equal(result.lessonVersion, l.gradingVersion);
    assert.deepEqual(result.result[1], {
      id: "secret",
      title: "隐藏用例",
      hidden: true,
      passed: true,
    });
    assert.ok(!JSON.stringify(result).includes("987654321"));
    assert.ok(!JSON.stringify(result).includes("123456789"));
    const full = (await call(p + "/attempts/" + accepted.id, teacher.token))
      .attempt;
    assert.equal(full.result[1].inputs.A, 123456789);
    await call(p + "/attempts/" + accepted.id, other.token, undefined, 404);
    assert.ok(
      (
        await call(p + "/attempts/" + accepted.id + "/source", student.token)
      ).attempt.xml.includes("hold"),
    );
    assert.equal(
      (await call(p + "/curriculum", student.token)).chapters[0].lessons[0]
        .passed,
      false,
    );
    await call(
      p + "/lessons/" + l.id,
      teacher.token,
      { ...config, version: l.version, published: true },
      409,
      "PATCH",
    );
    await call(
      p + "/lessons/" + l.id + "/attempts",
      other.token,
      {
        version: updated.version,
        clientId: crypto.randomUUID(),
        name: "x.circ",
        xml: "<!DOCTYPE project><project/>",
      },
      400,
    );
    const bad = (
      await call(
        p + "/lessons/" + l.id + "/attempts",
        other.token,
        {
          version: updated.version,
          clientId: crypto.randomUUID(),
          name: "wrong.circ",
          xml: '<project><circuit name="wrong"/></project>',
        },
        202,
      )
    ).attempt;
    for (let i = 0; i < 50; i++) {
      const r = (await call(p + "/attempts/" + bad.id, other.token)).attempt;
      if (r.status === "failed") {
        assert.equal(r.result[0].outputs.Y.value, 99);
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
      if (i === 49) assert.fail("Incorrect circuit did not fail");
    }
    const progress = await call(p + "/curriculum", teacher.token, {});
    assert.equal(progress.students.length, 2);
    assert.equal(progress.students[0].lessons[0].passed, false);
    await call(p, teacher.token, { archived: true }, 200, "PATCH");
    await call(
      p + "/lessons/" + l.id + "/attempts",
      student.token,
      {
        version: updated.version,
        clientId: crypto.randomUUID(),
        name: "x.circ",
        xml: config.templateXml,
      },
      409,
    );
  } finally {
    release?.();
    await app.close();
  }
});
