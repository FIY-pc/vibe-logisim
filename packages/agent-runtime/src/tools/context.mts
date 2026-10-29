/**
 * What every circuit tool gets from the turn it runs in: the host, the open
 * folder, a way to emit UI events, and the "current document" the tools fall
 * back to when no path is given. One ToolContext lives for one turn.
 *
 * It holds no document. The host owns the files and the open documents and
 * keeps every open document equal to its file (see
 * `crates/workbench-host/README.md`, Files are the truth); a tool reads the
 * document's fields through `read {circuits: []}`, works with that revision,
 * and gets the new revision back in the reply. Nothing is cached between
 * calls except which document id is open at which path.
 *
 * Document resolution: `path` (folder-relative) → the open document at that
 * absolute path, else the host opens it; no path → the document last opened
 * or created by a tool this turn, else the document the user was looking at
 * when they asked.
 */
import * as path from "node:path";
import { CircuitToolError } from "./errors.mts";
import { observationView, type ObservationView } from "./observe.mts";
import type { Edit } from "../generated/Edit.ts";
import type {
  DocumentChange,
  DocumentView,
  EditResult,
  HostClient,
  HostFolder,
  HostStatus,
  Request,
} from "../protocol/host.mts";
import type { RuntimeEvent } from "../protocol/messages.mts";

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
  /** The open documents at the start of the turn, so a path they cover is not opened again. */
  documents?: { id: string; path: string | null }[];
}

/**
 * An open document at one revision: the fields a tool addresses it by, the
 * definition order, and the content of the definitions the call asked for.
 */
export type DocumentRef = DocumentChange;

/** A whole view as a `DocumentRef` holding every definition. */
const whole = (view: DocumentView): DocumentRef => ({
  ...view,
  base: view.revision,
  order: view.circuits.map((c) => c.name),
});

/** One native observation plus the document it describes. */
export interface Observed {
  view: ObservationView;
  /** The raw host `observe` result (focus, project, unknowns, runtime, artifactSha256, coverage). */
  raw: any;
  document: DocumentRef;
}

/** Edits applied by one tool call: every reply, the last one and its change (the document at the new revision). */
export interface Applied {
  result: EditResult & EditNotes;
  results: EditResult[];
  change: DocumentChange;
}

/** An edit reply's notes that the host sets beside the edit result. */
export interface EditNotes {
  saveError?: string;
  historyWarning?: string;
  referenceWarning?: string;
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
  /** Document ids of the files this turn met, by absolute path. */
  private readonly byPath = new Map<string, string>();

  constructor(options: ToolContextOptions) {
    this.host = options.host;
    this.folder = options.folder;
    this.emit = options.emit;
    this.assertCurrent = options.assertCurrent;
    this.userDocumentId = options.userDocumentId;
    this.userCircuit = options.userCircuit;
    this.currentDocumentId = options.userDocumentId;
    for (const document of options.documents ?? []) this.remember(document);
  }

  /** The open documents without their circuits' content, the active one and the folder. */
  status(): Promise<HostStatus> {
    return this.host.call<HostStatus>({ op: "status", summary: true });
  }

  /**
   * An open document as it is now: its fields and those definitions'
   * content (all of them when `circuits` is omitted). The host has looked at
   * the file first (every document request does), so this is the file's
   * content at its current revision.
   */
  async read(id: string, circuits?: string[]): Promise<DocumentRef> {
    const document = circuits
      ? await this.host.call<DocumentChange>({ op: "read", id, circuits })
      : whole(await this.host.call<DocumentView>({ op: "read", id }));
    this.remember(document);
    return document;
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

  private remember(document: { id: string; path: string | null }) {
    if (document.path) this.byPath.set(document.path, document.id);
  }

  /**
   * The document a tool works on: with `relative`, the open document at that
   * path, else the host opens it; without, the current document. One host
   * request: the document's fields (with every definition's content when
   * `all`, or when the file had to be opened).
   */
  async resolveDocument(
    relative?: string | null,
    all = false,
  ): Promise<DocumentRef> {
    const content = all ? undefined : [];
    if (relative) {
      const target = this.absolute(relative);
      const known = this.byPath.get(target);
      const document =
        (known && (await this.readOpen(known, content))) ||
        (await this.open(target));
      this.currentDocumentId = document.id;
      return document;
    }
    const id = this.currentDocumentId ?? (await this.status()).active;
    if (!id)
      throw new CircuitToolError("NO_DOCUMENT_OPEN", "当前没有打开的电路文件", {
        hint: "给出 path 打开文件夹里的 .circ，或用 create_circuit 新建。",
      });
    this.currentDocumentId = id;
    return this.read(id, content);
  }

  /** `read`, or null when the document has been closed since. */
  private async readOpen(id: string, circuits?: string[]) {
    try {
      return await this.read(id, circuits);
    } catch (error: any) {
      if (error?.code === "DOCUMENT_NOT_FOUND") return null;
      throw error;
    }
  }

  /** Opens the file at an absolute path (the open document, if it is open) with every definition. */
  private async open(target: string): Promise<DocumentRef> {
    const document = whole(
      await this.host.call<DocumentView>({ op: "open", path: target }),
    );
    this.remember(document);
    return document;
  }

  /** The definition a tool works on: the named one, else the user's current one, else main. */
  circuitOf(document: DocumentRef, name?: string | null): string {
    const circuit =
      name ||
      (document.id === this.userDocumentId && this.userCircuit
        ? this.userCircuit
        : null) ||
      document.main ||
      null;
    if (!circuit)
      throw new CircuitToolError("NO_CIRCUIT_OPEN", "当前文件没有电路定义", {
        hint: "用 define_circuit 添加定义，或指定 circuit。",
      });
    if (!document.order.includes(circuit))
      throw new CircuitToolError(
        "CIRCUIT_NOT_FOUND",
        "电路定义不存在：" + circuit,
        {
          hint: "可用的定义：" + document.order.join("、"),
          context: { availableCircuits: document.order },
        },
      );
    return circuit;
  }

  /**
   * Resolves document and definition together; most tools start here. One
   * host request: the document's fields.
   */
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
   * revision the previous one made. The host broadcasts what they changed.
   */
  async send(
    document: DocumentRef,
    requests: ((revision: string) => Request)[],
  ): Promise<Applied> {
    let revision = document.revision;
    const results: (EditResult & EditNotes)[] = [];
    for (const request of requests) {
      this.assertCurrent();
      const result = await this.host.call<EditResult & EditNotes>(
        request(revision),
      );
      results.push(result);
      revision = result.revision;
    }
    const last = results[results.length - 1];
    return { result: last, results, change: last.change };
  }

  /**
   * Applies edits. Wire, place, delete and attribute edits go to the host as
   * one batch (one undo step, one native load), and so do moves by different
   * offsets (one undo step, nothing moved when one is refused); anything else
   * is applied one after another. Edits that change nothing are reported on
   * the result, not raised.
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
    return this.send(
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
  }

  /** The identity every tool result starts with. */
  identity(document: { id: string; path: string | null; revision: string }, circuit: string) {
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
