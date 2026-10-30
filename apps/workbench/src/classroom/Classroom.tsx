import { useEffect, useRef, useState } from "react";
import {
  GraduationCap,
  RefreshCw,
  LogOut,
  Send,
  Sparkles,
  Copy,
} from "lucide-react";
import Markdown from "react-markdown";
import { DialogClose, useModal } from "../shared/Dialog";
import { Select } from "../shared/Select";
import { Checkbox } from "../shared/Checkbox";
import { useView } from "../app/hooks";
import {
  classroomRequest,
  serverAddress,
  type ClassroomSession,
} from "./client";
import { prepareWork, type PreparedWork } from "./sharing";
import { useSharing } from "./useSharing";
import type {
  Classroom,
  ClassroomDetail,
  Submission,
  SubmissionSummary,
  AnalysisReport,
} from "../../../../packages/classroom/src/types";
import "./Classroom.css";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const time = (value: string) => new Date(value).toLocaleString();
const sessionKey = "vibe.classroom.session";
function savedSession(): ClassroomSession | null {
  try {
    return JSON.parse(sessionStorage.getItem(sessionKey) || "null");
  } catch {
    return null;
  }
}

/** Separate module and one title-bar entry keep upstream editor/conversation changes small. */
export function ClassroomEntry() {
  const [open, setOpen] = useState(false),
    [session, setSession] = useState<ClassroomSession | null>(savedSession);
  const sharing = useSharing();
  const changeSession = (next: ClassroomSession | null) => {
    sharing.stop();
    setSession(next);
    if (next) sessionStorage.setItem(sessionKey, JSON.stringify(next));
    else sessionStorage.removeItem(sessionKey);
  };
  return (
    <>
      <button
        className={
          sharing.binding ? "classroom-entry sharing" : "classroom-entry"
        }
        onClick={() => setOpen(true)}
        aria-label="课堂管理"
      >
        <GraduationCap size={16} />
        <span>课堂{sharing.binding ? " · 共享中" : ""}</span>
      </button>
      {open && (
        <ClassroomDialog
          session={session}
          onSession={changeSession}
          sharing={sharing}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ClassroomDialog({
  session,
  onSession,
  sharing,
  onClose,
}: {
  session: ClassroomSession | null;
  onSession: (s: ClassroomSession | null) => void;
  sharing: ReturnType<typeof useSharing>;
  onClose: () => void;
}) {
  const modal = useModal();
  const [rooms, setRooms] = useState<Classroom[]>([]),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<ClassroomDetail | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef(false),
    alive = useRef(true),
    controller = useRef(new AbortController());
  useEffect(() => {
    alive.current = true;
    if (controller.current.signal.aborted)
      controller.current = new AbortController();
    return () => {
      alive.current = false;
      controller.current.abort();
    };
  }, []);
  const run = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (alive.current) {
        if ((e as { status?: number })?.status === 401) onSession(null);
        setError(message(e));
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const api = <T,>(path: string, method = "GET", body?: unknown) =>
    classroomRequest<T>(
      session!,
      path,
      method,
      body,
      controller.current.signal,
    );
  const refresh = async (id = selected) => {
    const list = await api<{ classrooms: Classroom[] }>("/classrooms");
    if (!alive.current) return;
    setRooms(list.classrooms);
    const next = id || list.classrooms[0]?.id || "";
    setSelected(next);
    if (next) {
      const data = await api<ClassroomDetail>(`/classrooms/${next}`);
      if (alive.current) setDetail(data);
    } else setDetail(null);
  };
  useEffect(() => {
    const requestController = new AbortController();
    controller.current = requestController;
    let current = true;
    setRooms([]);
    setSelected("");
    setDetail(null);
    setError("");
    if (session) {
      pending.current = true;
      setBusy(true);
      const load = async () => {
        const call = <T,>(path: string) =>
          classroomRequest<T>(
            session,
            path,
            "GET",
            undefined,
            requestController.signal,
          );
        await call("/auth/me");
        const list = await call<{ classrooms: Classroom[] }>("/classrooms");
        const first = list.classrooms[0]?.id || "";
        const data = first
          ? await call<ClassroomDetail>(`/classrooms/${first}`)
          : null;
        if (current) {
          setRooms(list.classrooms);
          setSelected(first);
          setDetail(data);
        }
      };
      void load()
        .catch((e) => {
          if (current) {
            if ((e as { status?: number })?.status === 401) onSession(null);
            setError(message(e));
          }
        })
        .finally(() => {
          if (current) {
            pending.current = false;
            setBusy(false);
          }
        });
    } else {
      pending.current = false;
      setBusy(false);
    }
    return () => {
      current = false;
      requestController.abort();
    };
  }, [session]);
  useEffect(() => {
    if (!session || session.user.role !== "teacher" || !selected) return;
    const timer = setInterval(() => {
      if (!pending.current) void run(() => refresh(selected));
    }, 15000);
    return () => clearInterval(timer);
  }, [session, selected]);
  const choose = (id: string) =>
    void run(async () => {
      setSelected(id);
      setDetail(null);
      const data = await api<ClassroomDetail>(`/classrooms/${id}`);
      if (alive.current) setDetail(data);
    });
  return (
    <dialog
      ref={modal}
      className="classroom-dialog"
      aria-label="课堂管理"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2>
            <GraduationCap size={21} />
            课堂管理
          </h2>
          <p>
            {session
              ? `${session.user.name} · ${session.user.role === "teacher" ? "教师端" : "学生端"}`
              : "连接课堂，与教师共享学习进度"}
          </p>
        </div>
        <DialogClose label="关闭课堂管理" onClick={onClose} />
      </header>
      {error && (
        <p className="classroom-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="classroom-notice">
          {notice}
        </p>
      )}
      {!session ? (
        <Login busy={busy} onLogin={onSession} run={run} />
      ) : (
        <>
          <div className="classroom-session">
            <span>{session.server}</span>
            <button disabled={busy} onClick={() => void run(() => refresh())}>
              <RefreshCw size={14} />
              刷新
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  sharing.stop();
                  try {
                    await api("/auth/logout", "POST", {});
                  } finally {
                    onSession(null);
                  }
                })
              }
            >
              <LogOut size={14} />
              退出登录
            </button>
          </div>
          <div className="classroom-columns">
            <nav aria-label="我的课堂">
              <h3>我的课堂</h3>
              {rooms.map((c) => (
                <button
                  key={c.id}
                  disabled={busy}
                  aria-current={selected === c.id ? "page" : undefined}
                  className={selected === c.id ? "active" : ""}
                  onClick={() => choose(c.id)}
                >
                  <strong>{c.title}</strong>
                  <small>
                    {c.archived
                      ? "已关闭"
                      : `${c.memberCount} 人 · ${c.teacherName}`}
                  </small>
                </button>
              ))}
              {!rooms.length && <p className="muted">尚未加入或创建课堂</p>}
              <ClassForm
                teacher={session.user.role === "teacher"}
                busy={busy}
                onSubmit={(b) =>
                  run(async () => {
                    const result = await api<{ classroom: Classroom }>(
                      session.user.role === "teacher"
                        ? "/classrooms"
                        : "/classrooms/join",
                      "POST",
                      b,
                    );
                    await refresh(result.classroom.id);
                    setNotice(
                      session.user.role === "teacher"
                        ? "课堂已创建，请将课堂码发给学生"
                        : "已加入课堂。预览后可共享选定电路和对话记录。",
                    );
                  })
                }
              />
            </nav>
            <main aria-busy={busy}>
              {detail ? (
                <>
                  <div className="classroom-room-heading">
                    <div>
                      <h3>{detail.classroom.title}</h3>
                      {session.user.role === "teacher" && (
                        <p>
                          课堂码 <code>{detail.classroom.code}</code>{" "}
                          <button
                            className="icon-button"
                            aria-label="复制课堂码"
                            onClick={() =>
                              void run(async () => {
                                await navigator.clipboard.writeText(
                                  detail.classroom.code!,
                                );
                                setNotice("课堂码已复制");
                              })
                            }
                          >
                            <Copy size={14} />
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await api(
                                  `/classrooms/${selected}/code`,
                                  "POST",
                                  {},
                                );
                                await refresh();
                                setNotice(
                                  "课堂码已更新，旧码已失效；已加入的学生和提交记录保留。",
                                );
                              })
                            }
                          >
                            更新课堂码
                          </button>
                        </p>
                      )}
                    </div>
                    {session.user.role === "teacher" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(`/classrooms/${selected}`, "PATCH", {
                              archived: !detail.classroom.archived,
                            });
                            await refresh();
                          })
                        }
                      >
                        {detail.classroom.archived
                          ? "重新开放"
                          : "关闭加入与提交"}
                      </button>
                    )}
                  </div>
                  {detail.classroom.task && (
                    <section className="classroom-task">
                      <h4>课堂任务</h4>
                      <p>{detail.classroom.task}</p>
                      {detail.classroom.rubric && (
                        <>
                          <h4>评价标准</h4>
                          <p>{detail.classroom.rubric}</p>
                        </>
                      )}
                    </section>
                  )}
                  {session.user.role === "teacher" ? (
                    <TeacherRoom
                      key={selected}
                      detail={detail}
                      busy={busy}
                      run={run}
                      api={api}
                      refresh={refresh}
                    />
                  ) : (
                    <StudentRoom
                      key={selected}
                      session={session}
                      detail={detail}
                      busy={busy}
                      run={run}
                      api={api}
                      refresh={refresh}
                      sharing={sharing}
                      notify={setNotice}
                    />
                  )}
                </>
              ) : (
                <div className="classroom-empty">
                  <GraduationCap size={36} />
                  <h3>从一个课堂开始</h3>
                  <p>
                    {session.user.role === "teacher"
                      ? "创建课堂、发布电路任务，然后把课堂码分享给学生。"
                      : "输入教师提供的课堂码。加入后，你可以预览并共享电路及 AI 交互记录。"}
                  </p>
                </div>
              )}
            </main>
          </div>
        </>
      )}
    </dialog>
  );
}

