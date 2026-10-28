import { verifyEditorRequestLifetimes } from "./editor-request-lifetimes";
import { verifyAISettings } from "./ai-settings";
import { verifyConversationSummaries } from "./conversation-summaries";
import { verifyConversationTurns } from "./conversation-turns";
import { verifyProjectInfoUI } from "./project-info";
import { verifyDocumentHistory } from "./history";
import { verifyReferenceLinks } from "./reference-links";
import { verifyReferencesUI } from "./references";
import { verifyFilesUI } from "./files";
import { verifyRestoredInteractions } from "./restored-interactions";
import assert from "node:assert/strict";
import { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "../../../apps/workbench/src/conversation/Chat";
import { App } from "../../../apps/workbench/src/App";
import { Canvas } from "../../../apps/workbench/src/editor/Canvas";
import { recordWidthErrors } from "../../../apps/workbench/src/editor/symbols";
import { ProviderSettings } from "../../../apps/workbench/src/conversation/ProviderSettings";
import { ShortcutSettings } from "../../../apps/workbench/src/shell/ShortcutSettings";
import {
  bindingProblem,
  defaultBindings,
  eventBinding,
  loadBindings,
} from "../../../apps/workbench/src/shared/shortcuts";
let observedFocus: any = null;
let templateHandler: ((request: any) => any) | null = null;
import { usePlacement } from "../../../apps/workbench/src/editor/usePlacement";
import { PlacementInspector } from "../../../apps/workbench/src/editor/PlacementInspector";
import { clickMenuItem, openMenu, pickOption, Workbench } from "./workbench";
const noPlacement = {
  tool: null,
  template: null,
  attributes: {},
  loading: false,
  error: "",
  repeat: true,
  setRepeat: () => {},
  change: () => {},
  rotate: () => {},
};
const calls: any[] = [];
const subscribers = new Set<any>();
let sequence = 0,
  runtimeDoc = "A",
  askGate: any = null;
const defer = () => {
  let resolve: any;
  const promise = new Promise((r) => (resolve = r));
  return { resolve, promise };
};
const circuit = (name: string) => ({
  name,
  components: [],
  wires: [],
  attributes: {},
});
const doc = (id: string) => ({
  id,
  name: id + ".circ",
  revision: "r1",
  main: id === "B" ? "B-main" : "main",
  path: null,
  dirty: false,
  canUndo: false,
  canRedo: false,
  circuits:
    id === "B"
      ? [circuit("B-main"), circuit("ancestor")]
      : [circuit("main"), circuit("ancestor")],
});
/** What an edit of `d` from revision `base` reports: its fields, every
 * circuit name, and no changed circuit. */
const change = (d: any, base: string) => ({
  ...d,
  base,
  order: d.circuits.map((c: any) => c.name),
  circuits: [],
});
const state = () => ({
  eventCursor: sequence,
  runtime: "builtin",
  status: "idle",
  available: true,
  busy: false,
  messages: [],
  model: "fixture",
  effort: "none",
  services: [{ id: "service" }],
  customProvider: null,
  conversationId: "chat-" + runtimeDoc,
});
(globalThis as any).__subscribe = (fn: any) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};
(globalThis as any).__command = async (request: any) => {
  calls.push(request);
  if (request.op === "agent") {
    if (request.method === "bind") runtimeDoc = request.args.documentId;
    if (request.method === "ask" && askGate) await askGate.promise;
    if (request.method === "conversations")
      return {
        conversations: [
          { id: "chat-" + runtimeDoc, title: runtimeDoc, archived: false },
        ],
      };
    return state();
  }
  if (
    ["feedbackStatus", "feedbackCheck", "feedbackPreference"].includes(
      request.op,
    )
  )
    return {
      enabled: false,
      forcedOff: false,
      current: "0.6.0-dev",
      development: true,
      latest: "0.5.0",
      url: null,
      lastCheckedAt: null,
      newer: false,
      available: false,
      error: null,
    };
  if (request.op === "diagnostics")
    return {
      schema: 1,
      appVersion: "0.6.0-dev",
      platform: "fixture",
      architecture: "fixture",
      nativeRuntimeAvailable: true,
      simulationActive: false,
      recoveryIssue: false,
    };
  if (request.op === "status")
    return {
      documents: [doc("A"), doc("B")],
      active: "A",
      folder: null,
      recoveryError: null,
    };
  if (request.op === "sourceStatus") return { state: "unchanged" };
  if (request.op === "catalog") return { children: [] };
  if (request.op === "observe" || request.op === "connections")
    return { focus: observedFocus || { components: [] } };
  if (request.op === "template" && templateHandler)
    return templateHandler(request);
  if (request.op === "template")
    return {
      attributes: { facingAttribute: "facing" },
      children: [
        {
          tag: "attribute",
          attributes: {
            name: "facing",
            value: request.attributes?.facing || "east",
          },
        },
      ],
    };
  return null;
};
const emit = (event: any) => {
  for (const fn of subscribers) fn(event);
};
const agent = (event: any) =>
  emit({ topic: "agent", data: { sequence: ++sequence, event } });
