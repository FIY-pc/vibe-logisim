import assert from "node:assert/strict";
import { createServer } from "node:http";
import { act, useLayoutEffect, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClassroomEntry } from "../../../apps/workbench/src/classroom/Classroom";
import { useWorkbench } from "../../../apps/workbench/src/app/provider";
import { createClassroomServer } from "../../../packages/classroom/src/server.mts";
import { Workbench, pickOption } from "./workbench";
import { templatePins } from "../../../apps/workbench/src/classroom/assessment-utils";

export async function verifyClassroomUI() {
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { content: "建议在下一节课讲解进位逻辑。" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const service = createClassroomServer({
    database: ":memory:",
    teacherCode: "invite",
    ai: {
      baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      apiKey: "test",
      model: "fixture",
    },
    // A deterministic stand-in for the native grader: submissions pass unless
    // their XML is marked wrong; the real JVM grading has its own test.
    grade: async (input) => ({
      rows: input.tests.map((t) => ({
        oscillating: false,
        outputs: Object.fromEntries(
          Object.entries(t.expected).map(([name, value]) => [
            name,
            {
              bits: String(value),
              value: input.xml.includes("wrong") ? value + 1 : value,
            },
          ]),
        ),
      })),
    }),
  });
  await new Promise<void>((resolve) =>
    service.server.listen(0, "127.0.0.1", resolve),
  );
  const server = `http://127.0.0.1:${(service.server.address() as any).port}`;
  const api = async (path: string, token: string, body?: unknown) => {
    const response = await fetch(server + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await response.json()) as any;
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  const teacher = await api("/auth/register", "", {
    username: "teacher-ui",
    password: "test-password",
    name: "李老师",
    role: "teacher",
    teacherCode: "invite",
  });
  const student = await api("/auth/register", "", {
    username: "student-ui",
    password: "test-password",
    name: "张同学",
    studentNo: "20260001",
    role: "student",
  });
  const room = (
    await api("/classrooms", teacher.token, {
      title: "全加器课堂",
      task: "完成全加器",
      rubric: "测试全部输入",
    })
  ).classroom;
  await api("/classrooms/join", student.token, { code: room.code });
  await api(`/classrooms/${room.id}/ai`, teacher.token, {
    name: "课堂服务",
    baseUrl: server + "/fixture/v1",
    apiKey: "teacher-real-secret",
    model: "fixture-model",
    api: "openai-completions",
    enabled: true,
    contextWindow: 128000,
    effort: "none",
    vision: false,
  });
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const oldCommand = (globalThis as any).__command;
  const originalInterval = globalThis.setInterval;
  let tickSharing: (() => void) | undefined;
  let folderId = "folder-ui",
    agentBusy = false,
    captureReads = 0,
    conversationId = "conversation-ui";
  (globalThis as any).setInterval = (
    callback: () => void,
    delay: number,
    ...args: any[]
  ) => {
    if (delay === 15000) tickSharing = callback;
    return originalInterval(callback, delay, ...args);
  };
  const doc: any = {
    id: "shared-doc",
    name: "adder.circ",
    path: "/work/adder.circ",
    revision: "r1",
    main: "main",
    dirty: false,
    canUndo: false,
    canRedo: false,
    libraries: [],
    circuits: [{ name: "main", components: [], wires: [] }],
  };
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const templateXml = `<project source="1.0" version="1.0">
  <lib desc="#Wiring" name="0"/>
  <lib desc="#Gates" name="1"/>
  <main name="main"/>
  <circuit name="main">
    <comp lib="0" loc="(100,100)" name="Pin"><a name="label" val="A"/></comp>
    <comp lib="0" loc="(100,140)" name="Pin"><a name="label" val="B"/></comp>
    <comp lib="0" loc="(300,120)" name="Pin"><a name="output" val="true"/><a name="label" val="Y"/></comp>
  </circuit>
</project>`;
  let template: any = null;
  const own: any = {
    id: "personal",
    name: "个人服务",
    baseUrl: "https://personal.example/v1",
    api: "openai-completions",
    model: "own-model",
  };
  const services: any[] = [own];
  let selected: any = own,
    receivedProxyKey = "";
  (globalThis as any).__command = async (r: any) => {
    if (r.op === "status") return { folder: { id: folderId, path: "/work" } };
    if (r.op === "read") {
      captureReads++;
      return doc;
    }
    if (r.op === "source")
      return {
        xml:
          "<project><!--" +
          "x".repeat(2300000) +
          '--><circuit name="main"/></project>',
      };
    if (r.op === "render") return { image };
    if (r.op === "import")
      return (template = {
        ...doc,
        id: "template-doc",
        name: r.name,
        path: null,
        revision: "t0",
      });
    if (r.op === "saveTarget") return { revision: null };
    if (r.op === "save")
      return (template = { ...template, path: r.path, revision: "t1" });
    if (r.op === "close") return {};
    if (r.op === "agent") {
      if (r.method === "configure") {
        receivedProxyKey = r.args.apiKey;
        const { apiKey, ...publicConfig } = r.args;
        services.push({ ...publicConfig, id: "teacher-proxy" });
      }
      if (r.method === "bindProvider")
        selected = services.find((s) => s.id === r.args.id);
      return {
        workspaceKey: "folder-ui",
        conversationId,
        busy: agentBusy,
        customProvider: { ...selected, apiKey: "must-not-upload" },
        services,
        messages: [
          {
            id: "u1",
            type: "user",
            text:
              conversationId === "conversation-ui"
                ? "进位为什么不对？"
                : "另一段课堂对话",
          },
          { id: "a1", type: "assistant", text: "检查真值表" },
        ],
      };
    }
    throw new Error("Unexpected host request " + r.op);
  };
  function Fixture() {
    const { stores } = useWorkbench();
    useLayoutEffect(() => {
      stores.documents.setState({ docs: [doc], active: doc.id });
      // A Windows-shaped folder path: the host reports verbatim `\\?\` roots,
      // and template files must join with backslashes there.
      stores.files.setState({
        folder: { id: "folder-ui", path: "C:\\work", name: "work" },
      });
    }, [stores]);
    return <ClassroomEntry />;
  }
  const button = (label: string) => {
    const b = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (n) =>
        n.textContent?.trim() === label ||
        n.getAttribute("aria-label") === label,
    );
    assert(b, `button ${label}`);
    return b;
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    assert.ok(predicate(), container.textContent || "UI did not settle");
  };
  // The attempt poller runs on a one-second interval; some waits outlive `wait`.
  const waitLong = async (predicate: () => boolean) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    assert.ok(predicate(), container.textContent || "UI did not settle");
  };
  const setValue = async (el: Element, value: string) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const setFiles = async (input: Element, files: File[]) => {
    Object.defineProperty(input, "files", {
      value: files,
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    });
  };
  /** The single control of the label starting with `text`. */
  const field = (text: string) => {
    const label = [...container.querySelectorAll("label")].find((l) =>
      l.textContent?.trim().startsWith(text),
    );
    assert(label, `field ${text}`);
    const control = label.querySelector("input,textarea,select");
    assert(control, `control of ${text}`);
    return control;
  };
  const clickContaining = async (text: string) => {
    const b = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (n) => n.textContent?.includes(text),
    );
    assert(b, `button containing ${text}`);
    await act(async () => b.click());
  };
  // LessonEditor parses uploaded templates with the browser XML parser.
  (globalThis as any).DOMParser = window.DOMParser;
  try {
    const namedSubcircuit = templateXml
      .replaceAll('lib="0"', 'lib="wiring"')
      .replace('name="0"', 'name="wiring"')
      .replace(
        "</circuit>",
        '<comp name="Pin" loc="(200,200)"><a name="label" val="helper"/></comp></circuit><circuit name="Pin"/>',
      );
    const parsedPins = templatePins(namedSubcircuit, "main");
    assert.deepEqual(
      parsedPins.inputs.map((p) => p.name),
      ["A", "B"],
      "a subcircuit named Pin is not an input terminal",
    );
    assert.deepEqual(
      parsedPins.outputs.map((p) => p.name),
      ["Y"],
    );
    localStorage.removeItem("vibe.classroom.session");
    sessionStorage.setItem(
      "vibe.classroom.session",
      JSON.stringify({ ...student, server }),
    );
    await act(async () =>
      root.render(
        <StrictMode>
          <Workbench>
            <Fixture />
          </Workbench>
        </StrictMode>,
      ),
    );
    await click("课堂管理");
    await wait(() => Boolean(container.querySelector(".assessment-tabs")));
    await click("学习记录与同步");
    await wait(() => Boolean(container.querySelector(".classroom-student")));
    await click("使用教师提供的 AI");
    await wait(() => selected.id === "teacher-proxy");
    assert.ok(selected.baseUrl.endsWith(`/classrooms/${room.id}/ai/v1`));
    assert.notEqual(receivedProxyKey, "teacher-real-secret");
    await wait(() => !button("刷新可选服务").disabled);
    await pickOption("个人 AI 服务", "个人服务");
    await click("使用自己的 AI");
    await wait(() => selected.id === "personal");
    assert.ok(
      services.some((s) => s.id === "personal"),
      "teacher selection preserves personal services",
    );
    await wait(() => Boolean(container.textContent?.includes("已自动同步")));
    assert.ok(!container.textContent?.includes("自报完成"));
    assert.ok(!container.textContent?.includes("进度说明"));
    const roster = await api(`/classrooms/${room.id}`, teacher.token),
      id = roster.members[0].latest.id;
    const saved = (
      await api(`/classrooms/${room.id}/submissions/${id}`, teacher.token)
    ).submission;
    assert.equal(saved.snapshot.messages.length, 2);
    assert.ok(
      saved.snapshot.xml.length > 2 * 1024 * 1024,
      "realistic CPU circuits exceed the old 2 MB limit",
    );
    assert.ok(!JSON.stringify(saved).includes("must-not-upload"));
    await wait(() => Boolean(tickSharing));
    await click("关闭课堂管理");
    assert.ok(button("课堂管理").textContent?.includes("自动同步"));
    await act(async () => {
      tickSharing!();
      await new Promise((r) => setTimeout(r, 40));
    });
    assert.equal(
      (await api(`/classrooms/${room.id}`, teacher.token)).members[0]
        .submissionCount,
      1,
      "unchanged snapshots are not uploaded twice",
    );
    doc.revision = "r2";
    agentBusy = true;
    await act(async () => {
      tickSharing!();
      await new Promise((r) => setTimeout(r, 40));
    });
    assert.ok(
      button("课堂管理").textContent?.includes("自动同步"),
      "running AI turn waits without disabling sharing",
    );
    agentBusy = false;
    await act(async () => {
      tickSharing!();
      await new Promise((r) => setTimeout(r, 80));
    });
    assert.equal(
      (await api(`/classrooms/${room.id}`, teacher.token)).members[0]
        .submissionCount,
      2,
      "explicit sharing survives closing the dialog",
    );
    conversationId = "another-conversation";
    await act(async () => {
      tickSharing!();
      await new Promise((r) => setTimeout(r, 100));
    });
    assert.equal(
      (await api(`/classrooms/${room.id}`, teacher.token)).members[0]
        .submissionCount,
      3,
      "new conversations in the same classroom folder sync automatically",
    );
    const beforeSwitch = captureReads;
    folderId = "other-folder";
    await act(async () => {
      tickSharing!();
      await new Promise((r) => setTimeout(r, 40));
    });
    assert.equal(
      captureReads,
      beforeSwitch,
      "a switched workspace is rejected before reading another document",
    );
    await click("课堂管理");
    await wait(() => Boolean(container.querySelector(".assessment-tabs")));
    await click("学习记录与同步");
    await wait(() =>
      Boolean(container.textContent?.includes("本课堂同步已暂停")),
    );
    folderId = "folder-ui";
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.removeItem("vibe.classroom.session");
    sessionStorage.setItem(
      "vibe.classroom.session",
      JSON.stringify({ ...teacher, server }),
    );
    await act(async () =>
      root.render(
        <StrictMode>
          <Workbench>
            <ClassroomEntry />
          </Workbench>
        </StrictMode>,
      ),
    );
    await click("课堂管理");
    await wait(() => Boolean(container.querySelector(".assessment-tabs")));
    // The lessons tab is the teacher's publishing workspace: create a chapter,
    // then a published lesson with a template, a public and a hidden case.
    await click("新增章节");
    await wait(() =>
      Boolean(container.querySelector(".assessment-chapter-form")),
    );
    await setValue(field("章节名称"), "组合逻辑基础");
    await setValue(field("章节说明"), "从异或门开始");
    await click("保存章节");
    await wait(() => Boolean(container.textContent?.includes("组合逻辑基础")));
    await click("新增关卡");
    await wait(() => Boolean(container.querySelector(".lesson-editor")));
    await setValue(field("关卡名称"), "异或门关卡");
    await setValue(field("分值"), "20");
    await clickContaining("模板与测试用例");
    await setFiles(
      container.querySelector(".lesson-template input[type='file']")!,
      [new File([templateXml], "xor-template.circ")],
    );
    await wait(() =>
      Boolean(container.textContent?.includes("xor-template.circ")),
    );
    await setValue(field("用例数量"), "2");
    await click("应用数量");
    await wait(() =>
      Boolean(container.querySelector('input[aria-label="用例2名称"]')),
    );
    await setValue(
      container.querySelector('input[aria-label="用例1输入A"]')!,
      "1",
    );
    await setValue(
      container.querySelector('input[aria-label="用例1预期Y"]')!,
      "1",
    );
    await setValue(
      container.querySelector('input[aria-label="用例2名称"]')!,
      "教师私有场景",
    );
    await setValue(
      container.querySelector('input[aria-label="用例2输入A"]')!,
      "1",
    );
    await setValue(
      container.querySelector('input[aria-label="用例2输入B"]')!,
      "1",
    );
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('input[aria-label="隐藏用例2"]')!
        .click(),
    );
    await click("关卡说明");
    await setFiles(
      container.querySelector(".lesson-upload-tools input[type='file']")!,
      [
        new File(["# 异或门\n\n实现 Y = A ⊕ B，并提交评测。"], "xor.md", {
          type: "text/markdown",
        }),
      ],
    );
    await wait(() =>
      (field("Markdown 内容") as HTMLTextAreaElement).value.includes("异或门"),
    );
    await act(async () =>
      container
        .querySelector<HTMLInputElement>(".classroom-check input")!
        .click(),
    );
    await click("保存关卡");
    await wait(() => Boolean(container.textContent?.includes("关卡已保存")));
    await wait(() => Boolean(container.textContent?.includes("教师私有场景")));
    assert.ok(
      container.textContent?.includes("测试用例（2）"),
      "the teacher sees both cases on the lesson page",
    );
    await click("学习记录与分析");
    await wait(() => Boolean(container.querySelector(".classroom-teacher")));
    await wait(() => !button("修改选中配置").disabled);
    await click("修改选中配置");
    const providerForm = container.querySelector<HTMLFormElement>(
      ".classroom-provider-form",
    )!;
    const keyField = providerForm.querySelector<HTMLInputElement>(
      'input[name="apiKey"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(keyField, "updated-teacher-secret");
      keyField.dispatchEvent(new Event("input", { bubbles: true }));
      providerForm.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await wait(() =>
      Boolean(container.textContent?.includes("模型配置已保存到教师模型库")),
    );
    assert.equal(
      container.querySelector('.classroom-provider-form input[name="apiKey"]'),
      null,
      "successful save closes the credential form",
    );
    const classroomForm = container.querySelector<HTMLFormElement>(
      ".classroom-settings-form",
    )!;
    const titleField = classroomForm.querySelector<HTMLInputElement>(
      'input[name="title"]',
    )!;
    titleField.value = "更新后的课堂";
    await act(async () =>
      classroomForm.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await wait(() =>
      Boolean(container.textContent?.includes("课堂信息已更新")),
    );
    assert.equal(
      (await api(`/classrooms/${room.id}`, teacher.token)).classroom.title,
      "更新后的课堂",
    );
    const originalCode = container.querySelector(
      ".classroom-room-heading code",
    )?.textContent;
    await click("更新课堂码");
    await wait(
      () =>
        container.querySelector(".classroom-room-heading code")?.textContent !==
        originalCode,
    );
    await wait(() => !button("更新课堂码").disabled);
    await click("张同学");
    await wait(() =>
      Boolean(container.textContent?.includes("另一段课堂对话")),
    );
    assert.equal(
      container.querySelector(".classroom-review img")?.getAttribute("src"),
      image,
    );
    await click("生成分析报告");
    await wait(() => Boolean(container.querySelector(".classroom-report")));
    assert.ok(container.textContent?.includes("建议在下一节课讲解进位逻辑"));
    assert.ok(
      container.querySelector(".classroom-report code"),
      "report includes evidence identifiers",
    );
    // —— The student opens the lesson template, completes it and submits. ——
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.removeItem("vibe.classroom.session");
    sessionStorage.setItem(
      "vibe.classroom.session",
      JSON.stringify({ ...student, server }),
    );
    await act(async () =>
      root.render(
        <StrictMode>
          <Workbench>
            <Fixture />
          </Workbench>
        </StrictMode>,
      ),
    );
    await click("课堂管理");
    await wait(() => Boolean(container.textContent?.includes("组合逻辑基础")));
    await clickContaining("异或门关卡");
    await wait(() =>
      Boolean(container.textContent?.includes("下载模板并打开")),
    );
    assert.ok(
      container.textContent?.includes("1 组隐藏"),
      "the student sees how many hidden cases exist",
    );
    assert.ok(
      container.textContent?.includes("分值 20 分（全部用例通过才得分）"),
      "the lesson states its score rule to students",
    );
    assert.ok(
      !container.textContent?.includes("教师私有场景"),
      "hidden case titles and values stay on the teacher side",
    );
    assert.ok(
      !container.textContent?.includes("评测服务尚未配置"),
      "grading is available",
    );
    await click("下载模板并打开");
    await wait(() => !container.querySelector(".assessment-root"));
    assert.ok(
      typeof template?.path === "string" &&
        template.path.startsWith("C:\\work\\关卡-异或门关卡-") &&
        template.path.endsWith(".circ"),
      "the template is saved into the open project folder and opened",
    );
    await click("课堂管理");
    await wait(() => Boolean(container.textContent?.includes("提交关卡评测")));
    await wait(
      () =>
        container.querySelector<HTMLSelectElement>(".lesson-submit select")
          ?.value === "template-doc",
    );
    await click("提交关卡评测");
    await waitLong(() =>
      Boolean(container.querySelector(".assessment-result.status-passed")),
    );
    assert.ok(container.textContent?.includes("2 / 2"), "both cases passed");
    const studentResult =
      container.querySelector(".assessment-result")!.textContent!;
    assert.ok(
      studentResult.includes("隐藏用例"),
      "hidden cases report pass/fail only",
    );
    assert.ok(!studentResult.includes("教师私有场景"));
    await wait(() => Boolean(container.textContent?.includes("我的提交记录")));
    assert.ok(container.textContent?.includes("通过 2/2"));
    const formulaStudent = await api("/auth/register", "", {
      username: "student-formula",
      password: "test-password",
      name: "=1+1",
      studentNo: "=2+2",
      role: "student",
    });
    const latestRoom = (await api(`/classrooms/${room.id}`, teacher.token))
      .classroom;
    await api("/classrooms/join", formulaStudent.token, {
      code: latestRoom.code,
    });
    // —— The teacher reviews the whole class and one student's attempts. ——
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.removeItem("vibe.classroom.session");
    sessionStorage.setItem(
      "vibe.classroom.session",
      JSON.stringify({ ...teacher, server }),
    );
    await act(async () =>
      root.render(
        <StrictMode>
          <Workbench>
            <ClassroomEntry />
          </Workbench>
        </StrictMode>,
      ),
    );
    await click("课堂管理");
    // The teacher returns to the last opened lesson; go back to the chapters.
    await wait(
      () =>
        Boolean(container.textContent?.includes("组合逻辑基础")) ||
        Boolean(container.textContent?.includes("章节目录")),
    );
    if (container.textContent?.includes("章节目录")) await click("章节目录");
    await wait(() => Boolean(container.textContent?.includes("组合逻辑基础")));
    await click("学生闯关情况");
    await wait(() => Boolean(container.querySelector(".assessment-passed")));
    assert.ok(
      container.textContent?.includes("张同学"),
      "the progress table lists the student",
    );
    assert.ok(container.textContent?.includes("1 次提交"));
    assert.equal(
      container.querySelector(".assessment-total")?.textContent,
      "20",
      "passing every case earns the lesson score",
    );
    await click("生成成绩单");
    await wait(() =>
      Boolean(container.querySelector(".assessment-report-csv")),
    );
    const csv = container.querySelector(".assessment-report-csv")!.textContent!;
    assert.ok(csv.includes("异或门关卡（20分）"), "score sheet header");
    assert.ok(csv.includes("张同学") && csv.includes('"20","20"'), csv);
    assert.ok(
      csv.includes('"\t=1+1","\t=2+2"'),
      "student names and numbers are exported as text, not spreadsheet formulas",
    );
    await clickContaining("已通过");
    await wait(() =>
      Boolean(container.textContent?.includes("张同学的提交记录")),
    );
    assert.ok(
      container.textContent?.includes("adder.circ"),
      "the filtered history shows the student's submission",
    );
    assert.ok(container.textContent?.includes("通过 2/2"));
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.removeItem("vibe.classroom.session");
    sessionStorage.setItem(
      "vibe.classroom.session",
      JSON.stringify({ ...teacher, token: "0".repeat(64), server }),
    );
    await act(async () =>
      root.render(
        <StrictMode>
          <Workbench>
            <ClassroomEntry />
          </Workbench>
        </StrictMode>,
      ),
    );
    await click("课堂管理");
    await wait(() => Boolean(container.querySelector(".classroom-login")));
    assert.equal(
      sessionStorage.getItem("vibe.classroom.session"),
      null,
      "expired sessions are cleared",
    );
    assert.equal(
      button("登录").disabled,
      false,
      "expired-session recovery does not leave login busy",
    );
    console.log(
      "PASS: automatic classroom sync handles large circuits and conversation switches, excludes provider secrets, supports classroom edits and reusable teacher models, and provides evidence-based AI reports; teachers publish chapters and lessons with templates plus hidden cases, students open templates, submit for grading and see redacted results, and teachers review class-wide progress",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.removeItem("vibe.classroom.session");
    localStorage.removeItem("vibe.classroom.session");
    (globalThis as any).__command = oldCommand;
    globalThis.setInterval = originalInterval;
    await service.close();
    provider.closeIdleConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}
