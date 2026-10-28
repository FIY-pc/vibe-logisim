/**
 * What every circuit tool needs from the turn it runs in: the host, the open
 * folder, a way to emit UI events, and the "current document" the tools fall
 * back to when no path is given. One ToolContext lives for one turn.
 *
 * Document resolution: `path` (folder-relative) → the open document with
 * that absolute path, else the host opens it (and the UI is told). No path →
 * the document last opened or created by a tool this turn, else the document
 * the user was looking at when they asked. An open document whose file
 * changed underneath it (a shell command or write_file rewrote it, the user
 * saved it from another program) is read again first unless it has unsaved
 * changes, so the tools always work on the file as it is.
 */
import * as path from "node:path";
import { CircuitToolError } from "./errors.mts";
import { observationView, type ObservationView } from "./observe.mts";
import type { Edit } from "../generated/Edit.ts";
import type { SourceStatus } from "../generated/SourceStatus.ts";
import type {
  DocumentSummary,
  DocumentView,
  EditResult,
  HostClient,
  HostFolder,
  HostStatus,
  Request,
} from "../protocol/host.mts";
import type { RuntimeEvent } from "../protocol/messages.mts";
import {
  applyDocumentChange,
  combineChanges,
} from "../protocol/document-change.ts";

/** Edits the host applies together as one change. */
const BATCHED = new Set<Edit["kind"]>([
  "wire",
  "place",
  "delete",
  "attributes",
]);

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

/** What a tool needs to address a document at one revision. */
export interface DocumentRef {
  id: string;
  path: string | null;
  revision: string;
}

/** One native observation plus the document it describes. */
export interface Observed {
  view: ObservationView;
  /** The raw host `observe` result (focus, project, unknowns, runtime, artifactSha256, coverage). */
  raw: any;
  document: DocumentRef;
}

/** Edits applied by one tool call: the results, and the whole view after the last. */
export interface Applied {
  result: EditResult;
  results: EditResult[];
  view: DocumentView;
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
  /** The whole view of each document this turn worked on, at the revision it
   * last saw. Edits take their changes into it, so a tool reads a whole view
   * again only after the document changed outside the turn. */
  private readonly views = new Map<string, DocumentView>();

  constructor(options: ToolContextOptions) {
    this.host = options.host;
    this.folder = options.folder;
    this.emit = options.emit;
    this.assertCurrent = options.assertCurrent;
    this.userDocumentId = options.userDocumentId;
    this.userCircuit = options.userCircuit;
    this.currentDocumentId = options.userDocumentId;
  }

  /** The open documents without their circuits' content, the active one and the folder. */
  status(): Promise<HostStatus> {
    return this.host.call<HostStatus>({ op: "status", summary: true });
  }

  /** The whole view of an open document at its current revision. */
  private async view(document: DocumentSummary): Promise<DocumentView> {
    const known = this.views.get(document.id);
    if (known?.revision === document.revision) return known;
    const view = await this.host.call<DocumentView>({
      op: "read",
      id: document.id,
    });
    this.views.set(view.id, view);
    return view;
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
   * document. Always re-read from the host so the revision is fresh, and
   * read again from its file when that changed (see `fromFile`).
   */
  async resolveDocument(relative?: string | null): Promise<DocumentView> {
    const status = await this.status();
    if (relative) {
      const target = this.absolute(relative);
      const open = status.documents.find((d) => d.path === target);
      if (open) {
        this.currentDocumentId = open.id;
        return this.fromFile(open);
      }
      const view = await this.host.call<DocumentView>({
        op: "open",
        path: target,
      });
      this.views.set(view.id, view);
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
    return this.fromFile(current);
  }

  /**
   * An open document as its file is: when the file changed underneath it
   * (write_file, a shell command, another program) and it has no unsaved
   * changes, the host reads it again (the previous content stays in undo
   * history) and the UI is told the whole document changed. A document with
   * unsaved changes is used as it is; the UI shows the user the file notice.
   */
  private async fromFile(open: DocumentSummary): Promise<DocumentView> {
    const view = await this.view(open);
    if (!view.path || view.dirty) return view;
    const source = await this.host.call<SourceStatus>({
      op: "sourceStatus",
      id: view.id,
    });
    if (source.state !== "modified") return view;
    const reloaded = await this.host.call<DocumentView>({
      op: "reload",
      id: view.id,
      revision: view.revision,
      source_revision: source.revision,
      discard: false,
    });
    this.views.set(reloaded.id, reloaded);
    const { circuits, ...fields } = reloaded;
    this.emit({
      type: "document-changed",
      change: {
        ...fields,
        base: view.revision,
        order: circuits.map((c) => c.name),
        circuits,
      },
    });
    return reloaded;
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
  async observe(document: DocumentRef, circuit: string): Promise<Observed> {
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
   * Sends edit, undo or redo requests one after another, each on the
   * revision the previous one made, and tells the UI once what they changed
   * together. Returns the results and the whole view after the last.
   */
  async send(
    document: DocumentRef,
    requests: ((revision: string) => Request)[],
  ): Promise<Applied> {
    let revision = document.revision;
    let view = this.views.get(document.id);
    const results: EditResult[] = [];
    try {
      for (const request of requests) {
        this.assertCurrent();
        const result = await this.host.call<EditResult>(request(revision));
        results.push(result);
        revision = result.revision;
        view = applyDocumentChange(view, result.change) ?? undefined;
      }
    } finally {
      if (results.length)
        this.emit({
          type: "document-changed",
          change: combineChanges(results.map((r) => r.change)),
        });
    }
    if (!view)
      view = await this.host.call<DocumentView>({
        op: "read",
        id: document.id,
      });
    if (view.revision === revision) this.views.set(view.id, view);
    return { result: results[results.length - 1], results, view };
  }

  /**
   * Applies edits. Wire, place, delete and attribute edits go to the host as
   * one batch (one undo step, one native load), and so do moves by different
   * offsets (one undo step, nothing moved when one is refused); anything else
   * is applied one after another. `noop` edits are reported, not hidden.
   */
  async edit(
    document: DocumentRef,
    circuit: string,
    edits: Edit[],
  ): Promise<Applied> {
    if (!edits.length)
      throw new CircuitToolError("INVALID_ARGUMENT", "没有可应用的修改", {
        hint: "请给出至少一个修改。",
      });
    const batch =
      edits.length > 1 &&
      (edits.every((e) => BATCHED.has(e.kind)) ||
        edits.every((e) => e.kind === "move"));
    const applied = await this.send(
      document,
      (batch ? [{ kind: "batch", edits } as Edit] : edits).map(
        (edit) => (revision) => ({
          op: "edit",
          id: document.id,
          revision,
          circuit,
          edit,
        }),
      ),
    );
    if (applied.results.every((r) => r.noop))
      throw new CircuitToolError("NO_CHANGE", "修改没有改变任何内容", {
        hint: "确认元件 id、属性和位置来自同一次检查的当前内容。",
      });
    return applied;
  }

  /** The identity every tool result starts with. */
  identity(document: DocumentRef, circuit: string) {
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