/** A document change the host broadcast, as `router.ts` applies it. */
const hostChange = (change: any) => emit({ topic: "change", data: change });
let root = createRoot(document.getElementById("root")!);
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
const render = async (node: any) => {
  await act(async () => root.render(node));
  await settle();
};
const click = async (el: Element | null) => {
  assert.ok(el);
  await act(async () =>
    el.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  await settle();
};
const input = async (value: string) => {
  const el = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="消息"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const errors: any[] = [];
const chat = (d: any, visible = true) => (
  <Workbench>
    <Chat
      visible={visible}
      doc={d}
      circuit={d.main}
      folder={null}
      selection={[]}
      quotation={null}
      onQuoted={() => {}}
      onFilesChanged={async () => {}}
      onError={(e: any) => errors.push(e)}
    />
  </Workbench>
);
await render(chat(doc("A")));
assert.equal(
  document.querySelector<HTMLTextAreaElement>("textarea")!.disabled,
  false,
);
await input("submitted");
askGate = defer();
await click(document.querySelector('[aria-label="发送"]'));
await input("new draft while waiting");
await act(async () => {
  askGate.resolve();
  await askGate.promise;
});
askGate = null;
await settle();
assert.equal(
  document.querySelector<HTMLTextAreaElement>("textarea")!.value,
  "new draft while waiting",
);
assert.equal(
  localStorage.getItem("vibe.draft:A:chat-A"),
  "new draft while waiting",
);
console.log(
  "PASS: delayed send acknowledgement preserves subsequently typed draft",
);
localStorage.setItem("vibe.draft:B:chat-B", "B own draft");
await input("A to submit");
askGate = defer();
await click(document.querySelector('[aria-label="发送"]'));
await render(chat(doc("B")));
assert.equal(
  document.querySelector<HTMLTextAreaElement>("textarea")!.disabled,
  true,
);
await act(async () => {
  askGate.resolve();
  await askGate.promise;
});
askGate = null;
await settle();
await settle();
assert.equal(
  document.querySelector<HTMLTextAreaElement>("textarea")!.value,
  "B own draft",
);
assert.equal(
  document.querySelector<HTMLTextAreaElement>("textarea")!.disabled,
  false,
);
console.log(
  "PASS: document switch waits for binding, restores only matching conversation draft",
);
await act(async () => root.unmount());
root = createRoot(document.getElementById("root")!);
subscribers.clear();
runtimeDoc = "A";
await render(<App />);
await click(
  [...document.querySelectorAll(".panel-tabs button")].find(
    (n) => n.textContent === "连接",
  )!,
);
await act(async () =>
  hostChange(change({ ...doc("A"), revision: "r2", dirty: true }, "r1")),
);
assert.ok(document.querySelector(".file-title .dirty-dot"));
await click(
  [...document.querySelectorAll(".panel-tabs button")].find(
    (n) => n.textContent === "对话",
  )!,
);
console.log(
  "PASS: App connection tab keeps agent document event subscription alive",
);
const saveTransport = (globalThis as any).__command;
(globalThis as any).__command = async (request: any) =>
  request.op === "save"
    ? (calls.push(request),
      {
        ...doc("A"),
        revision: request.revision,
        path: request.path,
        dirty: false,
      })
    : saveTransport(request);
await act(async () =>
  hostChange(
    change(
      {
        ...doc("A"),
        revision: "r2",
        path: "/fixture/A.circ",
        dirty: true,
        saveError: "磁盘暂不可写",
      },
      "r1",
    ),
  ),
);
assert(
  document.body.textContent?.includes("修改已保留，写回文件失败：磁盘暂不可写"),
);
await click(
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "重试保存",
  )!,
);
assert.equal(calls.filter((call) => call.op === "save").at(-1).revision, "r2");
assert(!document.body.textContent?.includes("磁盘暂不可写"));
assert(!document.querySelector(".file-title .dirty-dot"));
(globalThis as any).__command = saveTransport;
console.log(
  "PASS: automatic save failure preserves the accepted revision and offers an exact-revision save retry",
);
const mutationGate = defer();
let mutationRefreshes = 0;
let documentReads = 0;
const latestMutationDocument = {
  ...doc("A"),
  path: "/fixture/A.circ",
  revision: "r3",
  dirty: true,
};
(globalThis as any).__command = async (request: any) => {
  if (request.op === "save") {
    calls.push(request);
    return mutationGate.promise;
  }
  if (request.op === "status") {
    mutationRefreshes++;
    return {
      documents: [latestMutationDocument, doc("B")],
      active: "A",
      folder: null,
      recoveryError: null,
    };
  }
  if (request.op === "read") {
    documentReads++;
    return { ...doc(request.id), revision: "r-delayed-agent" };
  }
  return saveTransport(request);
};
await openMenu("更多");
await clickMenuItem("保存");
await act(async () =>
  hostChange(change(latestMutationDocument, "r2")),
);
await act(async () => {
  mutationGate.resolve({
    ...doc("A"),
    path: "/fixture/A.circ",
    revision: "r2",
    dirty: false,
  });
  await mutationGate.promise;
});
await settle();
assert.equal(
  mutationRefreshes,
  1,
  "A late mutation response must refresh current host state instead of replacing a later event",
);
assert(document.querySelector(".file-title .dirty-dot"));
// Icons follow the project's libraries, not its edits: a newer revision of the
// same project must not send the canvas back for a redraw.
assert.equal(
  calls.filter((call) => call.op === "catalog").at(-1).revision,
  "r1",
);
await act(async () =>
  hostChange(
    change({ ...doc("A"), revision: "r-delayed-agent", dirty: false }, "r2"),
  ),
);
await settle();
// The host's change is a change like the window's own: applied or, if this
// view is past its base, answered by reading that one document.
assert.equal(documentReads, 1, "A document is read on its own");
assert.equal(
  mutationRefreshes,
  1,
  "A host change whose base this view passed reads the document, not the workspace",
);
assert(!document.querySelector(".file-title .dirty-dot"));
(globalThis as any).__command = saveTransport;
await act(async () =>
  hostChange(change({ ...doc("A"), revision: "r2", dirty: true }, "r3")),
);
console.log(
  "PASS: a late save reply and a host change from a passed base refresh current state without overwriting newer document state",
);
const appKey = async (key: string, extra: KeyboardEventInit = {}) =>
  act(async () =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...extra }),
    ),
  );