function Login({
  busy,
  onLogin,
  run,
}: {
  busy: boolean;
  onLogin: (s: ClassroomSession) => void;
  run: (w: () => Promise<void>) => Promise<void>;
}) {
  const [register, setRegister] = useState(false),
    [role, setRole] = useState("student");
  return (
    <form
      className="classroom-login"
      onSubmit={(e) => {
        e.preventDefault();
        const b = Object.fromEntries(new FormData(e.currentTarget));
        void run(async () => {
          const server = serverAddress(String(b.server));
          const result = await classroomRequest<
            Omit<ClassroomSession, "server">
          >({ server }, register ? "/auth/register" : "/auth/login", "POST", b);
          localStorage.setItem("vibe.classroom.server", server);
          onLogin({ ...result, server });
        });
      }}
    >
      <h3>{register ? "注册课堂账号" : "登录课堂"}</h3>
      <label>
        课堂服务地址
        <input
          name="server"
          type="url"
          required
          defaultValue={
            localStorage.getItem("vibe.classroom.server") ||
            "http://127.0.0.1:8810"
          }
          placeholder="https://classroom.example.edu"
        />
      </label>
      <label>
        账号
        <input
          name="username"
          required
          maxLength={80}
          autoComplete="username"
        />
      </label>
      <label>
        密码
        <input
          name="password"
          type="password"
          minLength={10}
          maxLength={200}
          required
          autoComplete={register ? "new-password" : "current-password"}
        />
      </label>
      {register && (
        <>
          <label>
            姓名
            <input name="name" required maxLength={80} />
          </label>
          <label>
            角色
            <input type="hidden" name="role" value={role} />
            <Select
              label="角色"
              value={role}
              onChange={setRole}
              options={[
                { value: "student", label: "学生" },
                { value: "teacher", label: "教师" },
              ]}
            />
          </label>
          {role === "student" ? (
            <label>
              学号
              <input name="studentNo" required maxLength={80} />
            </label>
          ) : (
            <label>
              教师邀请码
              <input
                name="teacherCode"
                type="password"
                required
                autoComplete="off"
              />
            </label>
          )}
        </>
      )}
      <button className="primary" disabled={busy}>
        {busy ? "连接中…" : register ? "注册并登录" : "登录"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setRegister((v) => !v)}
      >
        {register ? "已有账号，返回登录" : "注册学生 / 教师账号"}
      </button>
    </form>
  );
}
function ClassForm({
  teacher,
  busy,
  onSubmit,
}: {
  teacher: boolean;
  busy: boolean;
  onSubmit: (body: unknown) => Promise<void>;
}) {
  return (
    <form
      className="classroom-create"
      onSubmit={(e) => {
        e.preventDefault();
        const b = Object.fromEntries(new FormData(e.currentTarget));
        void onSubmit(teacher ? { ...b, capacity: Number(b.capacity) } : b);
      }}
    >
      <h4>{teacher ? "创建课堂" : "加入课堂"}</h4>
      {teacher ? (
        <>
          <label>
            课堂名称
            <input name="title" required maxLength={120} />
          </label>
          <label>
            任务说明
            <textarea name="task" rows={3} maxLength={10000} />
          </label>
          <label>
            评价标准
            <textarea name="rubric" rows={2} maxLength={5000} />
          </label>
          <label>
            人数上限
            <input
              name="capacity"
              type="number"
              min={1}
              max={500}
              defaultValue={100}
              required
            />
          </label>
        </>
      ) : (
        <label>
          课堂码
          <input name="code" required maxLength={40} autoComplete="off" />
        </label>
      )}
      <button disabled={busy} className="primary">
        {teacher ? "创建并生成课堂码" : "加入课堂"}
      </button>
    </form>
  );
}

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Run = (work: () => Promise<void>) => Promise<void>;
function StudentRoom({
  session,
  detail,
  busy,
  run,
  api,
  refresh,
  sharing,
  notify,
}: {
  session: ClassroomSession;
  detail: ClassroomDetail;
  busy: boolean;
  run: Run;
  api: Api;
  refresh: () => Promise<void>;
  sharing: ReturnType<typeof useSharing>;
  notify: (text: string) => void;
}) {
  const { doc } = useView();
  const [prepared, setPrepared] = useState<PreparedWork | null>(null),
    [include, setInclude] = useState(true),
    [auto, setAuto] = useState(false),
    [progress, setProgress] = useState(0),
    [note, setNote] = useState("");
  const latest = detail.members[0]?.latest;
  const submit = (status: "working" | "submitted") =>
    void run(async () => {
      if (!prepared) throw new Error("请先预览共享内容");
      sharing.stop();
      await api(`/classrooms/${detail.classroom.id}/submissions`, "POST", {
        id: crypto.randomUUID(),
        snapshot: { ...prepared.snapshot, status, progress, note },
      });
      if (auto && status === "working")
        sharing.start({
          session,
          classroomId: detail.classroom.id,
          target: prepared.target,
          progress,
          note,
          fingerprint: JSON.stringify({
            ...prepared.snapshot,
            status,
            progress,
            note,
          }),
        });
      else sharing.stop();
      setPrepared(null);
      await refresh();
      notify(
        status === "submitted"
          ? "电路已提交，自动共享已停止"
          : "进度已共享，教师可以查看本次电路和选中的交互记录",
      );
    });
  return (
    <section className="classroom-student">
      <h4>我的学习进度</h4>
      {latest ? (
        <p>
          最近共享：{time(latest.createdAt)} ·{" "}
          {latest.status === "submitted" ? "已提交" : "进行中"} · 自报进度{" "}
          {latest.progress}%
        </p>
      ) : (
        <p>还没有共享记录。教师只能看到你主动共享的内容。</p>
      )}
      <p>
        选定电路：<strong>{doc?.name || "请先打开电路文件"}</strong>
      </p>
      <label className="classroom-check">
        <Checkbox
          checked={include}
          onCheckedChange={(value) => {
            setInclude(value);
            setPrepared(null);
          }}
        />
        同时共享当前文件夹的当前 AI 对话（问答与工具结果）
      </label>
      <label>
        自报完成进度（%）
        <input
          aria-label="完成进度"
          type="number"
          min={0}
          max={100}
          value={progress}
          onChange={(e) => setProgress(Number(e.target.value))}
        />
      </label>
      <label>
        进度说明
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          placeholder="已完成哪些部分、遇到什么问题？"
        />
      </label>
      <label className="classroom-check">
        <Checkbox checked={auto} onCheckedChange={setAuto} />
        共享后每 30 秒检查变化；关闭此窗口后继续共享选定电路和对话
      </label>
      <p className="muted">
        切换工作文件夹或 AI 对话会暂停自动共享。API
        密钥、模型配置、其他文件和其他对话不会上传。自报进度不等同于仿真验证结果。
      </p>
      <button
        disabled={busy || !doc || detail.classroom.archived}
        onClick={() =>
          void run(async () => {
            setPrepared(await prepareWork(doc!.id, include));
          })
        }
      >
        预览将共享的内容
      </button>
      {prepared && (
        <div className="classroom-preview">
          <h4>共享预览 · {prepared.snapshot.name}</h4>
          {prepared.snapshot.image && (
            <img
              className="classroom-circuit-image"
              src={prepared.snapshot.image}
              alt="将共享的电路图"
            />
          )}
          <p>
            {prepared.snapshot.components} 个元件 · {prepared.snapshot.wires}{" "}
            条导线 · {prepared.snapshot.messages.length} 条交互记录
          </p>
          <details>
            <summary>查看电路 XML</summary>
            <pre>{prepared.snapshot.xml}</pre>
          </details>
          <details>
            <summary>查看 AI 交互记录</summary>
            {prepared.snapshot.messages.map((m) => (
              <article key={m.id}>
                <strong>
                  {m.type === "user"
                    ? "学生"
                    : m.type === "assistant"
                      ? "AI"
                      : "工具"}
                </strong>
                <p>{m.text}</p>
              </article>
            ))}
          </details>
          <div className="classroom-actions">
            <button
              className="primary"
              disabled={busy || detail.classroom.archived}
              onClick={() => submit("working")}
            >
              <Send size={14} />
              共享进度
            </button>
            <button
              disabled={busy || detail.classroom.archived}
              onClick={() => submit("submitted")}
            >
              提交电路
            </button>
          </div>
        </div>
      )}
      {sharing.status && <p role="status">{sharing.status}</p>}
      {sharing.binding && <button onClick={sharing.stop}>停止自动共享</button>}
    </section>
  );
}

