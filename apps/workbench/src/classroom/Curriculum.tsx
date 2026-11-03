import { Button, Table, TextField } from "@radix-ui/themes";
import { Select } from "../shared/Select";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  Download,
  Send,
  Plus,
  CheckCircle,
  Play,
  RefreshCw,
} from "lucide-react";
import { classroomRequest, type ClassroomSession } from "./client";
import { useWorkbench } from "../app/provider";
import { useView, useDocuments, useFiles } from "../app/hooks";
import { command, savePath, desktop } from "../shared/transport";
import type { Document } from "../shared/types";
import type { Classroom } from "../../../../packages/classroom/src/types";
import type {
  Chapter,
  Lesson,
  AssessmentAttempt,
} from "../../../../packages/classroom/src/assessment-types";
import { LessonEditor, LessonMarkdown } from "./LessonEditor";
import { lessonKey, attemptStatus, draftLesson } from "./assessment-utils";
import "./Assessment.css";

type Progress = {
  lessons: { id: string; title: string; version: number; points: number }[];
  students: {
    id: string;
    name: string;
    student_no: string;
    lessons: {
      lessonId: string;
      passed: boolean;
      attempts: number;
      lastStatus: string | null;
      lastPassed: number;
      total: number;
    }[];
  }[];
};
export function Curriculum({
  session,
  classroom,
  onOpen,
  onUnauthorized,
  onBind,
}: {
  session: ClassroomSession;
  classroom: Classroom;
  onOpen: () => void;
  onUnauthorized: () => void;
  onBind: () => Promise<void>;
}) {
  const workbench = useWorkbench(),
    { doc } = useView(),
    docs = useDocuments((s) => s.docs),
    folder = useFiles((s) => s.folder);
  const teacher = session.user.role === "teacher",
    base = `/classrooms/${classroom.id}`,
    storage = lessonKey(session.server, session.user.id, classroom.id);
  const [chapters, setChapters] = useState<Chapter[]>([]),
    [available, setAvailable] = useState(false),
    [selected, setSelected] = useState(
      () => localStorage.getItem(storage + ":selected") || "",
    ),
    [lesson, setLesson] = useState<Lesson | null>(null),
    [editing, setEditing] = useState<Lesson | null>(null),
    [chapterForm, setChapterForm] = useState<{
      id?: string;
      title: string;
      description: string;
      position: number;
    } | null>(null),
    [progress, setProgress] = useState<Progress | null>(null);
  const [attempts, setAttempts] = useState<AssessmentAttempt[]>([]),
    [attempt, setAttempt] = useState<AssessmentAttempt | null>(null),
    [more, setMore] = useState(false),
    [target, setTarget] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [studentFilter, setStudentFilter] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [report, setReport] = useState(false);
  const alive = useRef(true),
    controller = useRef(new AbortController()),
    pending = useRef(false),
    lessonRequest = useRef(0),
    polling = useRef(false),
    submission = useRef<{ key: string; clientId: string } | null>(null);
  const api = <T,>(path: string, method = "GET", body?: unknown) =>
    classroomRequest<T>(
      session,
      base + path,
      method,
      body,
      controller.current.signal,
    );
  const run = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (alive.current) {
        if ((e as { status?: number }).status === 401) onUnauthorized();
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const refresh = async () => {
    const data = await api<{ chapters: Chapter[]; gradingAvailable: boolean }>(
      "/curriculum",
    );
    if (alive.current) {
      setChapters(data.chapters);
      setAvailable(data.gradingAvailable);
    }
  };
  const history = async (id: string, append = false) => {
    const data = await api<{ attempts: AssessmentAttempt[]; hasMore: boolean }>(
      `/lessons/${id}/attempts?offset=${append ? attempts.length : 0}${studentFilter ? "&studentId=" + encodeURIComponent(studentFilter.id) : ""}`,
    );
    if (alive.current && id === selected) {
      setAttempts((old) =>
        append ? [...old, ...data.attempts] : data.attempts,
      );
      setMore(data.hasMore);
      if (!append) setAttempt(data.attempts[0] || null);
    }
  };
  useEffect(() => {
    // A per-run flag keeps the aborted first request of a strict-mode remount
    // from reporting an error or ending loading for the fresh run.
    let current = true;
    alive.current = true;
    const abort = new AbortController();
    controller.current = abort;
    void refresh()
      .catch((e) => {
        if (current && alive.current)
          setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (current && alive.current) setLoading(false);
      });
    return () => {
      current = false;
      alive.current = false;
      abort.abort();
    };
  }, [session, classroom.id]);
  useEffect(() => {
    if (!selected) {
      setLesson(null);
      setAttempts([]);
      setAttempt(null);
      return;
    }
    const generation = ++lessonRequest.current;
    setLesson(null);
    setAttempts([]);
    setAttempt(null);
    setLoading(true);
    void (async () => {
      const [data, h] = await Promise.all([
        api<{ lesson: Lesson }>(`/lessons/${selected}`),
        api<{ attempts: AssessmentAttempt[]; hasMore: boolean }>(
          `/lessons/${selected}/attempts${studentFilter ? "?studentId=" + encodeURIComponent(studentFilter.id) : ""}`,
        ),
      ]);
      if (!alive.current || generation !== lessonRequest.current) return;
      setLesson(data.lesson);
      setAttempts(h.attempts);
      setMore(h.hasMore);
      setAttempt(h.attempts[0] || null);
      let remembered = "";
      try {
        remembered =
          JSON.parse(localStorage.getItem(storage + ":" + selected) || "null")
            ?.documentId || "";
      } catch {}
      setTarget(docs.find((d) => d.id === remembered)?.id || doc?.id || "");
    })()
      .catch((e) => {
        if (alive.current && generation === lessonRequest.current)
          setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive.current && generation === lessonRequest.current)
          setLoading(false);
      });
  }, [selected, classroom.id, studentFilter?.id]);
  useEffect(() => {
    if (!attempt || !["queued", "running"].includes(attempt.status)) return;
    const id = attempt.id;
    const timer = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void api<{ attempt: AssessmentAttempt }>(`/attempts/${id}`)
        .then(async (data) => {
          if (!alive.current) return;
          setAttempt((current) =>
            current?.id === id ? data.attempt : current,
          );
          setAttempts((old) =>
            old.map((a) => (a.id === id ? data.attempt : a)),
          );
          if (!["queued", "running"].includes(data.attempt.status))
            await refresh();
        })
        .catch((e) => {
          if (alive.current)
            setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          polling.current = false;
        });
    }, 1000);
    return () => clearInterval(timer);
  }, [attempt?.id, attempt?.status]);
  const choose = (
    id: string,
    student: { id: string; name: string } | null = null,
  ) => {
    setStudentFilter(student);
    setProgress(null);
    setError("");
    setNotice("");
    setSelected(id);
    localStorage.setItem(storage + ":selected", id);
  };
  const importCopy = async (xml: string, name: string) => {
    const opened = await command<Document>({ op: "import", name, xml });
    workbench.actions.workspace.showDocument(opened);
    onOpen();
    return opened;
  };
  const openTemplate = async () => {
    if (!lesson) return;
    const safeTitle = lesson.title
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .slice(0, 45),
      name = `关卡-${safeTitle}-${crypto.randomUUID().slice(0, 6)}.circ`;
    // The host reports Windows folders with a verbatim `\\?\` prefix, where a
    // forward slash is an invalid name (os error 123); join with its own separator.
    const destination = folder
      ? folder.path.replace(/[\\/]+$/, "") +
        (folder.path.includes("\\") ? "\\" : "/") +
        name
      : desktop()
        ? await savePath(name)
        : null;
    if (desktop() && !destination) return;
    let opened = await command<Document>({
      op: "import",
      name,
      xml: lesson.templateXml,
    });
    try {
      if (destination) {
        const existing = await command<{ revision: string | null }>({
          op: "saveTarget",
          path: destination,
        });
        if (existing.revision) throw Error("目标文件已存在，请选择新文件名");
        opened = await command<Document>({
          op: "save",
          id: opened.id,
          revision: opened.revision,
          path: destination,
        });
      } else {
        const url = URL.createObjectURL(
            new Blob([lesson.templateXml], { type: "application/xml" }),
          ),
          a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      await command({
        op: "close",
        id: opened.id,
        revision: opened.revision,
        discard: true,
      }).catch(() => {});
      throw e;
    }
    workbench.actions.workspace.showDocument(opened);
    workbench.stores.files.getState().refreshTree();
    localStorage.setItem(
      storage + ":" + lesson.id,
      JSON.stringify({
        documentId: opened.id,
        path: opened.path,
        version: lesson.version,
      }),
    );
    if (!folder && destination) {
      const dir = destination.replace(/[\\/][^\\/]+$/, "");
      await workbench.actions.workspace.openFolderAt(dir);
    }
    await onBind();
    setTarget(opened.id);
    onOpen();
  };
  const submit = async () => {
    if (!lesson) return;
    const chosen = docs.find((d) => d.id === target);
    if (!chosen) throw Error("请先打开或选择要提交的电路");
    const current = await command<Document>({ op: "read", id: chosen.id });
    const source = await command<{ xml: string }>({
      op: "source",
      id: current.id,
      revision: current.revision,
    });
    const key = [lesson.id, lesson.version, current.id, current.revision].join(
      ":",
    );
    if (submission.current?.key !== key)
      submission.current = { key, clientId: crypto.randomUUID() };
    const result = await api<{ attempt: AssessmentAttempt }>(
      `/lessons/${lesson.id}/attempts`,
      "POST",
      {
        version: lesson.version,
        name: current.name,
        xml: source.xml,
        clientId: submission.current.clientId,
      },
    );
    submission.current = null;
    if (alive.current) {
      setAttempt(result.attempt);
      setAttempts((old) => [
        result.attempt,
        ...old.filter((a) => a.id !== result.attempt.id),
      ]);
      setNotice("已提交，评测完成后自动更新结果。");
    }
  };
  const preview = async (file: File | undefined) => {
    if (!file || !lesson) return;
    if (file.size > 4 * 1024 * 1024) throw Error("电路不能超过4MB");
    const answer = await api<{
      rows: {
        oscillating: boolean;
        outputs: Record<string, { value?: number }>;
      }[];
    }>(`/lessons/${lesson.id}/preview`, "POST", { xml: await file.text() });
    const passed = lesson.tests.filter(
      (t, i) =>
        !answer.rows[i].oscillating &&
        Object.entries(t.expected).every(
          ([key, value]) => answer.rows[i].outputs[key]?.value === value,
        ),
    ).length;
    setNotice(
      `参考电路试评：${passed} / ${lesson.tests.length} 组通过${passed === lesson.tests.length ? "，用例与参考答案一致。" : "，请检查用例或参考电路。"}`,
    );
  };
  const selectAttempt = async (id: string) => {
    const d = await api<{ attempt: AssessmentAttempt }>(`/attempts/${id}`);
    if (alive.current) setAttempt(d.attempt);
  };
  // A lesson's points are earned only by passing every case at the current
  // grading version; anything else scores zero.
  const earned = (lessons: Progress["students"][number]["lessons"]) =>
    lessons.map((p) =>
      p.passed
        ? progress?.lessons.find((l) => l.id === p.lessonId)?.points || 0
        : 0,
    );
  const total = (lessons: Progress["students"][number]["lessons"]) =>
    earned(lessons).reduce((a, b) => a + b, 0);
  const reportCsv = () => {
    if (!progress) return "";
    const q = (v: string) => `"${v.replaceAll('"', '""')}"`;
    const head = [
      "学生",
      "学号",
      ...progress.lessons.map((l) => `${l.title}（${l.points}分）`),
      "总分",
    ];
    const rows = progress.students.map((s) => [
      s.name,
      s.student_no,
      ...earned(s.lessons).map(String),
      String(total(s.lessons)),
    ]);
    // A BOM keeps Chinese columns readable when pasted into Excel.
    return "﻿" + [head, ...rows].map((r) => r.map(q).join(",")).join("\r\n");
  };
  return (
    <section className="assessment-root" aria-label="章节与关卡评测">
      {error && (
        <p className="classroom-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="classroom-notice" role="status">
          {notice}
        </p>
      )}
      {!available && !loading && (
        <p className="assessment-service-note">
          评测服务尚未配置，可以查看关卡，暂不能提交评测。
        </p>
      )}
      {editing ? (
        <LessonEditor
          initial={editing}
          chapters={chapters}
          onCancel={() => setEditing(null)}
          onSave={async (value) => {
            const data = await api<{ lesson: Lesson }>(
              `/lessons${value.id ? "/" + value.id : ""}`,
              value.id ? "PATCH" : "POST",
              value,
            );
            if (!alive.current) return;
            setEditing(null);
            await refresh();
            if (selected === data.lesson.id) setLesson(data.lesson);
            else choose(data.lesson.id);
            setNotice("关卡已保存。");
          }}
        />
      ) : progress ? (
        <>
          <div className="assessment-heading">
            <Button
              variant="soft"
              color="gray"
              onClick={() => setProgress(null)}
            >
              <ChevronLeft size={15} />
              返回关卡
            </Button>
            <h3>学生闯关情况</h3>
            <div>
              <Button
                variant="soft"
                color="gray"
                onClick={() => setReport(!report)}
              >
                {report ? "收起成绩单" : "生成成绩单"}
              </Button>
              <Button
                variant="soft"
                color="gray"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setProgress(await api<Progress>("/curriculum", "POST", {})),
                  )
                }
              >
                <RefreshCw size={14} />
                刷新
              </Button>
            </div>
          </div>
          <div className="lesson-table-scroll">
            <Table.Root className="assessment-table">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>学生</Table.ColumnHeaderCell>
                  {progress.lessons.map((l) => (
                    <Table.ColumnHeaderCell key={l.id}>
                      {l.title}
                      <small>{l.points} 分</small>
                    </Table.ColumnHeaderCell>
                  ))}
                  <Table.ColumnHeaderCell>总分</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {progress.students.map((student) => (
                  <Table.Row key={student.id}>
                    <Table.ColumnHeaderCell>
                      {student.name}
                      <small>{student.student_no}</small>
                    </Table.ColumnHeaderCell>
                    {student.lessons.map((p) => (
                      <Table.Cell key={p.lessonId}>
                        <Button
                          variant="soft"
                          color="gray"
                          className={p.passed ? "assessment-passed" : ""}
                          onClick={() =>
                            choose(p.lessonId, {
                              id: student.id,
                              name: student.name,
                            })
                          }
                        >
                          {p.passed
                            ? "已通过"
                            : p.lastStatus
                              ? attemptStatus(p.lastStatus)
                              : "未提交"}
                        </Button>
                        <small>
                          {p.passed
                            ? `${progress.lessons.find((l) => l.id === p.lessonId)?.points || 0} 分 · `
                            : ""}
                          {p.attempts} 次提交
                        </small>
                      </Table.Cell>
                    ))}
                    <Table.Cell className="assessment-total">
                      {total(student.lessons)}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </div>
          {!progress.students.length && (
            <p className="assessment-empty">
              学生加入课堂后，这里会展示每个关卡的完成情况。
            </p>
          )}
          {report && progress.students.length > 0 && (
            <section className="assessment-report" aria-label="成绩单">
              <div className="assessment-heading">
                <h4>成绩单</h4>
                <Button
                  variant="soft"
                  color="gray"
                  onClick={() =>
                    void run(async () => {
                      if (navigator.clipboard) {
                        await navigator.clipboard.writeText(reportCsv());
                        setNotice("成绩单已复制为 CSV，可直接粘贴到表格软件。");
                      } else {
                        setNotice(
                          "当前环境不支持剪贴板，请按下方内容手动复制。",
                        );
                      }
                    })
                  }
                >
                  复制 CSV
                </Button>
              </div>
              <pre className="assessment-report-csv">{reportCsv()}</pre>
              <p className="assessment-help">
                计分规则：某关卡在当前测试版本下全部用例（含隐藏用例）通过才获得该关分值，未通过或未提交记
                0 分；修改关卡分值不影响已通过记录。
              </p>
            </section>
          )}
        </>
      ) : selected && lesson ? (
        <>
          <div className="assessment-heading">
            <Button variant="soft" color="gray" onClick={() => choose("")}>
              <ChevronLeft size={15} />
              章节目录
            </Button>
            <div>
              {teacher && (
                <Button
                  variant="soft"
                  color="gray"
                  disabled={busy || classroom.archived}
                  onClick={() => setEditing(lesson)}
                >
                  编辑关卡
                </Button>
              )}
              <span className="assessment-state">
                {lesson.published ? "已发布" : "草稿"}
              </span>
            </div>
          </div>
          <div className="lesson-title">
            <h3>{lesson.title}</h3>
            <p>
              {lesson.testCount} 组用例，其中 {lesson.hiddenCount} 组隐藏 · 分值{" "}
              {lesson.points} 分{!teacher && "（全部用例通过才得分）"}
            </p>
          </div>
          <LessonMarkdown lesson={lesson} />
          <div className="lesson-actions">
            <div>
              <strong>初始模板</strong>
              <span>{lesson.templateName}</span>
            </div>
            <Button
              variant="soft"
              color="gray"
              disabled={busy}
              onClick={() => void run(openTemplate)}
            >
              <Download size={15} />
              {teacher ? "打开模板副本" : "下载模板并打开"}
            </Button>
            {teacher && (
              <label className="assessment-upload">
                {busy ? "试评中…" : "上传参考电路试评"}
                <input
                  aria-label="参考电路试评"
                  type="file"
                  accept=".circ"
                  disabled={busy || !available}
                  onChange={(e) => {
                    void run(() => preview(e.target.files?.[0]));
                    e.currentTarget.value = "";
                  }}
                />
              </label>
            )}
          </div>
          {!teacher && (
            <div className="lesson-submit">
              <label>
                要提交的电路
                <Select
                  label="要提交的电路"
                  value={target}
                  onChange={setTarget}
                  placeholder="请选择已打开的电路"
                  options={docs.map((d) => ({
                    value: d.id,
                    label: d.name + (d.id === doc?.id ? "（当前）" : ""),
                  }))}
                />
              </label>
              <Button
                variant="solid"
                disabled={
                  busy ||
                  !available ||
                  !target ||
                  classroom.archived ||
                  (!!attempt && ["queued", "running"].includes(attempt.status))
                }
                onClick={() => void run(submit)}
              >
                <Send size={15} />
                提交关卡评测
              </Button>
            </div>
          )}
          <details className="lesson-public-cases" open>
            <summary>
              {teacher ? "测试用例" : "公开测试用例"}（{lesson.tests.length}）
            </summary>
            <div className="lesson-table-scroll">
              <Table.Root className="assessment-table">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>用例</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>输入</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>预期输出</Table.ColumnHeaderCell>
                    {teacher && (
                      <Table.ColumnHeaderCell>可见性</Table.ColumnHeaderCell>
                    )}
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {lesson.tests.map((t) => (
                    <Table.Row key={t.id}>
                      <Table.ColumnHeaderCell>{t.title}</Table.ColumnHeaderCell>
                      <Table.Cell>
                        {Object.entries(t.inputs)
                          .map(([k, v]) => `${k}=${v}`)
                          .join("，")}
                      </Table.Cell>
                      <Table.Cell>
                        {Object.entries(t.expected)
                          .map(([k, v]) => `${k}=${v}`)
                          .join("，")}
                      </Table.Cell>
                      {teacher && (
                        <Table.Cell>{t.hidden ? "隐藏" : "公开"}</Table.Cell>
                      )}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </div>
            {!lesson.tests.length && (
              <p>教师未设置公开用例，提交后可查看通过情况。</p>
            )}
          </details>
          {attempt && (
            <>
              {attempt.lessonVersion !== lesson.gradingVersion && (
                <p className="assessment-service-note">
                  此提交对应测试版本 {attempt.lessonVersion}，当前测试版本为{" "}
                  {lesson.gradingVersion}，请重新提交以验证新用例。
                </p>
              )}
              <AttemptResult
                attempt={attempt}
                teacher={teacher}
                onOpen={() =>
                  void run(async () => {
                    const data = await api<{
                      attempt: AssessmentAttempt & { xml: string };
                    }>(`/attempts/${attempt.id}/source`);
                    await importCopy(
                      data.attempt.xml,
                      `提交副本-${data.attempt.name}`,
                    );
                  })
                }
              />
            </>
          )}
          <div className="assessment-heading">
            <h4>
              {teacher
                ? studentFilter
                  ? `${studentFilter.name}的提交记录`
                  : "学生提交记录"
                : "我的提交记录"}
            </h4>
            <Button
              variant="soft"
              color="gray"
              disabled={busy}
              onClick={() => void run(() => history(lesson.id))}
            >
              <RefreshCw size={14} />
              刷新记录
            </Button>
          </div>
          {attempts.length ? (
            <div className="lesson-table-scroll">
              <Table.Root className="assessment-table">
                <Table.Header>
                  <Table.Row>
                    {teacher && (
                      <Table.ColumnHeaderCell>学生</Table.ColumnHeaderCell>
                    )}
                    <Table.ColumnHeaderCell>文件</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>时间</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>结果</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell></Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {attempts.map((a) => (
                    <Table.Row key={a.id}>
                      {teacher && (
                        <Table.Cell>
                          {a.studentName}
                          <small>{a.studentNo}</small>
                        </Table.Cell>
                      )}
                      <Table.Cell>{a.name}</Table.Cell>
                      <Table.Cell>
                        {new Date(a.createdAt).toLocaleString()}
                      </Table.Cell>
                      <Table.Cell>
                        <span
                          className={"assessment-status status-" + a.status}
                        >
                          {attemptStatus(a.status)} {a.passed}/{a.total}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Button
                          variant="soft"
                          color="gray"
                          disabled={busy}
                          onClick={() => void run(() => selectAttempt(a.id))}
                        >
                          查看结果
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </div>
          ) : (
            <p className="assessment-empty">还没有提交记录。</p>
          )}
          {more && (
            <Button
              variant="soft"
              color="gray"
              disabled={busy}
              onClick={() => void run(() => history(lesson.id, true))}
            >
              加载更多提交
            </Button>
          )}
        </>
      ) : (
        <>
          <div className="assessment-heading">
            <div>
              <h3>
                <BookOpen size={19} />
                章节与关卡
              </h3>
              <p>完成电路后提交，系统逐组比对输出。</p>
            </div>
            <div>
              {teacher && (
                <>
                  <Button
                    variant="soft"
                    color="gray"
                    disabled={busy}
                    onClick={() =>
                      void run(async () =>
                        setProgress(
                          await api<Progress>("/curriculum", "POST", {}),
                        ),
                      )
                    }
                  >
                    学生闯关情况
                  </Button>
                  <Button
                    variant="soft"
                    color="gray"
                    disabled={busy || classroom.archived}
                    onClick={() =>
                      setChapterForm({
                        title: "",
                        description: "",
                        position: chapters.length,
                      })
                    }
                  >
                    <Plus size={15} />
                    新增章节
                  </Button>
                </>
              )}
              <Button
                variant="soft"
                color="gray"
                disabled={busy}
                onClick={() => void run(refresh)}
              >
                <RefreshCw size={14} />
                刷新
              </Button>
            </div>
          </div>
          {chapterForm && (
            <form
              className="assessment-chapter-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api(
                    `/chapters${chapterForm.id ? "/" + chapterForm.id : ""}`,
                    chapterForm.id ? "PATCH" : "POST",
                    chapterForm,
                  );
                  setChapterForm(null);
                  await refresh();
                });
              }}
            >
              <label>
                章节名称
                <TextField.Root
                  value={chapterForm.title}
                  required
                  maxLength={100}
                  onChange={(e) =>
                    setChapterForm({ ...chapterForm, title: e.target.value })
                  }
                />
              </label>
              <label>
                章节说明
                <TextField.Root
                  value={chapterForm.description}
                  maxLength={2000}
                  onChange={(e) =>
                    setChapterForm({
                      ...chapterForm,
                      description: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                排序
                <TextField.Root
                  type="number"
                  min={0}
                  max={10000}
                  value={chapterForm.position}
                  onChange={(e) =>
                    setChapterForm({
                      ...chapterForm,
                      position: Number(e.target.value),
                    })
                  }
                />
              </label>
              <div>
                <Button
                  variant="soft"
                  color="gray"
                  type="button"
                  onClick={() => setChapterForm(null)}
                >
                  取消
                </Button>
                <Button variant="solid" disabled={busy} type="submit">
                  保存章节
                </Button>
              </div>
            </form>
          )}
          {loading ? (
            <p className="assessment-empty">正在读取章节…</p>
          ) : chapters.length ? (
            chapters.map((chapter, i) => (
              <section className="assessment-chapter" key={chapter.id}>
                <div className="assessment-chapter-heading">
                  <div>
                    <span>第 {i + 1} 章</span>
                    <h4>{chapter.title}</h4>
                    {chapter.description && <p>{chapter.description}</p>}
                  </div>
                  {teacher && (
                    <div>
                      <Button
                        variant="soft"
                        color="gray"
                        disabled={busy || classroom.archived}
                        onClick={() =>
                          setChapterForm({
                            id: chapter.id,
                            title: chapter.title,
                            description: chapter.description,
                            position: chapter.position,
                          })
                        }
                      >
                        编辑章节
                      </Button>
                      <Button
                        variant="soft"
                        color="gray"
                        disabled={busy || classroom.archived}
                        onClick={() => setEditing(draftLesson(chapter.id))}
                      >
                        <Plus size={14} />
                        新增关卡
                      </Button>
                    </div>
                  )}
                </div>
                <ol className="assessment-lessons">
                  {chapter.lessons.map((l) => (
                    <li key={l.id}>
                      <Button
                        variant="soft"
                        color="gray"
                        onClick={() => choose(l.id)}
                      >
                        <span className="assessment-lesson-icon">
                          {l.passed ? (
                            <CheckCircle size={19} />
                          ) : (
                            <Play size={17} />
                          )}
                        </span>
                        <span>
                          <strong>{l.title}</strong>
                          <small>
                            {l.testCount} 组用例
                            {l.hiddenCount
                              ? ` · ${l.hiddenCount} 组隐藏`
                              : ""}{" "}
                            · {l.points} 分
                          </small>
                        </span>
                        <span className="assessment-lesson-tag">
                          {teacher
                            ? l.published
                              ? "已发布"
                              : "草稿"
                            : l.passed
                              ? "已通过"
                              : l.attempts
                                ? "已尝试"
                                : "待完成"}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ol>
                {!chapter.lessons.length && (
                  <p className="assessment-empty">
                    {teacher
                      ? "添加第一个关卡，并设置说明、模板与测试用例。"
                      : "本章节还没有已发布的关卡。"}
                  </p>
                )}
              </section>
            ))
          ) : (
            <div className="assessment-empty">
              <BookOpen size={32} />
              <h4>{teacher ? "发布你的第一个章节" : "等待教师发布关卡"}</h4>
              <p>
                {teacher
                  ? "每个关卡可以配置图文说明、circ模板及公开或隐藏测试用例。"
                  : "关卡发布后，可以在这里打开模板、提交电路并查看评测结果。"}
              </p>
            </div>
          )}
        </>
      )}
      {selected && !lesson && !editing && !progress && (
        <p className="assessment-empty">
          {loading ? (
            "正在读取关卡…"
          ) : (
            <Button variant="soft" color="gray" onClick={() => choose("")}>
              返回章节目录
            </Button>
          )}
        </p>
      )}
    </section>
  );
}
function AttemptResult({
  attempt,
  teacher,
  onOpen,
}: {
  attempt: AssessmentAttempt;
  teacher: boolean;
  onOpen: () => void;
}) {
  return (
    <section
      className={"assessment-result status-" + attempt.status}
      aria-label="关卡评测结果"
    >
      <div className="assessment-heading">
        <h4>
          {attemptStatus(attempt.status)}
          <span>
            {attempt.passed} / {attempt.total}
          </span>
        </h4>
        <Button variant="soft" color="gray" onClick={onOpen}>
          打开提交电路副本
        </Button>
      </div>
      <p>
        {["queued", "running"].includes(attempt.status)
          ? "评测结果将自动更新。"
          : attempt.message || `提交文件：${attempt.name}`}
      </p>
      <ul>
        {attempt.result.map((r) => (
          <li key={r.id}>
            <details open={!r.passed && (!r.hidden || teacher)}>
              <summary>
                <span
                  className={
                    r.passed ? "assessment-passed" : "assessment-failed"
                  }
                >
                  {r.passed ? "✓ 通过" : "× 未通过"}
                </span>
                <strong>{r.title}</strong>
                {r.hidden && <span>隐藏用例</span>}
              </summary>
              {r.inputs && r.expected && (
                <div>
                  <p>
                    输入：
                    {Object.entries(r.inputs)
                      .map(([k, v]) => `${k}=${v}`)
                      .join("，")}
                  </p>
                  <p>
                    预期：
                    {Object.entries(r.expected)
                      .map(([k, v]) => `${k}=${v}`)
                      .join("，")}
                  </p>
                  <p>
                    实际：
                    {Object.entries(r.outputs || {})
                      .map(([k, v]) => `${k}=${v.value ?? v.bits}`)
                      .join("，") || "无输出"}
                    {r.oscillating ? "（检测到振荡）" : ""}
                  </p>
                </div>
              )}
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