await appKey("g");
assert.equal(
  document.querySelector(".canvas svg > rect")!.getAttribute("fill"),
  "url(#grid)",
);
await appKey("g");
assert.equal(
  document.querySelector(".canvas svg > rect")!.getAttribute("fill"),
  "transparent",
);
await appKey("/");
assert.equal(
  document.activeElement,
  document.querySelector('input[aria-label="查找电路"]'),
);
await click(
  [...document.querySelectorAll(".circuit-list button")].find(
    (n) => n.textContent === "ancestor",
  )!,
);
assert.equal(
  document.querySelector(".breadcrumbs strong")!.textContent,
  "ancestor",
);
await appKey("f", { ctrlKey: true });
assert.ok(document.querySelector('dialog[aria-label="查找元件"]'));
await click(document.querySelector('.find-dialog [aria-label="关闭"]'));
console.log(
  "PASS: editor keyboard dispatch toggles grid and opens actionable circuit/component search",
);
await openMenu("更多");
await clickMenuItem("帮助与反馈");
await clickMenuItem("立即检查更新");
assert.match(document.querySelector(".capture-notice")!.textContent!, /开发版/);
assert.equal(document.querySelector(".error-bar"), null);
await openMenu("更多");
await clickMenuItem("帮助与反馈");
await clickMenuItem("反馈问题…");
assert.ok(document.querySelector('dialog[aria-label="反馈问题"]'));
assert.match(
  document.querySelector<HTMLTextAreaElement>('[aria-label="诊断预览"]')!.value,
  /nativeRuntimeAvailable/,
);
await click(document.querySelector('[aria-label="关闭反馈"]'));
console.log(
  "PASS: existing menu exposes feedback preview and reports development update status without an error",
);
// A control action is a sequence of host commands; it must not wait on the
// queue those commands go through.
const beforeClock = calls.length;
await appKey("k", { ctrlKey: true });
await settle();
assert.ok(
  calls
    .slice(beforeClock)
    .some((c) => c.op === "simulationStart" && c.circuit === "ancestor"),
);
console.log("PASS: the clock shortcut starts a run of the shown circuit");

