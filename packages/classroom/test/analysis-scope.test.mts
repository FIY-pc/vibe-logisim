import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createClassroomServer } from "../src/server.mts";

test("individual analysis scopes grading and its cache to the selected student", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const prompts: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    prompts.push(JSON.parse(request.messages[1].content));
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: "依据评测结果分析。" }, finish_reason: "stop" },
        ],
      }),
    );
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const app = createClassroomServer({
    database: ":memory:",
    teacherCode: "scope-invite",
    ai: {
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      apiKey: "fixture",
      model: "fixture",
    },
    grade: async ({ xml, tests }) => ({
      rows: tests.map(() => ({
        oscillating: false,
        outputs: {
          Y: { value: xml.includes('name="correct"') ? 1 : 0, bits: "0" },
        },
      })),
    }),
  });
  try {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.server.address() as any).port}/api`;
    async function call(route: string, token = "", body?: any) {
      const response = await fetch(base + route, {
        method: body ? "POST" : "GET",
        headers: {
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await response.json()) as any;
      assert.ok(response.ok, JSON.stringify(data));
      return data;
    }
    const register = (username: string, teacher = false) =>
      call("/auth/register", "", {
        username,
        password: "local-fixture-password",
        name: username,
        studentNo: username,
        role: teacher ? "teacher" : "student",
        ...(teacher ? { teacherCode: "scope-invite" } : {}),
      });
    const teacher = await register("scope-teacher", true),
      a = await register("student-a"),
      b = await register("student-b");
    const room = (
      await call("/classrooms", teacher.token, { title: "scope-class" })
    ).classroom;
    const route = "/classrooms/" + room.id;
    for (const s of [a, b])
      await call("/classrooms/join", s.token, { code: room.code });
    const chapter = await call(route + "/chapters", teacher.token, {
      title: "chapter",
    });
    const lesson = (
      await call(route + "/lessons", teacher.token, {
        chapterId: chapter.id,
        title: "lesson",
        published: true,
        points: 25,
        circuit: "main",
        templateName: "starter.circ",
        templateXml: '<project><circuit name="main"/></project>',
        tests: [
          {
            id: "case",
            title: "case",
            hidden: false,
            inputs: { A: 0 },
            expected: { Y: 1 },
          },
        ],
      })
    ).lesson;
    async function submit(student: any, correct: boolean) {
      t.mock.timers.tick(3100);
      const created = (
        await call(
          route + "/lessons/" + lesson.id + "/attempts",
          student.token,
          {
            version: lesson.version,
            clientId: randomUUID(),
            name: "answer.circ",
            xml: `<project><circuit name="${correct ? "correct" : "wrong"}"/></project>`,
          },
        )
      ).attempt;
      for (let i = 0; i < 100; i++) {
        const current = (
          await call(route + "/attempts/" + created.id, student.token)
        ).attempt;
        if (!["running", "queued"].includes(current.status)) {
          assert.equal(current.status, correct ? "passed" : "failed");
          return;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail("fixture grading did not finish");
    }
    await submit(a, false);
    await submit(b, true);
    const preview = await call(route + "/analysis/preview", teacher.token, {
      studentId: a.user.id,
    });
    assert.equal(preview.includedStudents, 1);
    assert.equal(preview.totalStudents, 1);
    const first = await call(route + "/analysis", teacher.token, {
      studentId: a.user.id,
    });
    assert.notEqual(first.cached, true);
    assert.deepEqual(
      prompts[0].students.map((s: any) => s.studentId),
      [a.user.id],
    );
    assert.equal(
      prompts[0].assessment.students.length,
      1,
      "other students' grades must not enter an individual prompt",
    );
    assert.equal(prompts[0].assessment.students[0].studentId, a.user.id);
    assert.equal(prompts[0].assessment.students[0].total, 0);
    await submit(b, false);
    const cached = await call(route + "/analysis", teacher.token, {
      studentId: a.user.id,
    });
    assert.equal(
      cached.cached,
      true,
      "another student's attempt must not invalidate this report",
    );
    assert.equal(prompts.length, 1);
    await submit(a, true);
    assert.notEqual(
      (await call(route + "/analysis", teacher.token, { studentId: a.user.id }))
        .cached,
      true,
    );
    assert.equal(prompts[1].assessment.students[0].total, 25);
    await call(route + "/analysis", teacher.token, {});
    assert.equal(
      prompts[2].assessment.students.length,
      2,
      "whole-class analysis still includes both students",
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
