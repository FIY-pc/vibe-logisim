import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { assessments } from "../src/assessment.mts";
import type { GradeInput, GradeRunner } from "../src/assessment-types.ts";
import type { ClassroomUser } from "../src/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const answer = (input: GradeInput) => ({
  rows: input.tests.map((t) => ({
    oscillating: false,
    outputs: Object.fromEntries(
      Object.entries(t.expected).map(([name, value]) => [
        name,
        { value, bits: String(value) },
      ]),
    ),
  })),
});

async function fixture(grade: GradeRunner = async (input) => answer(input)) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE classrooms(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,student_no TEXT); CREATE TABLE members(class_id TEXT,student_id TEXT); INSERT INTO classrooms VALUES('class'); INSERT INTO users VALUES('teacher','教师',''),('student','学生','01'); INSERT INTO members VALUES('class','student');",
  );
  const room = { archived: false };
  const bodies = new WeakMap<IncomingMessage, unknown>();
  const app = assessments(db, {
    grade,
    body: async (req) => bodies.get(req),
    roomFor: () => ({ ...room }),
    fail: (status, message) => {
      throw Object.assign(new Error(message), { status });
    },
  });
  const teacher: ClassroomUser = {
    id: "teacher",
    username: "teacher",
    name: "教师",
    studentNo: "",
    role: "teacher",
  };
  const student: ClassroomUser = {
    ...teacher,
    id: "student",
    username: "student",
    role: "student",
  };
  async function call(
    route: string,
    method: string,
    body?: unknown,
    user = teacher,
  ) {
    const req = { url: "/api/classrooms/class" + route } as IncomingMessage;
    bodies.set(req, body);
    let result = { status: 0, data: null as any };
    try {
      await app.handle(req, req.url!, method, user, (status, data) => {
        result = { status, data };
      });
    } catch (e) {
      result = {
        status: (e as any).status || 500,
        data: { error: (e as Error).message },
      };
    }
    return result;
  }
  const chapter = (
    await call("/chapters", "POST", { title: "第一章", position: 0 })
  ).data;
  const config = {
    chapterId: chapter.id,
    title: "第一关",
    position: 0,
    published: true,
    points: 10,
    circuit: "main",
    templateName: "starter.circ",
    templateXml: '<project><circuit name="main"/></project>',
    tests: [
      {
        id: "test",
        title: "test",
        hidden: false,
        inputs: { A: 0 },
        expected: { Y: 1 },
      },
    ],
  };
  const lesson = (await call("/lessons", "POST", config)).data.lesson;
  assert.ok(lesson?.id);
  return { db, app, room, call, chapter, config, lesson, student };
}

for (const activeKind of ["preview", "submission"] as const) {
  test(`a preview waiting for its body cannot overlap an active ${activeKind}`, async () => {
    const started = deferred<void>(),
      finish = deferred<void>();
    let calls = 0;
    const f = await fixture(async (input) => {
      calls++;
      if (calls === 1) {
        started.resolve();
        await finish.promise;
      }
      return answer(input);
    });
    const body = deferred<{ xml: string }>();
    const slow = f.call(
      `/lessons/${f.lesson.id}/preview`,
      "POST",
      body.promise,
    );
    let active: Promise<any>;
    if (activeKind === "preview")
      active = f.call(`/lessons/${f.lesson.id}/preview`, "POST", {
        xml: f.config.templateXml,
      });
    else
      active = f.call(
        `/lessons/${f.lesson.id}/attempts`,
        "POST",
        {
          version: 1,
          clientId: randomUUID(),
          name: "answer.circ",
          xml: f.config.templateXml,
        },
        f.student,
      );
    try {
      await started.promise;
      body.resolve({ xml: f.config.templateXml });
      assert.equal(
        (await slow).status,
        429,
        "a completed upload must recheck the grading slot",
      );
      assert.equal(calls, 1, "only one grader may run at a time");
    } finally {
      finish.resolve();
      await active;
      await f.app.close();
      f.db.close();
    }
  });
}