await act(async () => root.unmount());
root = createRoot(document.getElementById("root")!);
// Whole-workspace snapshots must not roll back newer events or tab changes.
const originalHost = (globalThis as any).__command;
const auditFolder = { id: "folder:audit", path: "/fixture", name: "fixture" };
let auditDocs: any[] = [doc("A"), doc("B")];
let auditActive = "A";
let auditStatusGate: ReturnType<typeof defer> | null = defer();
const firstStatusGate = auditStatusGate;
let statusReads = 0;
const closeGates = new Map<string, ReturnType<typeof defer>>();
const auditSnapshot = () => ({
  documents: [...auditDocs],
  active: auditActive,
  folder: auditFolder,
  recoveryError: null,
});
(globalThis as any).__command = async (request: any) => {
  if (request.op === "status") {
    statusReads++;
    return auditStatusGate ? auditStatusGate.promise : auditSnapshot();
  }
  if (request.op === "new") {
    const created = doc("C");
    auditDocs = [...auditDocs, created];
    auditActive = created.id;
    return created;
  }
  if (request.op === "activate") {
    auditActive = request.id;
    return null;
  }
  if (request.op === "close") {
    const gate = closeGates.get(request.id);
    if (gate) await gate.promise;
    auditDocs = auditDocs.filter((d) => d.id !== request.id);
    if (auditActive === request.id) auditActive = auditDocs[0]?.id || "";
    return { closed: true };
  }
  if (request.op === "folderList")
    return {
      folder: auditFolder,
      entries: [{ name: "a.circ", path: "a.circ", directory: false, size: 20 }],
    };
  if (request.op === "folderRename") return {};
  return originalHost(request);
};
const startupSnapshot = auditSnapshot();
await render(<App />);
await openMenu("更多");
await clickMenuItem("新建电路");
assert.match(document.querySelector(".file-title")!.textContent!, /C.circ/);
auditStatusGate = null;
await act(async () => {
  firstStatusGate.resolve(startupSnapshot);
  await firstStatusGate.promise;
});
await settle();
assert.match(document.querySelector(".file-title")!.textContent!, /C.circ/);
assert.equal(document.querySelectorAll(".document-item").length, 3);
assert.equal(statusReads, 2);

const oldFileSnapshot = auditSnapshot();
auditStatusGate = defer();
const fileStatusGate = auditStatusGate;
await openMenu("a.circ 的操作");
await clickMenuItem("重命名…");
await act(async () => {
  const el = document.querySelector<HTMLInputElement>(
    'input[aria-label="重命名"]',
  )!;
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!.call(el, "b.circ");
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await act(async () =>
  document
    .querySelector('dialog[aria-label="重命名"] form')!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
);
await settle();
assert.equal(statusReads, 3);
const changedC = { ...doc("C"), revision: "r-new", dirty: true };
auditDocs = auditDocs.map((d) => (d.id === "C" ? changedC : d));
await act(async () => hostChange(change(changedC, "r1")));
assert.ok(document.querySelector(".file-title .dirty-dot"));
auditStatusGate = null;
await act(async () => {
  fileStatusGate.resolve(oldFileSnapshot);
  await fileStatusGate.promise;
});
await settle();
assert.equal(statusReads, 4);
assert.ok(document.querySelector(".file-title .dirty-dot"));
assert.equal(document.querySelector('dialog[aria-label="重命名"]'), null);

// Keyboard close is allowed while another clean tab's close is pending.
closeGates.set("A", defer());
closeGates.set("B", defer());
const selectAuditDoc = (id: string) =>
  click(
    [...document.querySelectorAll(".document-item")].find((n) =>
      n.textContent?.includes(id + ".circ"),
    )!,
  );
await selectAuditDoc("A");
await appKey("w", { ctrlKey: true });
await selectAuditDoc("B");
await appKey("w", { ctrlKey: true });
await selectAuditDoc("A");
await act(async () => {
  closeGates.get("B")!.resolve();
  await closeGates.get("B")!.promise;
});
await act(async () => {
  closeGates.get("A")!.resolve();
  await closeGates.get("A")!.promise;
});
await settle();
assert.equal(document.querySelectorAll(".document-item").length, 1);
assert.match(document.querySelector(".file-title")!.textContent!, /C.circ/);
assert.ok(document.querySelector(".file-title .dirty-dot"));
console.log(
  "PASS: late workspace snapshots cannot erase new tabs or model changes; overlapping closes choose a still-open document",
);
await act(async () => root.unmount());
root = createRoot(document.getElementById("root")!);
(globalThis as any).__command = originalHost;

let edits: any[] = [];
const component = {
  id: "c0",
  name: "Pin",
  library: "0",
  location: { x: 100, y: 100 },
  attributes: {},
};
const cd = {
  ...doc("A"),
  circuits: [{ ...circuit("main"), components: [component] }],
};
const canvas = (d: any) => (
  <Canvas
    doc={d}
    circuit={d.circuits[0]}
    tool="select"
    selection={[]}
    setSelection={() => {}}
    place={null}
    placement={noPlacement}
    onPlace={async () => d}
    onCancelPlace={() => {}}
    edit={async (e: any) => {
      edits.push(e);
    }}
    run={null}
    live={null}
    pending={[]}
    pressed={null}
    onPoke={() => {}}
    onPress={() => {}}
    onRelease={() => {}}
    onError={(e: any) => errors.push(e)}
    fitToken={0}
    onOpenMemory={() => {}}
    onEnterCircuit={() => {}}
  />
);
await render(canvas(cd));
// Points at circuit (x, 100) through the view the canvas shows (600px wide).
const pointer = async (type: string, x: number) => {
  const [vx, vy, vw] = document
    .querySelector(".canvas svg[viewBox]")!
    .getAttribute("viewBox")!
    .split(" ")
    .map(Number);
  const scale = 600 / vw;
  await act(async () =>
    document.querySelector(".canvas")!.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: (x - vx) * scale,
        clientY: (100 - vy) * scale,
      }),
    ),
  );
};
await pointer("pointerdown", 100);
await pointer("pointermove", 120);
await pointer("pointerup", 120);
assert.equal(edits.length, 1);
assert.equal(edits[0].kind, "move");
edits = [];
await pointer("pointerdown", 100);
await pointer("pointermove", 120);
await render(canvas({ ...cd, revision: "r2" }));
await pointer("pointerup", 120);
assert.equal(edits.length, 0);
console.log(
  "PASS: revision change cancels in-flight canvas drag instead of editing new revision",
);

