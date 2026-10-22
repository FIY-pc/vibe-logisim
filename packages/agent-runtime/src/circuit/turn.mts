/**
 * One AI turn's view of the open circuit file: which document is bound, the
 * scratch copy the model edits, and the host calls that connect them.
 */
import { createHash } from "node:crypto";
import { ProposalStore } from "../proposals.mts";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSession } from "./action-result.mts";

type Host = (request: Record<string, unknown>) => Promise<any>;

export interface Binding {
  id: string;
  revision: string;
  workspaceKey?: string;
  folderId?: string | null;
  activeFile?: string | null;
  circuit?: string | null;
}

export const CANDIDATE = /^candidate-[0-9a-f]{16}$/;
/** Candidate ids are the first 16 hex digits of the text they stand for. */
export const candidateId = (xml: string) =>
  "candidate-" +
  createHash("sha256").update(xml, "utf8").digest("hex").slice(0, 16);
export const artifactSha256 = (xml: string) =>
  createHash("sha256").update(xml, "utf8").digest("hex");

/** The working copy's current text and the revision it was created from. */
export interface WorkingCopy {
  id: string;
  revision: string;
  original: string;
  xml: string;
}

export class Turn {
  private host: Host;
  private proposals: ProposalStore;
  private binding: () => Binding;
  private workDir: string;
  constructor(
    host: Host,
    proposals: ProposalStore,
    binding: () => Binding,
    workDir: string,
  ) {
    this.host = host;
    this.proposals = proposals;
    this.binding = binding;
    this.workDir = workDir;
  }
  /** Name the proposal this turn will produce. */
  setTitle(title: string) {
    this.proposals.setTitle(title);
  }
  /** Raw host call for the tools; keeps the bridge inside this module. */
  call(request: Record<string, unknown>) {
    return this.host(request);
  }
  get modelCwd() {
    return this.workDir;
  }
  /** The bound document, re-read so every call sees the current revision. */
  async session(): Promise<AgentSession> {
    const binding = this.binding();
    if (!binding?.id) throw new Error("没有活动电路");
    return this.read(binding.id);
  }
  async read(id: string): Promise<AgentSession> {
    const [document, status] = await Promise.all([
      this.host({ op: "read", id }),
      this.host({ op: "status" }),
    ]);
    const folder = status.folder;
    const active = status.documents.find((d: any) => d.id === id);
    const path: string | null = active?.path ?? null;
    const inside =
      folder && path
        ? path === folder.path || path.startsWith(folder.path + "/")
        : false;
    const circuits: string[] = document.circuits.map((c: any) => c.name);
    const binding = this.binding();
    return {
      folderId: folder?.id ?? null,
      documentId: document.id,
      revision: document.revision,
      artifactSha256: document.revision,
      activeFile: path,
      project: { circuits, mainCircuit: document.main ?? null },
      activeCircuit:
        binding?.circuit && circuits.includes(binding.circuit)
          ? binding.circuit
          : (document.main ?? null),
      canvas: {
        status: "shown",
        circuit:
          binding?.circuit && circuits.includes(binding.circuit)
            ? binding.circuit
            : (document.main ?? null),
      },
      saveState: {
        currentRevisionId: document.revision,
        savedRevisionId: document.dirty ? null : document.revision,
        dirty: document.dirty ?? false,
        canSave: inside,
      },
      sourceStatus: document.sourceStatus ?? null,
      previousRevision: null,
      baselines: {},
    } as AgentSession;
  }
  /** Select `path` if given, then re-read the bound document. */
  async sync({ path }: { path?: string; navigate?: boolean } = {}) {
    if (path) {
      const status = await this.host({ op: "status" });
      const match = status.documents.find((d: any) => d.path === path);
      if (!match) throw new Error("电路文件尚未打开：" + path);
      await this.host({ op: "activate", id: match.id });
      this.binding().id = match.id;
      this.binding().revision = match.revision;
    }
    return this.session();
  }
  async navigate(circuit: string | null) {
    const binding = this.binding();
    binding.circuit = circuit;
    const session = await this.session();
    return session.canvas ?? { status: "unavailable", circuit: null };
  }
  async workingCopy(): Promise<WorkingCopy> {
    const binding = this.binding();
    return this.proposals.workingCopy(binding.id);
  }
  /** Write a candidate's text into the working copy. The next tool reads it. */
  async writeWorkingCopy(xml: string) {
    await this.proposals.workingCopy(this.binding().id);
    await writeFile(path.join(this.workDir, "circuit.circ"), xml);
    return { candidateId: candidateId(xml), artifactSha256: artifactSha256(xml) };
  }
  /**
   * Move a candidate into the open file. In review mode the working copy is
   * already the candidate the turn will offer, so this only re-reads it.
   */
  async checkout(id: string) {
    if (!CANDIDATE.test(id)) throw new Error("候选标识无效");
    const copy = await this.workingCopy();
    if (candidateId(copy.xml) !== id)
      throw new Error("候选已被后续修改取代；用最新的 artifactSha256 重新检查。");
    return this.session();
  }
  resolveFile(relative: string) {
    return relative;
  }
}
