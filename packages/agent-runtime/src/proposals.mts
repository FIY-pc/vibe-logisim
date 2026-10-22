import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
export interface Proposal {
  type: "proposed-source";
  id: string;
  documentId: string;
  revision: string;
  original: string;
  xml: string;
  createdAt: number;
  /** Short summary shown in the review list. */
  title?: string;
}
interface WorkInput {
  projectId: string;
  revisionId: string;
  original: string;
}
interface Work extends WorkInput {
  workId: string;
}
export class ProposalStore {
  private state: string;
  private workDir: string;
  private pending: Promise<void> = Promise.resolve();
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action);
    this.pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  /** Title for the proposal the current turn will produce. */
  private title: string | null = null;
  constructor(state: string, workDir: string) {
    this.state = state;
    this.workDir = workDir;
  }
  setTitle(title: string | null) {
    this.title = title;
  }
  private directory() {
    return path.join(this.state, "proposals");
  }
  private manifest() {
    return path.join(this.state, "active-agent-work.json");
  }
  private file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("候选标识无效");
    return path.join(this.directory(), id + ".json");
  }
  private async readWork(): Promise<Work | null> {
    let work: Work;
    try {
      work = JSON.parse(await readFile(this.manifest(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("工作副本恢复信息无法读取，原内容已保留");
    }
    if (
      !work ||
      typeof work.projectId !== "string" ||
      typeof work.revisionId !== "string" ||
      typeof work.original !== "string" ||
      typeof work.workId !== "string" ||
      !work.workId
    )
      throw new Error("工作副本恢复信息无效，原内容已保留");
    return work;
  }
  recover(): Promise<Proposal | null> {
    return this.exclusive(() => this.recoverUnlocked());
  }
  private async recoverUnlocked(): Promise<Proposal | null> {
    const work = await this.readWork();
    return work ? this.finishUnlocked(work) : null;
  }
  workingCopy(documentId: string) {
    return this.exclusive(async () => {
      const work = await this.readWork();
      if (!work || work.projectId !== documentId)
        throw new Error("工作副本不属于当前回合，请重新读取电路");
      return {
        id: work.projectId,
        revision: work.revisionId,
        original: work.original,
        xml: await readFile(path.join(this.workDir, "circuit.circ"), "utf8"),
      };
    });
  }
  prepare(work: WorkInput): Promise<Work> {
    return this.exclusive(async () => {
      await this.recoverUnlocked();
      const prepared = { ...work, workId: randomUUID() };
      // Persist the turn identity before any model can edit this scratch copy.
      await writeFile(
        path.join(this.workDir, "circuit.circ"),
        prepared.original,
      );
      const temp = this.manifest() + ".tmp";
      await writeFile(temp, JSON.stringify(prepared), { mode: 0o600 });
      await rename(temp, this.manifest());
      return prepared;
    });
  }
  finish(work: Work): Promise<Proposal | null> {
    return this.exclusive(() => this.finishUnlocked(work));
  }
  private async finishUnlocked(work: Work): Promise<Proposal | null> {
    const active = await this.readWork();
    if (!active) return null;
    if (
      active.workId !== work.workId ||
      active.projectId !== work.projectId ||
      active.revisionId !== work.revisionId ||
      active.original !== work.original
    )
      throw new Error("工作副本已属于另一回合，迟到的收束请求未修改任何文件");
    const xml = await readFile(path.join(this.workDir, "circuit.circ"), "utf8");
    const title = this.title;
    this.title = null;
    let proposal: Proposal | null = null;
    if (xml !== work.original) {
      await mkdir(this.directory(), { recursive: true });
      // Repeated recovery after an interrupted acknowledgement is idempotent.
      const existing = (await this.list(work.projectId)).find(
        (p) =>
          p.revision === work.revisionId &&
          p.xml === xml &&
          p.original === work.original,
      );
      proposal = existing || {
        type: "proposed-source",
        id: randomUUID(),
        documentId: work.projectId,
        revision: work.revisionId,
        original: work.original,
        xml,
        createdAt: Date.now(),
        ...(title ? { title } : {}),
      };
      if (!existing) {
        const temp = this.file(proposal.id) + ".tmp";
        await writeFile(temp, JSON.stringify(proposal), { mode: 0o600 });
        await rename(temp, this.file(proposal.id));
      }
    }
    await rm(this.manifest(), { force: true });
    return proposal;
  }
  async list(documentId: string): Promise<Proposal[]> {
    let files: string[];
    try {
      files = await readdir(this.directory());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const all = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(
          async (file) =>
            JSON.parse(
              await readFile(path.join(this.directory(), file), "utf8"),
            ) as Proposal,
        ),
    );
    return all
      .filter((p) => p.documentId === documentId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async discard(documentId: string, id: string) {
    const file = this.file(id);
    let proposal: Proposal;
    try {
      proposal = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (proposal.documentId !== documentId)
      throw new Error("候选属于另一电路文档");
    await rm(file);
  }
}