// Native template requests and placement commits must carry the same facing.
let rotationReady = false;
function PlacementHarness({ token }: { token: number }) {
  const tool = { name: "Pin", library: "0", label: "Pin" };
  const placementState = usePlacement(cd as any, cd.circuits[0], tool);
  const lastToken = useRef(token);
  useEffect(() => {
    if (lastToken.current !== token) {
      lastToken.current = token;
      placementState.rotate();
    }
  }, [token]);
  rotationReady = Boolean(placementState.template?.attributes.facingAttribute);
  return (
    <Canvas
      doc={cd as any}
      circuit={cd.circuits[0]}
      tool="select"
      selection={[]}
      setSelection={() => {}}
      place={tool}
      placement={placementState}
      onPlace={async (_revision, edit) => {
        edits.push(edit);
        return { ...cd, revision: "placed" } as any;
      }}
      onCancelPlace={() => {}}
      edit={async (e) => {
        edits.push(e);
      }}
      run={null}
      live={null}
      pending={[]}
      pressed={null}
      onPoke={() => {}}
      onPress={() => {}}
      onRelease={() => {}}
      onError={(e) => errors.push(e)}
      fitToken={0}
      onOpenMemory={() => {}}
      onEnterCircuit={() => {}}
    />
  );
}
const placement = (token: number) => <PlacementHarness token={token} />;
await render(placement(0));
assert.equal(rotationReady, true);
await render(placement(1));
assert.equal(
  calls.filter((c) => c.op === "template").at(-1).attributes.facing,
  "south",
);
edits = [];
await pointer("pointerdown", 200);
assert.equal(edits[0].attributes.facing, "south");
edits = [];
await act(async () =>
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }),
  ),
);
await pointer("pointerdown", 140);
await pointer("pointermove", 170);
await pointer("pointerup", 170);
await act(async () =>
  document.body.dispatchEvent(
    new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }),
  ),
);
assert.equal(edits.length, 0);
console.log(
  "PASS: rotation preview and placed facing match; Space temporarily pans without placement",
);

