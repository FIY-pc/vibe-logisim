/**
 * Document-level tools: open_circuit, create_circuit, define_circuit and
 * undo_edit. They change which document is current for the rest of the turn.
 */
import * as path from "node:path";
import { CircuitToolError } from "./errors.mts";
import type { DocumentRef, ToolContext } from "./context.mts";

const summary = (context: ToolContext, document: DocumentRef) => ({
  ...context.identity(document, document.main),
  name: document.name,
  main: document.main,
  // Counts for the definitions this call read; the rest are named only.
  circuits: document.order.map((name) => {
    const circuit = document.circuits.find((c) => c.name === name);
    return circuit
      ? {
          name,
          components: circuit.components.length,
          wires: circuit.wires.length,
        }
      : { name };
  }),
  libraries: document.libraries.map((l) => l.id),
});

export async function openCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  const document = await context.resolveDocument(args.path, true);
  const circuit = context.circuitOf(document, args.circuit);
  return {
    ...summary(context, document),
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
      // The turn's checkpoint records the new file with everything else.
      checkpoint: false,
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
  const document = await context.resolveDocument(args.path);
  return {
    ...summary(context, document),
    note: "已新建并打开；定义 main 为空，可以直接放置元件。",
  };
}

export async function defineCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  let document = await context.resolveDocument(args.path);
  let steps = 0;
  const step = async (circuit: string, edit: any) => {
    const applied = await context.send(document, [
      (revision) => ({ op: "edit", id: document.id, revision, circuit, edit }),
    ]);
    document = applied.change;
    steps++;
  };
  for (const name of args.add ?? [])
    await step(document.main, { kind: "addCircuit", name });
  for (const { from, to } of args.rename ?? []) {
    context.circuitOf(document, from);
    await step(from, { kind: "renameCircuit", name: to });
  }
  for (const name of args.remove ?? []) {
    context.circuitOf(document, name);
    await step(name, { kind: "deleteCircuit" });
  }
  if (args.main) {
    context.circuitOf(document, args.main);
    await step(args.main, { kind: "setMain" });
  }
  if (!steps)
    throw new CircuitToolError(
      "INVALID_ARGUMENT",
      "请给出 add、rename、remove 或 main 中的至少一项。",
    );
  return summary(context, document);
}

export async function undoEdit(
  context: ToolContext,
  args: Record<string, any>,
) {
  const document = await context.resolveDocument(args.path);
  if (!document.canUndo)
    throw new CircuitToolError("NO_CHANGE", "没有可撤销的修改", {
      hint: "文档没有更早的版本。",
    });
  const { result, change } = await context.send(document, [
    (revision) => ({ op: "undo", id: document.id, revision }),
  ]);
  return {
    ...context.identity(change, result.circuit || change.main),
    title: result.title,
  };
}
