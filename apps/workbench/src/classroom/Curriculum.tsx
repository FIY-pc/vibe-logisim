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
  lessons: { id: string; title: string; version: number }[];
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
    const destination = folder
      ? folder.path.replace(/[\\/]+$/, "") + "/" + name
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
            <button onClick={() => setProgress(null)}>
              <ChevronLeft size={15} />
              返回关卡
            </button>
            <h3>学生闯关情况</h3>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setProgress(await api<Progress>("/curriculum", "POST", {})),
                )
              }
            >
              <RefreshCw size={14} />
              刷新
            </button>
          </div>
          <div className="lesson-table-scroll">
            <table className="assessment-table">
              <thead>
                <tr>
                  <th>学生</th>
                  {progress.lessons.map((l) => (
                    <th key={l.id}>{l.title}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {progress.students.map((student) => (
                  <tr key={student.id}>
                    <th>
                      {student.name}
                      <small>{student.student_no}</small>
                    </th>
                    {student.lessons.map((p) => (
                      <td key={p.lessonId}>
                        <button
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
                        </button>
                        <small>{p.attempts} 次提交</small>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!progress.students.length && (
            <p className="assessment-empty">
              学生加入课堂后，这里会展示每个关卡的完成情况。
            </p>
          )}
        </>
      ) : selected && lesson ? (
        <>
          <div className="assessment-heading">
            <button onClick={() => choose("")}>
              <ChevronLeft size={15} />
              章节目录
            </button>
            <div>
              {teacher && (
                <button
                  disabled={busy || classroom.archived}
                  onClick={() => setEditing(lesson)}
                >
                  编辑关卡
                </button>
              )}
              <span className="assessment-state">
                {lesson.published ? "已发布" : "草稿"}
              </span>
            </div>
          </div>
          <div className="lesson-title">
            <h3>{lesson.title}</h3>
            <p>
              {lesson.testCount} 组用例，其中 {lesson.hiddenCount} 组隐藏
            </p>
          </div>
          <LessonMarkdown lesson={lesson} />
          <div className="lesson-actions">
            <div>
              <strong>初始模板</strong>
              <span>{lesson.templateName}</span>
            </div>
            <button disabled={busy} onClick={() => void run(openTemplate)}>
              <Download size={15} />
              {teacher ? "打开模板副本" : "下载模板并打开"}
            </button>
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
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">请选择已打开的电路</option>
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.id === doc?.id ? "（当前）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary"
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
              </button>
            </div>
          )}
          <details className="lesson-public-cases" open>
            <summary>
              {teacher ? "测试用例" : "公开测试用例"}（{lesson.tests.length}）
            </summary>
            <div className="lesson-table-scroll">
              <table className="assessment-table">
                <thead>
                  <tr>
                    <th>用例</th>
                    <th>输入</th>
                    <th>预期输出</th>
                    {teacher && <th>可见性</th>}
                  </tr>
                </thead>
                <tbody>
                  {lesson.tests.map((t) => (
                    <tr key={t.id}>
                      <th>{t.title}</th>
                      <td>
                        {Object.entries(t.inputs)
                          .map(([k, v]) => `${k}=${v}`)
                          .join("，")}
                      </td>
                      <td>
                        {Object.entries(t.expected)
                          .map(([k, v]) => `${k}=${v}`)
                          .join("，")}
                      </td>
                      {teacher && <td>{t.hidden ? "隐藏" : "公开"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
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
            <button
              disabled={busy}
              onClick={() => void run(() => history(lesson.id))}
            >
              <RefreshCw size={14} />
              刷新记录
            </button>
          </div>
          {attempts.length ? (
            <div className="lesson-table-scroll">
              <table className="assessment-table">
                <thead>
                  <tr>
                    {teacher && <th>学生</th>}
                    <th>文件</th>
                    <th>时间</th>
                    <th>结果</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.id}>
                      {teacher && (
                        <td>
                          {a.studentName}
                          <small>{a.studentNo}</small>
                        </td>
                      )}
                      <td>{a.name}</td>
                      <td>{new Date(a.createdAt).toLocaleString()}</td>
                      <td>
                        <span
                          className={"assessment-status status-" + a.status}
                        >
                          {attemptStatus(a.status)} {a.passed}/{a.total}
                        </span>
                      </td>
                      <td>
                        <button
                          disabled={busy}
                          onClick={() => void run(() => selectAttempt(a.id))}
                        >
                          查看结果
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="assessment-empty">还没有提交记录。</p>
          )}
          {more && (
            <button
              disabled={busy}
              onClick={() => void run(() => history(lesson.id, true))}
            >
              加载更多提交
            </button>
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
                  <button
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
                  </button>
                  <button
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
                  </button>
                </>
              )}
              <button disabled={busy} onClick={() => void run(refresh)}>
                <RefreshCw size={14} />
                刷新
              </button>
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
                <input
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
                <input
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
                <input
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
                <button type="button" onClick={() => setChapterForm(null)}>
                  取消
                </button>
                <button className="primary" disabled={busy} type="submit">
                  保存章节
                </button>
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
                      <button
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
                      </button>
                      <button
                        disabled={busy || classroom.archived}
                        onClick={() => setEditing(draftLesson(chapter.id))}
                      >
                        <Plus size={14} />
                        新增关卡
                      </button>
                    </div>
                  )}
                </div>
                <ol className="assessment-lessons">
                  {chapter.lessons.map((l) => (
                    <li key={l.id}>
                      <button onClick={() => choose(l.id)}>
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
                            {l.hiddenCount ? ` · ${l.hiddenCount} 组隐藏` : ""}
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
                      </button>
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
            <button onClick={() => choose("")}>返回章节目录</button>
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
        <button onClick={onOpen}>打开提交电路副本</button>
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