test("a synchronous preview grader failure releases the grading slot", async () => {
  let calls = 0;
  const f = await fixture((input) => {
    if (++calls === 1) throw Error("fixture failure");
    return Promise.resolve(answer(input));
  });
  try {
    assert.equal(
      (
        await f.call(`/lessons/${f.lesson.id}/preview`, "POST", {
          xml: f.config.templateXml,
        })
      ).status,
      500,
    );
    assert.equal(
      (
        await f.call(`/lessons/${f.lesson.id}/preview`, "POST", {
          xml: f.config.templateXml,
        })
      ).status,
      200,
    );
  } finally {
    await f.app.close();
    f.db.close();
  }
});

test("a student upload is rejected if its lesson changes before the body finishes", async () => {
  const f = await fixture();
  try {
    const body = deferred<unknown>();
    const pending = f.call(
      `/lessons/${f.lesson.id}/attempts`,
      "POST",
      body.promise,
      f.student,
    );
    assert.equal(
      (
        await f.call(`/lessons/${f.lesson.id}`, "PATCH", {
          ...f.config,
          version: 1,
          tests: [{ ...f.config.tests[0], expected: { Y: 0 } }],
        })
      ).status,
      200,
    );
    body.resolve({
      version: 1,
      clientId: randomUUID(),
      name: "answer.circ",
      xml: f.config.templateXml,
    });
    assert.equal((await pending).status, 409);
    assert.equal(
      (f.db.prepare("SELECT count(*) n FROM assessment_attempts").get() as any)
        .n,
      0,
    );
  } finally {
    await f.app.close();
    f.db.close();
  }
});

test("closing the classroom while an upload is in progress blocks the submission", async () => {
  const f = await fixture();
  try {
    const body = deferred<unknown>();
    const pending = f.call(
      `/lessons/${f.lesson.id}/attempts`,
      "POST",
      body.promise,
      f.student,
    );
    f.room.archived = true;
    body.resolve({
      version: 1,
      clientId: randomUUID(),
      name: "answer.circ",
      xml: f.config.templateXml,
    });
    assert.equal((await pending).status, 409);
    assert.equal(
      (f.db.prepare("SELECT count(*) n FROM assessment_attempts").get() as any)
        .n,
      0,
    );
  } finally {
    await f.app.close();
    f.db.close();
  }
});

test("reference preview rejects an outdated lesson revision", async () => {
  const f = await fixture();
  try {
    await f.call(`/lessons/${f.lesson.id}`, "PATCH", {
      ...f.config,
      version: 1,
      title: "已更新关卡",
    });
    assert.equal(
      (
        await f.call(`/lessons/${f.lesson.id}/preview`, "POST", {
          version: 1,
          xml: f.config.templateXml,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(`/lessons/${f.lesson.id}/preview`, "POST", {
          version: 2,
          xml: f.config.templateXml,
        })
      ).status,
      200,
    );
  } finally {
    await f.app.close();
    f.db.close();
  }
});

test("grade sheets order lessons by chapter and then lesson position", async () => {
  const f = await fixture();
  try {
    const b = (
      await f.call("/chapters", "POST", { title: "第二章", position: 1 })
    ).data;
    await f.call("/lessons", "POST", {
      ...f.config,
      title: "第二关",
      position: 1,
    });
    await f.call("/lessons", "POST", {
      ...f.config,
      chapterId: b.id,
      title: "第三关",
      position: 0,
    });
    await f.call("/lessons", "POST", {
      ...f.config,
      chapterId: b.id,
      title: "第四关",
      position: 1,
    });
    const matrix = (await f.call("/curriculum", "POST", {})).data;
    assert.deepEqual(
      matrix.lessons.map((l: any) => l.title),
      ["第一关", "第二关", "第三关", "第四关"],
    );
  } finally {
    await f.app.close();
    f.db.close();
  }
});
