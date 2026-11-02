import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import type { ClassroomUser } from "./types.ts";
import type {
  AssessmentCase,
  LessonImage,
  GradeRunner,
  CaseResult,
} from "./assessment-types.ts";
type Row = Record<string, any>;
export function assessments(
  db: DatabaseSync,
  options: {
    grade?: GradeRunner;
    fail: (status: number, message: string) => never;
    roomFor: (u: ClassroomUser, id: string) => Row;
    body: (req: IncomingMessage) => Promise<any>;
  },
) {
  const { fail } = options;
  db.exec(`CREATE TABLE IF NOT EXISTS assessment_chapters(id TEXT PRIMARY KEY,class_id TEXT NOT NULL REFERENCES classrooms(id),title TEXT NOT NULL,description TEXT NOT NULL,position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assessment_lessons(id TEXT PRIMARY KEY,class_id TEXT NOT NULL REFERENCES classrooms(id),chapter_id TEXT NOT NULL REFERENCES assessment_chapters(id),title TEXT NOT NULL,position INTEGER NOT NULL,published INTEGER NOT NULL,version INTEGER NOT NULL,config TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assessment_attempts(id TEXT PRIMARY KEY,class_id TEXT NOT NULL REFERENCES classrooms(id),lesson_id TEXT NOT NULL REFERENCES assessment_lessons(id),student_id TEXT NOT NULL REFERENCES users(id),lesson_version INTEGER NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,passed INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL,result TEXT NOT NULL DEFAULT '[]',message TEXT NOT NULL DEFAULT '',xml TEXT NOT NULL,config TEXT NOT NULL,client_id TEXT NOT NULL,UNIQUE(class_id,student_id,client_id));
    CREATE INDEX IF NOT EXISTS assessment_attempts_queue ON assessment_attempts(status,created_at);
    CREATE INDEX IF NOT EXISTS assessment_attempts_member ON assessment_attempts(class_id,student_id,lesson_id,lesson_version);`);
  db.exec(
    "UPDATE assessment_attempts SET status='queued',message='' WHERE status='running'",
  );
  const get = (sql: string, ...args: any[]) =>
    db.prepare(sql).get(...args) as Row | undefined;
  const all = (sql: string, ...args: any[]) =>
    db.prepare(sql).all(...args) as Row[];
  const run = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
  const now = () => new Date().toISOString();
  const str = (v: unknown, label: string, max: number, empty = false) => {
    if (typeof v !== "string" || v.length > max || (!empty && !v.trim()))
      return fail(400, label + "无效");
    return v;
  };
  const num = (v: unknown, min: number, max: number) => {
    if (!Number.isInteger(v) || Number(v) < min || Number(v) > max)
      return fail(400, "数值超出范围");
    return Number(v);
  };
  const teacher = (u: ClassroomUser) => {
    if (u.role !== "teacher") fail(403, "需要教师权限");
  };
  const xml = (v: unknown) => {
    const s = str(v, "电路内容", 4 * 1024 * 1024);
    if (
      !/^\s*(?:<\?xml[^>]*>\s*)?<project\b/.test(s) ||
      /<!DOCTYPE|<!ENTITY/i.test(s)
    )
      fail(400, "电路内容无效");
    return s;
  };
  function tests(value: unknown): AssessmentCase[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 256)
      return fail(400, "请设置1–256组测试用例");
    const names = new Set<string>();
    let inputKeys = "",
      outputKeys = "";
    const values = (v: unknown) => {
      if (
        !v ||
        typeof v !== "object" ||
        Array.isArray(v) ||
        Object.keys(v).length < 1 ||
        Object.keys(v).length > 32
      )
        return fail(400, "每组需1–32个具名输入和输出");
      const out: Record<string, number> = Object.create(null);
      for (const [key, n] of Object.entries(v)) {
        str(key, "引脚标签", 80);
        if (["__proto__", "prototype", "constructor"].includes(key))
          fail(400, "引脚标签无效");
        out[key] = num(n, 0, 0xffffffff);
      }
      return out;
    };
    return value.map((t, i) => {
      if (!t || typeof t !== "object") return fail(400, "用例无效");
      const id = t.id ? str(t.id, "用例编号", 80) : randomUUID();
      if (names.has(id)) fail(400, "用例编号重复");
      names.add(id);
      const inputs = values(t.inputs),
        expected = values(t.expected),
        ik = JSON.stringify(Object.keys(inputs).sort()),
        ok = JSON.stringify(Object.keys(expected).sort());
      if (i === 0) {
        inputKeys = ik;
        outputKeys = ok;
      } else if (ik !== inputKeys || ok !== outputKeys)
        fail(400, "所有用例的输入和输出标签必须一致");
      if (typeof t.hidden !== "boolean") fail(400, "请设置用例可见性");
      return {
        id,
        title: str(t.title || `用例 ${i + 1}`, "用例标题", 100),
        hidden: t.hidden,
        inputs,
        expected,
      };
    });
  }
  function images(value: unknown): LessonImage[] {
    if (!Array.isArray(value) || value.length > 6)
      return fail(400, "每个关卡最多上传6张图片");
    let total = 0;
    const ids = new Set();
    return value.map((a) => {
      if (!a || typeof a !== "object") return fail(400, "图片无效");
      const id = str(a.id, "图片编号", 80);
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id))
        fail(400, "图片编号无效");
      ids.add(id);
      const raw = str(a.data, "图片", 2800000),
        match = raw.match(
          /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/]+={0,2})$/,
        );
      if (!match) fail(400, "请使用PNG、JPEG或WebP图片");
      const bytes = Buffer.from(match![2], "base64");
      total += bytes.length;
      if (bytes.length > 2 * 1024 * 1024 || total > 6 * 1024 * 1024)
        fail(413, "单张图片最多2MB，图片合计最多6MB");
      const valid =
        match![1] === "png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : match![1] === "jpeg"
            ? bytes[0] === 255 && bytes[1] === 216
            : bytes.toString("ascii", 0, 4) === "RIFF" &&
              bytes.toString("ascii", 8, 12) === "WEBP";
      if (!valid) fail(400, "图片格式与内容不一致");
      return { id, name: str(a.name, "图片名称", 100), data: raw };
    });
  }
  const lesson = (classId: string, id: string, u: ClassroomUser) => {
    const row = get(
      "SELECT * FROM assessment_lessons WHERE id=? AND class_id=?",
      id,
      classId,
    );
    if (!row || (u.role !== "teacher" && !row.published))
      return fail(404, "关卡不存在或尚未发布");
    return row;
  };
  function presentLesson(row: Row, u: ClassroomUser) {
    const c = JSON.parse(row.config);
    return {
      id: row.id,
      chapterId: row.chapter_id,
      title: row.title,
      position: row.position,
      published: !!row.published,
      version: row.version,
      ...c,
      tests:
        u.role === "teacher"
          ? c.tests
          : c.tests.filter((t: AssessmentCase) => !t.hidden),
      testCount: c.tests.length,
      hiddenCount: c.tests.filter((t: AssessmentCase) => t.hidden).length,
    };
  }
  function presentAttempt(row: Row, u: ClassroomUser, source = false) {
    const result = JSON.parse(row.result) as CaseResult[];
    return {
      id: row.id,
      lessonId: row.lesson_id,
      studentId: row.student_id,
      studentName: row.name_student,
      studentNo: row.student_no,
      lessonVersion: row.lesson_version,
      name: row.name,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      status: row.status,
      passed: row.passed,
      total: row.total,
      message: row.message,
      result: result.map((r) =>
        u.role === "teacher" || !r.hidden
          ? r
          : { id: r.id, title: "隐藏用例", hidden: true, passed: r.passed },
      ),
      ...(source ? { xml: row.xml } : {}),
    };
  }
  let active = false,
    closed = false,
    worker: Promise<void> | null = null;
  async function drain() {
    if (active || closed || !options.grade) return;
    active = true;
    try {
      while (!closed) {
        const job = get(
          "SELECT * FROM assessment_attempts WHERE status='queued' ORDER BY created_at,rowid LIMIT 1",
        );
        if (!job) break;
        run(
          "UPDATE assessment_attempts SET status='running' WHERE id=?",
          job.id,
        );
        try {
          const config = JSON.parse(job.config),
            answer = await options.grade({
              xml: job.xml,
              circuit: config.circuit,
              tests: config.tests,
            });
          if (answer.rows.length !== config.tests.length)
            throw Error("评测返回的用例数量不完整");
          const result: CaseResult[] = config.tests.map(
            (t: AssessmentCase, i: number) => {
              const r = answer.rows[i];
              return {
                id: t.id,
                title: t.title,
                hidden: t.hidden,
                inputs: t.inputs,
                expected: t.expected,
                outputs: r.outputs,
                oscillating: r.oscillating,
                passed:
                  !r.oscillating &&
                  Object.entries(t.expected).every(
                    ([key, n]) => r.outputs[key]?.value === n,
                  ),
              };
            },
          );
          const passed = result.filter((r) => r.passed).length;
          run(
            "UPDATE assessment_attempts SET status=?,passed=?,result=?,finished_at=? WHERE id=?",
            passed === result.length ? "passed" : "failed",
            passed,
            JSON.stringify(result),
            now(),
            job.id,
          );
        } catch (e) {
          run(
            "UPDATE assessment_attempts SET status='error',message=?,finished_at=? WHERE id=?",
            e instanceof Error ? e.message : "评测失败，请稍后重试",
            now(),
            job.id,
          );
        }
      }
    } finally {
      active = false;
    }
  }
  function kick() {
    if (!active && !closed) worker = drain();
  }
  queueMicrotask(kick);
  async function handle(
    req: IncomingMessage,
    route: string,
    method: string | undefined,
    u: ClassroomUser,
    send: (s: number, v: unknown) => void,
  ): Promise<boolean> {
    const match = route.match(
      /^\/api\/classrooms\/([^/]+)\/(curriculum|chapters|lessons|attempts)(?:\/([^/]+))?(?:\/(attempts|source|preview))?$/,
    );
    if (!match) return false;
    const [, cid, kind, id, tail] = match,
      room = options.roomFor(u, cid);
    const writable = () => {
      teacher(u);
      if (room.archived) fail(409, "请先重新开放课堂");
    };
    if (kind === "curriculum" && method === "GET") {
      const chapters = all(
        "SELECT * FROM assessment_chapters WHERE class_id=? ORDER BY position,rowid",
        cid,
      ).map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        position: c.position,
        lessons: all(
          `SELECT * FROM assessment_lessons WHERE chapter_id=? AND class_id=? ${u.role === "teacher" ? "" : "AND published=1"} ORDER BY position,rowid`,
          c.id,
          cid,
        ).map((l) => {
          const config = JSON.parse(l.config),
            progress = get(
              "SELECT count(*) attempts,coalesce(max(status='passed'),0) passed FROM assessment_attempts WHERE lesson_id=? AND student_id=? AND lesson_version=?",
              l.id,
              u.id,
              l.version,
            )!;
          return {
            id: l.id,
            title: l.title,
            position: l.position,
            published: !!l.published,
            version: l.version,
            testCount: config.tests.length,
            hiddenCount: config.tests.filter((t: AssessmentCase) => t.hidden)
              .length,
            passed: !!progress.passed,
            attempts: progress.attempts,
          };
        }),
      }));
      send(200, { chapters, gradingAvailable: !!options.grade });
      return true;
    }
    if (kind === "chapters" && (method === "POST" || method === "PATCH")) {
      writable();
      const b = await options.body(req),
        title = str(b.title, "章节标题", 100),
        description = str(b.description ?? "", "章节说明", 2000, true),
        position = num(b.position ?? 0, 0, 10000);
      if (method === "POST") {
        const chapterId = randomUUID();
        run(
          "INSERT INTO assessment_chapters VALUES(?,?,?,?,?)",
          chapterId,
          cid,
          title,
          description,
          position,
        );
        send(201, { id: chapterId });
      } else {
        if (
          !get(
            "SELECT id FROM assessment_chapters WHERE id=? AND class_id=?",
            id,
            cid,
          )
        )
          fail(404, "章节不存在");
        run(
          "UPDATE assessment_chapters SET title=?,description=?,position=? WHERE id=?",
          title,
          description,
          position,
          id,
        );
        send(200, { ok: true });
      }
      return true;
    }
    if (
      kind === "lessons" &&
      ((method === "POST" && !id) || (method === "PATCH" && id && !tail))
    ) {
      writable();
      const b = await options.body(req);
      const previous = id ? lesson(cid, id, u) : null;
      const chapterId = str(b.chapterId, "章节", 80);
      if (
        !get(
          "SELECT id FROM assessment_chapters WHERE id=? AND class_id=?",
          chapterId,
          cid,
        )
      )
        fail(400, "章节不属于当前课堂");
      const title = str(b.title, "关卡标题", 120),
        description = str(b.description ?? "", "关卡描述", 100000, true),
        circuit = str(b.circuit, "待评测电路名称", 80),
        templateName = str(b.templateName, "模板名称", 120),
        templateXml = xml(b.templateXml),
        imageList = images(b.images ?? []),
        testList = tests(b.tests);
      if (
        !templateName.toLowerCase().endsWith(".circ") ||
        /[\\/]/.test(templateName)
      )
        fail(400, "模板名称必须是circ文件名");
      if (typeof b.published !== "boolean") fail(400, "请设置发布状态");
      const position = num(b.position ?? 0, 0, 10000),
        config = JSON.stringify({
          description,
          circuit,
          templateName,
          templateXml,
          images: imageList,
          tests: testList,
        });
      if (previous) {
        if (b.version !== previous.version)
          fail(409, "关卡已被修改，请重新打开编辑");
        run(
          "UPDATE assessment_lessons SET chapter_id=?,title=?,position=?,published=?,version=version+1,config=?,updated_at=? WHERE id=?",
          chapterId,
          title,
          position,
          Number(b.published),
          config,
          now(),
          id,
        );
        send(200, { lesson: presentLesson(lesson(cid, id!, u), u) });
      } else {
        const lessonId = randomUUID();
        run(
          "INSERT INTO assessment_lessons VALUES(?,?,?,?,?,?,?,?,?)",
          lessonId,
          cid,
          chapterId,
          title,
          position,
          Number(b.published),
          1,
          config,
          now(),
        );
        send(201, { lesson: presentLesson(lesson(cid, lessonId, u), u) });
      }
      return true;
    }
    if (kind === "lessons" && id && method === "GET" && !tail) {
      send(200, { lesson: presentLesson(lesson(cid, id, u), u) });
      return true;
    }
    if (kind === "lessons" && id && tail === "preview" && method === "POST") {
      writable();
      if (!options.grade) fail(503, "评测服务暂不可用");
      if (active) fail(429, "评测正在处理其他提交，请稍后试评");
      const l = lesson(cid, id, u),
        config = JSON.parse(l.config),
        b = await options.body(req);
      const source = xml(b.xml);
      active = true;
      const pending = options.grade!({
        xml: source,
        circuit: config.circuit,
        tests: config.tests,
      });
      worker = pending.then(
        () => {},
        () => {},
      );
      try {
        send(200, { rows: (await pending).rows });
      } finally {
        active = false;
        kick();
      }
      return true;
    }
    if (kind === "lessons" && id && tail === "attempts" && method === "POST") {
      if (u.role !== "student")
        fail(403, "请使用学生账号提交；教师可使用参考电路试评");
      if (room.archived) fail(409, "课堂已关闭，不能提交");
      if (!options.grade) fail(503, "评测服务暂不可用");
      const l = lesson(cid, id, u),
        b = await options.body(req),
        clientId = str(b.clientId, "提交标识", 100);
      const duplicate = get(
        "SELECT * FROM assessment_attempts WHERE class_id=? AND student_id=? AND client_id=?",
        cid,
        u.id,
        clientId,
      );
      if (duplicate) {
        if (duplicate.lesson_id !== id) fail(409, "提交标识已用于其他关卡");
        send(200, { attempt: presentAttempt(duplicate, u) });
        return true;
      }
      if (b.version !== l.version) fail(409, "关卡已更新，请刷新后重新提交");
      if (
        get(
          "SELECT id FROM assessment_attempts WHERE student_id=? AND status IN ('queued','running')",
          u.id,
        )
      )
        fail(409, "已有提交正在评测，请等待完成");
      if (
        Number(
          get(
            "SELECT count(*) n FROM assessment_attempts WHERE status IN ('queued','running')",
          )!.n,
        ) >= 100
      )
        fail(429, "评测队列已满，请稍后重试");
      if (
        get(
          "SELECT id FROM assessment_attempts WHERE student_id=? AND created_at>?",
          u.id,
          new Date(Date.now() - 3000).toISOString(),
        )
      )
        fail(429, "提交过于频繁，请稍候");
      const source = xml(b.xml),
        name = str(b.name, "电路文件名", 160),
        attemptId = randomUUID(),
        config = JSON.parse(l.config);
      run(
        "INSERT INTO assessment_attempts(id,class_id,lesson_id,student_id,lesson_version,name,created_at,status,total,xml,config,client_id) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?)",
        attemptId,
        cid,
        id,
        u.id,
        l.version,
        name,
        now(),
        config.tests.length,
        source,
        l.config,
        clientId,
      );
      send(202, {
        attempt: presentAttempt(
          get("SELECT * FROM assessment_attempts WHERE id=?", attemptId)!,
          u,
        ),
      });
      kick();
      return true;
    }
    if (kind === "lessons" && id && tail === "attempts" && method === "GET") {
      lesson(cid, id, u);
      const offset = num(
        Number(
          new URL(req.url!, "http://local").searchParams.get("offset") || 0,
        ),
        0,
        100000,
      );
      const rows = all(
        `SELECT a.*,u.name name_student,u.student_no FROM assessment_attempts a JOIN users u ON u.id=a.student_id WHERE a.class_id=? AND a.lesson_id=? ${u.role === "teacher" ? "" : "AND a.student_id=?"} ORDER BY a.created_at DESC,a.rowid DESC LIMIT 50 OFFSET ?`,
        cid,
        id,
        ...(u.role === "teacher" ? [] : [u.id]),
        offset,
      );
      send(200, {
        attempts: rows.map((r) => presentAttempt(r, u)),
        offset,
        hasMore: rows.length === 50,
      });
      return true;
    }
    if (kind === "attempts" && id && method === "GET") {
      const row = get(
        "SELECT a.*,u.name name_student,u.student_no FROM assessment_attempts a JOIN users u ON u.id=a.student_id WHERE a.id=? AND a.class_id=?",
        id,
        cid,
      );
      if (!row || (u.role !== "teacher" && row.student_id !== u.id))
        fail(404, "提交记录不存在");
      send(200, { attempt: presentAttempt(row!, u, tail === "source") });
      return true;
    }
    if (kind === "curriculum" && method === "POST") {
      teacher(u);
      const members = all(
        "SELECT u.id,u.name,u.student_no FROM members m JOIN users u ON u.id=m.student_id WHERE m.class_id=? ORDER BY u.student_no",
        cid,
      );
      const lessons = all(
        "SELECT id,title,version FROM assessment_lessons WHERE class_id=? AND published=1 ORDER BY position",
        cid,
      );
      send(200, {
        lessons,
        students: members.map((s) => ({
          ...s,
          lessons: lessons.map((l) => {
            const p = get(
              "SELECT count(*) attempts,coalesce(max(status='passed'),0) passed,max(created_at) lastSubmittedAt FROM assessment_attempts WHERE student_id=? AND lesson_id=? AND lesson_version=?",
              s.id,
              l.id,
              l.version,
            )!;
            const last = get(
              "SELECT status,passed,total FROM assessment_attempts WHERE student_id=? AND lesson_id=? AND lesson_version=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
              s.id,
              l.id,
              l.version,
            );
            return {
              lessonId: l.id,
              ...p,
              passed: !!p.passed,
              lastStatus: last?.status ?? null,
              lastPassed: last?.passed ?? 0,
              total: last?.total ?? 0,
            };
          }),
        })),
      });
      return true;
    }
    return fail(405, "评测接口不支持此操作");
  }
  return {
    handle,
    close: async () => {
      closed = true;
      await worker;
    },
  };
}
