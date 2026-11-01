import assert from "node:assert/strict";
import { createServer } from "node:http";
import { act, useLayoutEffect, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClassroomEntry } from "../../../apps/workbench/src/classroom/Classroom";
import { useWorkbench } from "../../../apps/workbench/src/app/provider";
import { createClassroomServer } from "../../../packages/classroom/src/server.mts";
import { Workbench, pickOption } from "./workbench";

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
  try {
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
      "PASS: automatic classroom sync handles large circuits and conversation switches, excludes provider secrets, supports classroom edits and reusable teacher models, and provides evidence-based AI reports",
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
