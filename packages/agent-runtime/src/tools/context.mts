/**
 * What every circuit tool needs from the turn it runs in: the host, the open
 * folder, a way to emit UI events, and the "current document" the tools fall
 * back to when no path is given. One ToolContext lives for one turn.
 *
 * Document resolution: `path` (folder-relative) → the open document with
 * that absolute path, else the host opens it (and the UI is told). No path →
 * the document last opened or created by a tool this turn, else the document
 * the user was looking at when they asked.
 */
import * as path from "node:path";
import { CircuitToolError } from "./errors.mts";
import { observationView, type ObservationView } from "./observe.mts";
import type { Edit } from "../generated/Edit.ts";
import type {
  DocumentView,
  EditResult,
  HostClient,
  HostFolder,
  HostStatus,
} from "../protocol/host.mts";
import type { RuntimeEvent } from "../protocol/messages.mts";

export interface ToolContextOptions {
  host: HostClient;
  folder: HostFolder;
  emit: (event: RuntimeEvent) => void;
  /** Throws once the turn is stopped or superseded; every tool calls it before and after host work. */
  assertCurrent: () => void;
  /** The document and definition the user was looking at when they asked, if any. */
  userDocumentId: string | null;
  userCircuit: string | null;
}

/** One native observation plus the document it describes. */
export interface Observed {
  view: ObservationView;
  /** The raw host `observe` result (focus, project, unknowns, runtime, artifactSha256, coverage). */
  raw: any;
  document: DocumentView;
}

export class ToolContext {
  readonly host: HostClient;
  readonly folder: HostFolder;
  readonly emit: (event: RuntimeEvent) => void;
  readonly assertCurrent: () => void;
  /** The document tools work on when no path is given. */
  currentDocumentId: string | null;
  /** The definition tools work on when no circuit is given (only meaningful for the user's document). */
  private readonly userCircuit: string | null;
  private readonly userDocumentId: string | null;

  constructor(options: ToolContextOptions) {
    this.host = options.host;
    this.folder = options.folder;
    this.emit = options.emit;
    this.assertCurrent = options.assertCurrent;
    this.userDocumentId = options.userDocumentId;
    this.userCircuit = options.userCircuit;
    this.currentDocumentId = options.userDocumentId;
  }

  status(): Promise<HostStatus> {
    return this.host.call<HostStatus>({ op: "status" });
  }

  /** Folder-relative path → absolute path inside the folder, or INVALID_ARGUMENT. */
  absolute(relative: string): string {
    const target = path.resolve(this.folder.path, relative);
    const root = path.resolve(this.folder.path);
    if (target !== root && !target.startsWith(root + path.sep))
      throw new CircuitToolError(
        "INVALID_ARGUMENT",
        "路径不在工程文件夹内：" + relative,
        {
          hint: "path 相对于打开的工程文件夹，例如 cpu.circ 或 lib/alu.circ。",
        },
      );
    return target;
  }

  /**
   * The document a tool works on. With `relative`, an open document at that
   * path or a freshly opened one (then the UI shows it); without, the current
   * document. Always re-read from the host so the revision is fresh.
   */
  async resolveDocument(relative?: string | null): Promise<DocumentView> {
    const status = await this.status();
    if (relative) {
      const target = this.absolute(relative);
      const open = status.documents.find((d) => d.path === target);
      if (open) {
        this.currentDocumentId = open.id;
        return open;
      }
      const view = await this.host.call<DocumentView>({
        op: "open",
        path: target,
      });
      this.currentDocumentId = view.id;
      this.emit({ type: "document-opened", document: view });
      return view;
    }
    const id = this.currentDocumentId ?? status.active;
    const current = id ? status.documents.find((d) => d.id === id) : undefined;
    if (!current)
      throw new CircuitToolError("NO_DOCUMENT_OPEN", "当前没有打开的电路文件", {
        hint: "给出 path 打开文件夹里的 .circ，或用 create_circuit 新建。",
      });
    this.currentDocumentId = current.id;
    return current;
  }

  /** The definition a tool works on: the named one, else the user's current one, else main. */
  circuitOf(view: DocumentView, name?: string | null): string {
    const circuit =
      name ||
      (view.id === this.userDocumentId && this.userCircuit
        ? this.userCircuit
        : null) ||
      view.main ||
      null;
    if (!circuit)
      throw new CircuitToolError("NO_CIRCUIT_OPEN", "当前文件没有电路定义", {
        hint: "用 define_circuit 添加定义，或指定 circuit。",
      });
    if (!view.circuits.some((c) => c.name === circuit))
      throw new CircuitToolError(
        "CIRCUIT_NOT_FOUND",
        "电路定义不存在：" + circuit,
        {
          hint: "可用的定义：" + view.circuits.map((c) => c.name).join("、"),
          context: { availableCircuits: view.circuits.map((c) => c.name) },
        },
      );
    return circuit;
  }

  /** Resolves document and definition together; most tools start here. */
  async target(args: { path?: string | null; circuit?: string | null }) {
    const document = await this.resolveDocument(args.path);
    const circuit = this.circuitOf(document, args.circuit);
    return { document, circuit };
  }

  /** The native observation of one definition at the document's current revision. */
  async observe(document: DocumentView, circuit: string): Promise<Observed> {
    const raw = await this.host.call({
      op: "observe",
      id: document.id,
      revision: document.revision,
      circuit,
    });
    this.assertCurrent();
    return { view: observationView(raw), raw, document };
  }

  /**
   * Applies edits one after another, each on the revision the previous one
   * produced, and tells the UI once. Returns the last result; `noop` edits
   * are reported, not hidden.
   */
  async edit(
    document: DocumentView,
    circuit: string,
    edits: Edit[],
  ): Promise<{ result: EditResult; results: EditResult[] }> {
    if (!edits.length)
      throw new CircuitToolError("INVALID_ARGUMENT", "没有可应用的修改", {
        hint: "请给出至少一个修改。",
      });
    const base = document.revision;
    let revision = base;
    let last: EditResult | null = null;
    const results: EditResult[] = [];
    for (const edit of edits) {
      this.assertCurrent();
      const result = await this.host.call<EditResult>({
        op: "edit",
        id: document.id,
        revision,
        circuit,
        edit,
      });
      results.push(result);
      revision = result.revision;
      last = result;
    }
    this.emit({
      type: "document-changed",
      document: last!.view,
      expectedBaseRevision: base,
    });
    if (results.every((r) => r.noop))
      throw new CircuitToolError("NO_CHANGE", "修改没有改变任何内容", {
        hint: "确认元件 id、属性和位置来自同一次检查的当前内容。",
      });
    return { result: last!, results };
  }

  /** The identity every tool result starts with. */
  identity(document: DocumentView, circuit: string) {
    return {
      documentId: document.id,
      path: document.path
        ? path.relative(this.folder.path, document.path)
        : null,
      revision: document.revision,
      circuit,
    };
  }
}
