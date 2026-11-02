import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisInput } from "../src/analysis.mts";
import type { ClassroomMember, WorkSnapshot } from "../src/types.ts";

function fixture(count: number, lessons: number) {
  const roster: ClassroomMember[] = Array.from({ length: count }, (_, i) => ({
    user: {
      id: `student-${i}`,
      username: `s${i}`,
      name: `学生${i}`,
      role: "student",
      studentNo: String(i),
    },
    joinedAt: "now",
    submissionCount: 1,
    latest: {
      id: `snapshot-${i}`,
      studentId: `student-${i}`,
      createdAt: "now",
      name: "adder.circ",
      status: "working",
      revision: "r",
      components: 10,
      wires: 20,
      questions: 2,
      toolErrors: 0,
    },
  }));
  const grading = {
    lessons: Array.from({ length: lessons }, (_, i) => ({
      title: `第${i}关组合逻辑设计`,
      points: 25,
    })),
    students: roster.map((m, i) => ({
      studentId: m.user.id,
      name: m.user.name,
      student_no: m.user.studentNo,
      lessons: Array.from({ length: lessons }, (_, j) => {
        const passed = i === 0 || (i + j) % 3 === 0;
        const status = passed
          ? "passed"
          : ["failed", "queued", "running", "error", null][j % 5];
        return {
          title: `第${j}关组合逻辑设计`,
          points: 25,
          passed,
          attempts: status ? (j % 2 ? 2 : 1) : 0,
          lastStatus: status,
          lastPassed: passed ? 8 : status ? 4 : 0,
          total: status ? 8 : 0,
        };
      }),
    })),
  };
  const snapshot = (): WorkSnapshot => ({
    name: "adder.circ",
    xml: '<project><circuit name="main"/></project>',
    revision: "r",
    circuit: "main",
    components: 10,
    wires: 20,
    conversationId: "chat",
    status: "working",
    messages: [
      { id: "q", type: "user", text: "进位逻辑应该怎么连接？" },
      { id: "a", type: "assistant", text: "请结合真值表检查进位。" },
    ],
  });
  return { roster, grading, snapshot };
}

test("40 students and 10 lessons retain every score and per-lesson result within the whole-class budget", () => {
  const f = fixture(40, 10);
  const result = analysisInput(
    { task: "数字电路课堂", rubric: "按关卡评测计分" },
    "分析全班",
    f.roster,
    f.snapshot,
    false,
    "fixture",
    f.grading,
  );
  const payload = JSON.parse(result.messages[1].content);
  assert.ok(JSON.stringify(result.messages).length <= 24000);
  assert.ok(payload.assessment, "large grading evidence must not disappear");
  assert.equal(result.includedStudents, 40);
  assert.equal(payload.assessment.students.length, 40);
  for (const expected of f.grading.students) {
    const row = payload.assessment.students.find(
      (s: any) => s.studentId === expected.studentId,
    );
    assert.ok(row, expected.studentId);
    assert.equal(
      row.total,
      expected.lessons.reduce((n, c) => n + (c.passed ? c.points : 0), 0),
    );
    assert.equal(
      (row.lessons || row.results).length,
      10,
      "compact format must retain each lesson result",
    );
    expected.lessons.forEach((lesson, index) => {
      if (row.results) {
        const cell = Object.fromEntries(
          payload.assessment.resultColumns.map((column: string, n: number) => [
            column,
            row.results[index][n],
          ]),
        );
        assert.equal(cell.score, lesson.passed ? lesson.points : 0);
        assert.equal(cell.attempts, lesson.attempts);
        assert.equal(cell.lastPassedTests, lesson.lastPassed);
        assert.equal(cell.lastTotalTests, lesson.total);
        assert.equal(
          payload.assessment.statusCodes[cell.status],
          lesson.passed
            ? "通过"
            : {
                failed: "未通过",
                queued: "排队中",
                running: "评测中",
                error: "评测错误",
              }[lesson.lastStatus!] || "未提交",
        );
      } else {
        assert.equal(
          row.lessons[index].score,
          lesson.passed ? lesson.points : 0,
        );
        assert.equal(row.lessons[index].attempts, lesson.attempts);
      }
    });
  }
});

test("large classes retain scoped score summaries and explicitly report omitted students and lesson details", () => {
  const f = fixture(500, 40);
  const result = analysisInput(
    { task: "组合逻辑实验", rubric: "全部用例通过得分" },
    "分析全班",
    f.roster,
    f.snapshot,
    false,
    "fixture",
    f.grading,
  );
  const payload = JSON.parse(result.messages[1].content);
  assert.ok(JSON.stringify(result.messages).length <= 24000);
  assert.ok(
    payload.assessment?.students.length > 0,
    "retain scores even when lesson details do not fit",
  );
  assert.ok(result.truncated);
  assert.equal(
    payload.assessment.omittedStudents,
    500 - payload.assessment.students.length,
  );
  assert.equal(
    payload.assessment.omittedLessons,
    40 - payload.assessment.lessons.length,
  );
  const included = new Set(payload.students.map((s: any) => s.studentId));
  for (const row of payload.assessment.students) {
    assert.ok(
      included.has(row.studentId),
      "scores and learning records must cover the same students",
    );
    const original = f.grading.students.find(
      (s) => s.studentId === row.studentId,
    )!;
    assert.equal(
      row.total,
      original.lessons.reduce((n, c) => n + (c.passed ? c.points : 0), 0),
    );
  }
  assert.equal(
    payload.assessment.students[0].total,
    1000,
    "totals include lessons beyond the displayed catalogue",
  );
  f.grading.students.at(-1)!.lessons[0].attempts++;
  const changed = analysisInput(
    { task: "组合逻辑实验", rubric: "全部用例通过得分" },
    "分析全班",
    f.roster,
    f.snapshot,
    false,
    "fixture",
    f.grading,
  );
  assert.deepEqual(
    changed.messages,
    result.messages,
    "omitted details do not expand the model prompt",
  );
  assert.notEqual(
    changed.sourceHash,
    result.sourceHash,
    "a change to scoped but summarized grading evidence invalidates the cached report",
  );
});

test("escaped classroom text also respects the individual-analysis budget", () => {
  const f = fixture(1, 10);
  const result = analysisInput(
    { task: '"\\'.repeat(2000), rubric: '"'.repeat(1500) },
    '"'.repeat(2000),
    f.roster,
    f.snapshot,
    true,
    "fixture",
    f.grading,
  );
  assert.ok(JSON.stringify(result.messages).length <= 14000);
  assert.ok(result.truncated);
});
