import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ProjectInfo } from "../../../apps/workbench/src/workspace/ProjectInfo";
import { FindDialog } from "../../../apps/workbench/src/editor/FindDialog";
export async function verifyProjectInfoUI() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const g = globalThis as any,
    previous = g.__command;
  const calls: any[] = [];
  let missing = false;
  g.__desktop = true;
  g.__saveTarget = "/fixture/project.zip";
  g.__command = async (request: any) => {
    calls.push(request);
    if (request.op === "projectInfo")
      return {
        documentId: request.id,
        revision: request.revision,
        name: "fixture.circ",
        path: "/fixture/fixture.circ",
        dirty: true,
        circuits: 2,
        builtInLibraries: 1,
        libraries: [
          {
            name: "library.circ",
            kind: "file",
            available: !missing,
            error: missing ? "组件库文件不存在" : undefined,
          },
        ],
        issues: missing ? ["missing"] : [],
        exportable: !missing,
        runtimeAvailable: true,
        runtimeVersion: null,
        sourceStatus: { state: "unchanged" },
      };
    if (request.op === "projectExportTarget")
      return { revision: "target-version" };
    if (request.op === "projectExport")
      return { saved: true, name: "fixture.zip" };
    throw Error(`Unexpected request ${request.op}`);
  };
  const doc: any = {
    id: "doc-a",
    revision: "r1",
    name: "fixture.circ",
    dirty: true,
  };
  const button = (text: string) =>
    Array.from(node.querySelectorAll("button")).find(
      (b) => b.textContent === text,
    )!;
  try {
    await act(async () =>
      root.render(<ProjectInfo doc={doc} onClose={() => {}} />),
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].op,
      "projectInfo",
      "Opening metadata must not start simulation or checks",
    );
    assert.match(node.textContent!, /尚未载入/);
    assert.match(node.textContent!, /未保存的改动/);
    await act(async () => button("导出工程 ZIP…").click());
    assert(
      !calls.some((c) => c.op === "projectExport"),
      "Existing target needs explicit replacement confirmation",
    );
    await act(async () => button("替换文件").click());
    const exported = calls.find((c) => c.op === "projectExport");
    assert.equal(exported.id, "doc-a");
    assert.equal(exported.revision, "r1");
    assert.equal(exported.expected_revision, "target-version");
    missing = true;
    await act(async () =>
      root.render(
        <ProjectInfo doc={{ ...doc, revision: "r2" }} onClose={() => {}} />,
      ),
    );
    assert(button("导出工程 ZIP…").disabled);
    assert.match(node.textContent!, /组件库文件不存在/);
    const circuit: any = {
      name: "main",
      components: [
        {
          id: "prefix",
          name: "Pin",
          attributes: { label: "clock enable" },
          location: { x: 0, y: 0 },
        },
        {
          id: "exact",
          name: "Pin",
          attributes: { label: "clock" },
          location: { x: 0, y: 0 },
        },
      ],
    };
    let chosen = "";
    await act(async () =>
      root.render(
        <FindDialog
          doc={{ ...doc, circuits: [circuit] }}
          circuit={circuit}
          mode="component"
          onChoose={(_, component) => {
            chosen = component!;
          }}
          onClose={() => {}}
        />,
      ),
    );
    const input = node.querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "clock");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const active = input.getAttribute("aria-activedescendant");
    assert(active);
    assert.match(
      document.getElementById(active)!.textContent!,
      /^clockPin|^clock引脚/,
    );
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    assert.equal(
      chosen,
      "exact",
      "An exact component label ranks before a prefix label",
    );
    console.log(
      "Verified file information does not launch the runtime, ZIP export binds revision and confirms replacement, missing libraries prevent incomplete export, and finder exact-label keyboard selection.",
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    g.__command = previous;
    g.__desktop = false;
    delete g.__saveTarget;
  }
}
