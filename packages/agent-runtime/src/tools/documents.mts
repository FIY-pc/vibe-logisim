/**
 * Document-level tools: open_circuit, create_circuit, define_circuit and
 * undo_edit. They change which document is current for the rest of the turn
 * and tell the UI what to show.
 */
import * as path from "node:path";
import { CircuitToolError } from "./errors.mts";
import type { ToolContext } from "./context.mts";
import type { DocumentView, EditResult } from "../protocol/host.mts";

const summary = (context: ToolContext, view: DocumentView) => ({
  ...context.identity(view, view.main),
  name: view.name,
  main: view.main,
  circuits: view.circuits.map((c) => ({
    name: c.name,
    components: c.components.length,
    wires: c.wires.length,
  })),
  libraries: view.libraries.map((l) => l.id),
});

export async function openCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  const view = await context.resolveDocument(args.path);
  const circuit = context.circuitOf(view, args.circuit);
  return {
    ...summary(context, view),
    circuit,
    note: "已成为当前文档；后续工具省略 path 即作用于它。",
  };
}

export async function createCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  if (!/\.circ$/i.test(args.path))
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "电路文件名需要以 .circ 结尾：" + args.path,
    );
  const target = context.absolute(args.path);
  const status = await context.status();
  if (status.documents.some((d) => d.path === target))
    throw new CircuitToolError("INVALID_ARGUMENT", "文件已打开：" + args.path, {
      hint: "用 open_circuit 继续编辑它。",
    });
  try {
    await context.host.call({
      op: "folderCreate",
      folder_id: context.folder.id,
      path: path
        .relative(context.folder.path, target)
        .split(path.sep)
        .join("/"),
      directory: false,
    });
  } catch (error: any) {
    throw new CircuitToolError(
      "FILE_CREATE_FAILED",
      "无法新建文件：" + (error?.message ?? error),
      {
        hint: "父目录必须已存在，且同名文件不能已存在。",
      },
    );
  }
  const view = await context.resolveDocument(args.path);
  return {
    ...summary(context, view),
    note: "已新建并打开；定义 main 为空，可以直接放置元件。",
  };
}

export async function defineCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  let view = await context.resolveDocument(args.path);
  const base = view.revision;
  let last: EditResult | null = null;
  const step = async (circuit: string, edit: any) => {
    last = await context.host.call<EditResult>({
      op: "edit",
      id: view.id,
      revision: view.revision,
      circuit,
      edit,
    });
    view = last.view;
  };
  for (const name of args.add ?? [])
    await step(view.main, { kind: "addCircuit", name });
  for (const { from, to } of args.rename ?? []) {
    context.circuitOf(view, from);
    await step(from, { kind: "renameCircuit", name: to });
  }
  for (const name of args.remove ?? []) {
    context.circuitOf(view, name);
    await step(name, { kind: "deleteCircuit" });
  }
  if (args.main) {
    context.circuitOf(view, args.main);
    await step(args.main, { kind: "setMain" });
  }
  if (!last)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "请给出 add、rename、remove 或 main 中的至少一项。",
    );
  context.emit({
    type: "document-changed",
    document: view,
    expectedBaseRevision: base,
  });
  return summary(context, view);
}

export async function undoEdit(
  context: ToolContext,
  args: Record<string, any>,
) {
  const view = await context.resolveDocument(args.path);
  if (!view.canUndo)
    throw new CircuitToolError("NO_CHANGE", "没有可撤销的修改", {
      hint: "文档没有更早的版本。",
    });
  const result = await context.host.call<EditResult>({
    op: "undo",
    id: view.id,
    revision: view.revision,
  });
  context.emit({
    type: "document-changed",
    document: result.view,
    expectedBaseRevision: view.revision,
  });
  return {
    ...context.identity(result.view, result.circuit || result.view.main),
    title: result.title,
  };
}