function TeacherRoom({
  detail,
  busy,
  run,
  api,
  refresh,
}: {
  detail: ClassroomDetail;
  busy: boolean;
  run: Run;
  api: Api;
  refresh: () => Promise<void>;
}) {
  const [student, setStudent] = useState(""),
    [history, setHistory] = useState<SubmissionSummary[]>([]),
    [submission, setSubmission] = useState<Submission | null>(null),
    [question, setQuestion] = useState(""),
    [report, setReport] = useState<AnalysisReport | null>(null);
  const members = detail.members,
    submitted = members.filter((m) => m.latest?.status === "submitted").length;
  const loadStudent = (studentId: string) =>
    void run(async () => {
      setStudent(studentId);
      setSubmission(null);
      setReport(null);
      const data = await api<{ submissions: SubmissionSummary[] }>(
        `/classrooms/${detail.classroom.id}/students/${studentId}`,
      );
      setHistory(data.submissions);
      if (data.submissions[0]) {
        const work = await api<{ submission: Submission }>(
          `/classrooms/${detail.classroom.id}/submissions/${data.submissions[0].id}`,
        );
        setSubmission(work.submission);
      }
    });
  return (
    <section className="classroom-teacher">
      <div className="classroom-stats">
        <div>
          <strong>{members.length}</strong>
          <span>已加入</span>
        </div>
        <div>
          <strong>{submitted}</strong>
          <span>已提交</span>
        </div>
        <div>
          <strong>{members.filter((m) => !m.latest).length}</strong>
          <span>尚未共享</span>
        </div>
      </div>
      <p className="muted">
        每 15 秒刷新。进度由学生自报；未共享不代表未学习。点击学生查看电路和 AI
        交互证据。
      </p>
      <div className="classroom-table">
        <table>
          <thead>
            <tr>
              <th>学生</th>
              <th>学号</th>
              <th>状态 / 进度</th>
              <th>元件 / 导线</th>
              <th>提问 / 工具错误</th>
              <th>最近共享</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr
                key={m.user.id}
                className={student === m.user.id ? "selected" : ""}
              >
                <td>
                  <button
                    disabled={busy}
                    onClick={() => loadStudent(m.user.id)}
                  >
                    {m.user.name}
                  </button>
                </td>
                <td>{m.user.studentNo}</td>
                <td>
                  {m.latest
                    ? `${m.latest.status === "submitted" ? "已提交" : "进行中"} · ${m.latest.progress}%`
                    : "尚未共享"}
                </td>
                <td>
                  {m.latest
                    ? `${m.latest.components} / ${m.latest.wires}`
                    : "—"}
                </td>
                <td>
                  {m.latest
                    ? `${m.latest.questions} / ${m.latest.toolErrors}`
                    : "—"}
                </td>
                <td>{m.latest ? time(m.latest.createdAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {student && (
        <section className="classroom-review">
          <h4>
            {members.find((m) => m.user.id === student)?.user.name} · 只读审阅{" "}
            <button
              disabled={busy}
              onClick={() => {
                setStudent("");
                setSubmission(null);
                setHistory([]);
              }}
            >
              返回全班
            </button>
          </h4>
          {history.length ? (
            <Select
              label="提交历史"
              value={submission?.id || history[0].id}
              options={history.map((s) => ({
                value: s.id,
                label: `${time(s.createdAt)} · ${s.progress}% · ${s.name}`,
              }))}
              onChange={(id) =>
                void run(async () =>
                  setSubmission(
                    (
                      await api<{ submission: Submission }>(
                        `/classrooms/${detail.classroom.id}/submissions/${id}`,
                      )
                    ).submission,
                  ),
                )
              }
            />
          ) : (
            <p>该学生尚未共享电路。</p>
          )}
          {submission && (
            <>
              <p>
                提交编号：<code>{submission.id}</code> ·{" "}
                {submission.snapshot.note}
              </p>
              {submission.snapshot.image && (
                <img
                  className="classroom-circuit-image"
                  src={submission.snapshot.image}
                  alt={`${submission.name} 电路预览`}
                />
              )}
              <details>
                <summary>电路 XML · {submission.name}</summary>
                <pre>{submission.snapshot.xml}</pre>
              </details>
              <h4>与 AI 的交互记录（{submission.snapshot.messages.length}）</h4>
              {submission.snapshot.messages.map((m) => (
                <article key={m.id} className="classroom-message">
                  <strong>
                    {m.type === "user"
                      ? "学生"
                      : m.type === "assistant"
                        ? "AI"
                        : "工具"}
                    {m.status ? ` · ${m.status}` : ""}
                  </strong>
                  <p>{m.text}</p>
                </article>
              ))}
            </>
          )}
        </section>
      )}
      <section className="classroom-analysis">
        <h4>
          <Sparkles size={16} />
          AI 学情分析 · {student ? "当前学生" : "全班"}
        </h4>
        <textarea
          aria-label="学情分析问题"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={2000}
          placeholder="例如：哪些学生在进位逻辑上遇到困难？他们怎样使用 AI？下一节课应重点讲什么？"
        />
        <button
          className="primary"
          disabled={busy || !detail.aiAvailable}
          onClick={() =>
            void run(async () => {
              const result = await api<{ report: AnalysisReport }>(
                `/classrooms/${detail.classroom.id}/analysis`,
                "POST",
                {
                  question: question || undefined,
                  studentId: student || undefined,
                },
              );
              setReport(result.report);
              await refresh();
            })
          }
        >
          <Sparkles size={14} />
          {busy ? "处理中…" : "生成分析报告"}
        </button>
        {!detail.aiAvailable && (
          <p className="muted">请由服务管理员配置课堂 AI 接口、密钥和模型。</p>
        )}
        {report && <Report report={report} />}
        <details>
          <summary>已保存的分析报告（最近 10 份）</summary>
          {detail.analyses.map((r) => (
            <Report key={r.id} report={r} />
          ))}
        </details>
      </section>
    </section>
  );
}
function Report({ report }: { report: AnalysisReport }) {
  return (
    <article className="classroom-report">
      <p>
        {time(report.createdAt)} · {report.model} · 覆盖{" "}
        {report.coveredStudents}/{report.totalStudents} 位学生
      </p>
      <Markdown skipHtml components={{ img: () => null }}>
        {report.text}
      </Markdown>
      <details>
        <summary>使用的提交证据（{report.evidence.length}）</summary>
        {report.evidence.map((id) => (
          <code key={id}>
            {id}
            <br />
          </code>
        ))}
      </details>
    </article>
  );
}