// Attribute changes are previews; clicks snapshot attributes and commit in order.
templateHandler = (request) => {
  if (request.attributes?.label === "invalid") throw new Error("标签无效");
  const values = { facing: "east", label: "", ...(request.attributes || {}) };
  return {
    tag: "template",
    text: null,
    attributes: { facingAttribute: "facing" },
    children: Object.entries(values).map(([name, value]) => ({
      tag: "attribute",
      text: null,
      attributes: {
        name,
        label: name === "label" ? "标签" : "方向",
        value,
        editable: "true",
      },
      children: [],
    })),
  };
};
const queueDoc = { ...doc("Q"), revision: "q1", circuits: [circuit("main")] };
const queuedCalls: any[] = [];
const queuedGates: ReturnType<typeof defer>[] = [];
let queueState: ReturnType<typeof usePlacement>;
let singleCancel = 0;
function QueueHarness() {
  const [d, setDoc] = useState<any>(queueDoc);
  const tool = { name: "Pin", library: "0", label: "Pin" };
  const p = usePlacement(d, d.circuits[0], tool);
  queueState = p;
  return (
    <>
      <PlacementInspector placement={p} />
      <Canvas
        doc={d}
        circuit={d.circuits[0]}
        tool="select"
        selection={[]}
        setSelection={() => {}}
        place={tool}
        placement={p}
        onCancelPlace={() => {
          singleCancel++;
        }}
        onPlace={async (revision, edit) => {
          queuedCalls.push({ revision, edit });
          const gate = defer();
          queuedGates.push(gate);
          const result: any = await gate.promise;
          if (result instanceof Error) throw result;
          setDoc(result);
          return result;
        }}
        edit={async () => {
          throw new Error("Unexpected structural edit before placement");
        }}
        run={null}
        live={null}
        pending={[]}
        pressed={null}
        onPoke={() => {}}
        onPress={() => {}}
        onRelease={() => {}}
        onError={(e) => errors.push(e)}
        fitToken={0}
        onOpenMemory={() => {}}
        onEnterCircuit={() => {}}
      />
    </>
  );
}
const setPlacementLabel = async (value: string) => {
  const el = document.querySelector<HTMLInputElement>(
    'input[aria-label="标签"]',
  )!;
  assert.ok(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    document
      .querySelector(".placement-inspector form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await settle();
};
await render(<QueueHarness />);
await setPlacementLabel("invalid");
assert.match(
  document.querySelector(".placement-inspector [role=alert]")!.textContent!,
  /标签无效/,
);
assert.equal(
  document.querySelector<HTMLInputElement>('input[aria-label="标签"]')!.value,
  "invalid",
);
await setPlacementLabel("Alpha");
assert.equal(document.querySelector(".placement-inspector [role=alert]"), null);
assert.equal(queuedCalls.length, 0);
await pointer("pointerdown", 200);
await setPlacementLabel("Beta");
await pointer("pointerdown", 260);
assert.equal(queuedCalls.length, 1);
assert.equal(queuedCalls[0].edit.attributes.label, "Alpha");
assert.equal(
  document.querySelectorAll('[data-placement-state="pending"]').length,
  2,
);
await act(async () => {
  queuedGates[0].resolve({ ...queueDoc, revision: "q2" });
  await queuedGates[0].promise;
});
assert.equal(queuedCalls.length, 2);
assert.equal(queuedCalls[1].revision, "q2");
assert.equal(queuedCalls[1].edit.attributes.label, "Beta");
await act(async () => {
  const el = document.querySelector<HTMLInputElement>(
    'input[aria-label="标签"]',
  )!;
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!.call(el, "unsaved");
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await act(async () => {
  queuedGates[1].resolve({ ...queueDoc, revision: "q3" });
  await queuedGates[1].promise;
});
await act(async () => {
  await new Promise((r) => setTimeout(r, 110));
});
assert.equal(document.querySelectorAll("[data-placement-state]").length, 0);
assert.equal(
  document.querySelector<HTMLInputElement>('input[aria-label="标签"]')!.value,
  "unsaved",
);
await pointer("pointerdown", 320);
assert.equal(queuedCalls[2].edit.attributes.label, "Beta");
await pointer("pointerdown", 380);
assert.equal(queuedCalls.length, 3);
await act(async () => {
  queuedGates[2].resolve(new Error("revision changed"));
  await queuedGates[2].promise;
});
assert.equal(queuedCalls.length, 3);
assert.equal(document.querySelectorAll("[data-placement-state]").length, 0);
assert.match(String(errors.pop()), /后续 1 个元件未放置/);
await act(async () => queueState.setRepeat(false));
await pointer("pointerdown", 440);
assert.equal(singleCancel, 1);
await act(async () => {
  queuedGates[3].resolve({ ...queueDoc, revision: "q4" });
  await queuedGates[3].promise;
});
await act(async () => queueState.setRepeat(true));
await pointer("pointerdown", 500);
await pointer("pointerdown", 560);
assert.equal(queuedCalls.length, 5);
await render(<div />);
await act(async () => {
  queuedGates[4].resolve({ ...queueDoc, revision: "q5" });
  await queuedGates[4].promise;
});
assert.equal(queuedCalls.length, 5);
templateHandler = null;
console.log(
  "PASS: placement attributes remain editable after invalid input; queue preserves click attributes, revisions, ghosts and cancellation boundaries",
);

const sourceNative = {
  componentId: "native-source",
  factoryName: "Pin",
  selector: { label: "SOURCE" },
  location: { x: 100, y: 100 },
  bounds: { x: 80, y: 90, width: 20, height: 20 },
  ends: [
    {
      index: 0,
      location: { x: 100, y: 100 },
      width: 1,
      direction: "output",
      netBits: [{ bit: 0, netId: "net" }],
    },
  ],
};
const sinkNative = {
  componentId: "native-sink",
  factoryName: "Pin",
  selector: { label: "SINK" },
  location: { x: 300, y: 100 },
  bounds: { x: 300, y: 90, width: 20, height: 20 },
  ends: [
    {
      index: 0,
      location: { x: 300, y: 100 },
      width: 1,
      direction: "input",
      netBits: [{ bit: 0, netId: "net" }],
    },
  ],
};
observedFocus = {
  components: [sourceNative, sinkNative],
  wires: [
    {
      wireId: "native-wire",
      from: { x: 100, y: 100 },
      to: { x: 300, y: 100 },
      bundleId: "bundle",
    },
  ],
  wireBundles: [
    {
      bundleId: "bundle",
      valid: true,
      width: 1,
      wireIds: ["native-wire"],
      bitNets: [{ bit: 0, netId: "net" }],
    },
  ],
  bitNets: [
    {
      netId: "net",
      contacts: [
        { componentId: "native-source", endIndex: 0, bit: 0 },
        { componentId: "native-sink", endIndex: 0, bit: 0 },
      ],
    },
  ],
};
const traceDoc = {
  ...doc("A"),
  revision: "trace",
  circuits: [
    {
      ...circuit("main"),
      components: [
        { ...component, id: "src" },
        { ...component, id: "sink", location: { x: 300, y: 100 } },
      ],
      wires: [{ id: "wire", from: { x: 100, y: 100 }, to: { x: 300, y: 100 } }],
    },
  ],
};
let traceSelection: string[] = [];
function TraceHarness() {
  const [selection, setSelection] = useState<string[]>([]);
  const [panel, setPanel] = useState<any>(null);
  return (
    <>
      <Canvas
        doc={traceDoc as any}
        circuit={traceDoc.circuits[0]}
        tool="wire"
        selection={selection}
        setSelection={(s) => {
          traceSelection = s;
          setSelection(s);
        }}
        place={null}
        placement={noPlacement}
        onPlace={async () => traceDoc as any}
        onCancelPlace={() => {}}
        edit={async (e) => {
          edits.push(e);
        }}
        run={null}
        live={null}
        pending={[]}
        pressed={null}
        onPoke={() => {}}
        onPress={() => {}}
        onRelease={() => {}}
        onError={(e) => errors.push(e)}
        fitToken={0}
        onOpenMemory={() => {}}
        onEnterCircuit={() => {}}
        onSignalView={setPanel}
      />
      {panel}
    </>
  );
}
await render(<TraceHarness />);
const traceCanvas = document.querySelector(".canvas")!;
const beforeTrace = document
  .querySelector("svg[viewBox]")!
  .getAttribute("viewBox")!;
const [vx, vy, vw] = beforeTrace.split(" ").map(Number);
edits = [];
await act(async () =>
  traceCanvas.dispatchEvent(
    new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      ctrlKey: true,
      clientX: ((200 - vx) * 600) / vw,
      clientY: ((100 - vy) * 600) / vw,
    }),
  ),
);
assert.deepEqual(traceSelection, ["src"]);
assert.ok(document.querySelector('[aria-label="信号追踪"]'));
assert.equal(edits.length, 0);
await act(async () =>
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      bubbles: true,
    }),
  ),
);
assert.deepEqual(traceSelection, []);
assert.equal(
  document.querySelector("svg[viewBox]")!.getAttribute("viewBox"),
  beforeTrace,
);
assert.ok(!document.querySelector('[aria-label="信号追踪"]'));
observedFocus = null;
console.log(
  "PASS: Ctrl-click uses native bit connectivity without wiring, Alt-left restores camera and selection",
);
{
  // Pictures and connections the host refuses as stale re-read the workspace.
  const host = (globalThis as any).__command;
  const refused: string[] = [];
  let stales = 0;
  (globalThis as any).__command = async (request: any) => {
    if (
      (request.op === "symbols" || request.op === "connections") &&
      request.revision === "r3"
    ) {
      refused.push(request.op);
      throw {
        code: "STALE_REVISION",
        message: "电路已改变，请重新读取后再修改",
        retryable: false,
      };
    }
    return host(request);
  };
  // Read from the workspace: no edit reported its width conflicts.
  const staleDoc = {
    ...cd,
    revision: "r3",
    circuits: cd.circuits.map((c: any) => ({ ...c })),
  };
  const reported = errors.length;
  function StaleHarness() {
    const [selection, setSelection] = useState<string[]>([]);
    return (
      <Canvas
        doc={staleDoc as any}
        circuit={staleDoc.circuits[0]}
        tool="select"
        selection={selection}
        setSelection={setSelection}
        place={null}
        placement={noPlacement}
        onPlace={async () => staleDoc as any}
        onCancelPlace={() => {}}
        edit={async () => {}}
        run={null}
        live={null}
        pending={[]}
        pressed={null}
        onPoke={() => {}}
        onPress={() => {}}
        onRelease={() => {}}
        onError={(e) => errors.push(e)}
        onStale={() => stales++}
        fitToken={0}
        onOpenMemory={() => {}}
        onEnterCircuit={() => {}}
      />
    );
  }
  await render(<StaleHarness />);
  await pointer("pointerdown", 100);
  await pointer("pointerup", 100);
  await settle();
  assert.deepEqual(refused, ["symbols", "connections"]);
  assert.equal(stales, 2);
  assert.equal(errors.length, reported, "a stale read is not an error");
  (globalThis as any).__command = host;
  console.log(
    "PASS: a picture or connection read refused as stale re-reads the workspace instead of reporting an error",
  );
}
{
  // An edit answers with the width conflicts of the circuits it changed, so
  // the canvas draws the new revision without another request; a circuit
  // read from the workspace asks once.
  const host = (globalThis as any).__command;
  const asked: string[] = [];
  (globalThis as any).__command = async (request: any) => {
    if (request.op === "symbols") asked.push(request.revision);
    return host(request);
  };
  const read = {
    ...cd,
    revision: "w1",
    circuits: cd.circuits.map((c: any) => ({ ...c })),
  };
  await render(canvas(read));
  const edited = {
    ...cd,
    revision: "w2",
    circuits: read.circuits.map((c: any) => ({ ...c, wires: [...c.wires] })),
  };
  recordWidthErrors(edited.circuits, { main: [[100, 100]] });
  await render(canvas(edited));
  assert.deepEqual(asked, ["w1"]);
  (globalThis as any).__command = host;
  console.log(
    "PASS: an edit's answer brings its width conflicts; the canvas sends no request for the new revision",
  );
}
assert.equal(loadBindings({ palette: "a" }).palette, "A");
assert.match(bindingProblem("grid", "Mod+S", defaultBindings)!, /保存/);
assert.match(bindingProblem("grid", "Mod+Shift+S", defaultBindings)!, /另存为/);
assert.equal(
  eventBinding(
    new KeyboardEvent("keydown", { key: "h", ctrlKey: true, shiftKey: true }),
    false,
  ),
  "Mod+Shift+H",
);
assert.equal(
  eventBinding(
    new KeyboardEvent("keydown", { key: "h", isComposing: true }),
    false,
  ),
  null,
);
let customBindings = { ...defaultBindings };
await render(
  <ShortcutSettings
    bindings={customBindings}
    onChange={(next) => {
      customBindings = next;
    }}
    onClose={() => {}}
  />,
);
const gridKey = document.querySelector(
  'input[aria-label="显示 / 隐藏网格 快捷键"]',
)!;
await act(async () =>
  gridKey.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "h",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    }),
  ),
);
assert.equal(customBindings.grid, "Mod+Shift+H");
await click(
  [...document.querySelectorAll("button")].find(
    (n) => n.textContent === "恢复默认",
  )!,
);
assert.equal(customBindings.grid, "G");
console.log(
  "PASS: complete shortcut settings capture combinations, reject conflicts and restore defaults",
);
const providerCalls: any[] = [];
let saved = false;
const providerRequest = async (method: string, args: any) => {
  providerCalls.push({ method, args });
  return method === "discover"
    ? { ok: true, models: ["fixture-new"] }
    : { ok: true, elapsedMs: 12 };
};
await render(
  <ProviderSettings
    services={[]}
    provider={null}
    busy={false}
    request={providerRequest as any}
    onSaved={async () => {
      saved = true;
    }}
    onClose={() => {}}
  />,
);
await click(
  [...document.querySelectorAll("button")].find(
    (n) => n.textContent === "添加服务",
  )!,
);
await pickOption("服务类型", "自定义接口");
const field = (text: string) =>
  [...document.querySelectorAll("label")]
    .find((n) => n.firstChild?.textContent === text)!
    .querySelector("input")!;
