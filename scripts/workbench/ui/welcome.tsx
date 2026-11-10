import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "./themed-root";
import { createWorkbench } from "../../../apps/workbench/src/app/createWorkbench";
import { WorkbenchProvider } from "../../../apps/workbench/src/app/provider";
import { Welcome } from "../../../apps/workbench/src/workspace/Welcome";

export async function verifyWelcome() {
  const g = globalThis as any;
  const previous = g.__command;
  const workbench = createWorkbench();
  const {
    stores,
    actions: { workspace },
  } = workbench;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  let projects = [
    { name: "同名项目", path: "/one/同名项目", available: true },
    { name: "同名项目", path: "/two/同名项目", available: false },
  ];
  const calls: any[] = [];
  const click = async (selector: string) => {
    const button = node.querySelector<HTMLButtonElement>(selector);
    assert(button, selector);
    await act(async () => button.click());
  };
  g.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "folderRecent") return projects;
    if (request.op === "folderForget") {
      projects = projects.filter((project) => project.path !== request.path);
      return projects;
    }
    if (request.op === "folderOpen") {
      if (request.path.startsWith("/two")) throw new Error("项目路径不存在");
      return { id: "project", name: "同名项目", path: request.path };
    }
    if (request.op === "new")
      return {
        id: "new-circuit",
        name: request.name,
        path: null,
        revision: "r1",
        main: "main",
        dirty: false,
        canUndo: false,
        canRedo: false,
        circuits: [{ name: "main", components: [], wires: [], attributes: {} }],
        libraries: [],
      };
    return {};
  };
  try {
    await act(async () => {
      root.render(
        <WorkbenchProvider value={workbench}>
          <Welcome />
        </WorkbenchProvider>,
      );
      await workspace.refreshRecentProjects();
    });
    assert.equal(node.querySelectorAll(".welcome-project").length, 2);
    assert.match(node.textContent!, /路径不可用/);
    // Missing paths remain visible and errors leave the current workspace intact.
    await click('.welcome-project[title="/two/同名项目"]');
    assert.equal(stores.files.getState().folder, null);
    assert.equal(stores.files.getState().recentProjects.length, 2);
    assert(
      calls.some(
        (request) =>
          request.op === "folderOpen" && request.path === "/two/同名项目",
      ),
    );
    await click("li:nth-child(2) .welcome-forget");
    assert.equal(node.querySelectorAll(".welcome-project").length, 1);
    assert(!calls.some((request) => request.op === "folderTrash"));
    await click('.welcome-project[title="/one/同名项目"]');
    assert.equal(stores.files.getState().folder?.path, "/one/同名项目");
    assert.match(node.textContent!, /当前项目/);
    await click('[data-action="new-circuit"]');
    assert.equal(stores.files.getState().newFilePrompt, true);
    await act(async () => stores.files.getState().setFolder(null));
    await click('[data-action="new-circuit"]');
    assert.equal(stores.documents.getState().active, "new-circuit");
    assert.equal(stores.shell.getState().resourceTab, "components");
    assert.equal(stores.files.getState().folder, null);
    // A delayed initial read must not resurrect a record removed by a newer request.
    let resolve!: (value: any) => void;
    g.__command = () =>
      new Promise((done) => {
        resolve = done;
      });
    let stale!: Promise<void>;
    await act(async () => {
      stale = workspace.refreshRecentProjects();
    });
    g.__command = async () => [];
    await act(async () => {
      await workspace.forgetRecentProject("/one/同名项目");
    });
    await act(async () => {
      resolve(projects);
      await stale;
    });
    assert.deepEqual(stores.files.getState().recentProjects, []);
    assert.match(node.textContent!, /还没有打开过项目/);
    g.__command = async () => {
      throw new Error("read denied");
    };
    await act(async () => workspace.refreshRecentProjects());
    assert.match(
      node.querySelector('[role="alert"]')!.textContent!,
      /read denied/,
    );
    g.__command = async () => projects;
    await click(".welcome-link");
    assert.equal(node.querySelector('[role="alert"]'), null);
    assert.equal(node.querySelectorAll(".welcome-project").length, 1);
    console.log(
      "PASS: welcome creates circuits directly, opens projects, retains missing paths, forgets shortcuts, retries reads and rejects stale lists",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    g.__command = previous;
  }
}