const inputValue = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
assert.equal(
  document.querySelector('[role="checkbox"]')!.getAttribute("aria-checked"),
  "false",
);
await inputValue(field("接口地址"), "http://fixture.invalid/v1");
await inputValue(field("模型"), "fixture");
await click(
  [...document.querySelectorAll("button")].find(
    (n) => n.textContent === "读取模型列表",
  )!,
);
await click(document.querySelector('button[aria-label="展开接口模型"]')!);
assert.equal(
  document.querySelector('[role="option"]')!.textContent,
  "fixture-new",
);
await click(
  [...document.querySelectorAll("button")].find(
    (n) => n.textContent === "检测连接",
  )!,
);
assert.match(
  document.querySelector('[role="status"]')!.textContent!,
  /基本响应正常/,
);
await inputValue(
  document.querySelector('input[aria-label="上下文窗口"]')!,
  "128000",
);
await click(document.querySelector('[role="checkbox"]'));
await act(async () =>
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
);
assert.equal(saved, true);
assert.equal(providerCalls.at(-1).method, "configure");
assert.equal(providerCalls.at(-1).args.contextWindow, 128000);
assert.equal(providerCalls.at(-1).args.vision, true);
console.log(
  "PASS: provider discovery/probe and explicit context/image settings reach the configuration API",
);
await act(async () => root.unmount());
assert.deepEqual(errors, []);
await verifyRestoredInteractions();
await verifyFilesUI();
await verifyReferencesUI();
await verifyReferenceLinks();
await verifyDocumentHistory();
await verifyProjectInfoUI();
await verifyConversationSummaries();
await verifyConversationTurns();
await verifyAISettings();
await verifyEditorRequestLifetimes();
console.log("All focused UI lifecycle checks passed");

process.exit(0);
