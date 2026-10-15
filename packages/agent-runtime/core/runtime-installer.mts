import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
export interface RuntimeSpec {
  sha256: string;
  programs: string[];
  version: string;
  url: string;
}
export interface InstallState {
  phase:
    | "missing"
    | "ready"
    | "downloading"
    | "verifying"
    | "extracting"
    | "cancelled"
    | "error";
  received: number;
  total: number | null;
  error: string | null;
}
interface InstallerOptions {
  spec: RuntimeSpec;
  directory: string;
  fetch?: typeof fetch;
  extract: (
    archive: string,
    target: string,
    signal: AbortSignal,
  ) => Promise<void>;
  timeoutMs?: number;
}
const ACTIVE = new Set(["downloading", "verifying", "extracting"]);

// Owns only the pinned optional runtime, never account profiles or conversations.
class RuntimeInstaller extends EventEmitter {
  declare stagingPrefix: string;
  declare spec: RuntimeSpec;
  declare directory: string;
  declare fetch: typeof fetch;
  declare timeoutMs: number;
  declare extract: InstallerOptions["extract"];
  declare state: InstallState;
  declare controller: AbortController | null;
  declare pending: Promise<string> | null;

  constructor({
    spec,
    directory,
    fetch = globalThis.fetch,
    extract,
    timeoutMs = 20 * 60 * 1000,
  }: InstallerOptions) {
    super();
    if (
      !/^[a-f0-9]{64}$/.test(spec.sha256) ||
      !Array.isArray(spec.programs) ||
      !spec.programs.length ||
      spec.programs.some((p: any) => p.includes("..") || path.isAbsolute(p))
    )
      throw new Error("运行时清单无效");
    Object.assign(this, { spec, directory, fetch, timeoutMs });
    this.stagingPrefix = ".install-" + spec.sha256.slice(0, 16) + "-";
    if (typeof extract !== "function")
      throw new Error("Runtime extraction adapter is required");
    this.extract = extract;
    this.state = {
      phase: this.ready() ? "ready" : "missing",
      received: 0,
      total: null,
      error: null,
    };
  }
  ready() {
    try {
      const receipt = JSON.parse(
        fs.readFileSync(path.join(this.directory, "installed.json"), "utf8"),
      );
      return (
        receipt.sha256 === this.spec.sha256 &&
        this.spec.programs.every((name: any) => {
          const file = path.join(this.directory, name);
          fs.accessSync(
            file,
            process.platform === "win32"
              ? fs.constants.F_OK
              : fs.constants.X_OK,
          );
          return fs.statSync(file).isFile();
        })
      );
    } catch {
      return false;
    }
  }
  snapshot() {
    return {
      ...this.state,
      version: this.spec.version,
      busy: ACTIVE.has(this.state.phase),
    };
  }
  update(patch: Partial<InstallState>) {
    Object.assign(this.state, patch);
    this.emit("change", this.snapshot());
  }
  async cleanAbandoned() {
    // The desktop holds a single-instance lock. Remove only staging owned by
    // this exact pinned runtime after a crash; never touch profiles or siblings.
    const parent = path.dirname(this.directory);
    const entries = await fsp.readdir(parent).catch((error: any) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of entries)
      if (name.startsWith(this.stagingPrefix))
        await fsp.rm(path.join(parent, name), { recursive: true, force: true });
  }
  ensure() {
    if (this.pending) return this.pending;
    if (this.ready()) {
      this.update({ phase: "ready", error: null });
      return this.cleanAbandoned().then(() => this.directory);
    }
    this.controller = new AbortController();
    this.update({
      phase: "downloading",
      received: 0,
      total: null,
      error: null,
    });
    this.pending = this.install(this.controller.signal).finally(() => {
      this.pending = null;
      this.controller = null;
    });
    return this.pending;
  }
  async cancel() {
    this.controller?.abort();
    await this.pending?.catch(() => {});
  }
  async install(signal: AbortSignal) {
    let staging = null;
    const timer = setTimeout(
      () => this.controller?.abort(new Error("下载超时，请重试")),
      this.timeoutMs,
    );
    try {
      await fsp.mkdir(path.dirname(this.directory), {
        recursive: true,
        mode: 0o700,
      });
      await this.cleanAbandoned();
      staging = await fsp.mkdtemp(
        path.join(path.dirname(this.directory), this.stagingPrefix),
      );
      const response = await this.fetch(this.spec.url, {
        signal,
        redirect: "follow",
      });
      if (!response.ok || !response.body)
        throw new Error(`下载失败（HTTP ${response.status}）`);
      const total = Number(response.headers.get("content-length")) || null;
      if (total !== null && total > 512 * 1024 * 1024)
        throw new Error("运行时文件超出预期大小");
      this.update({ total });
      const hash = createHash("sha256"),
        archive = path.join(staging, "runtime.archive");
      let received = 0,
        last = 0;
      const meter = new Transform({
        transform: (chunk: any, _encoding: any, done: any) => {
          received += chunk.length;
          if (received > 512 * 1024 * 1024)
            return done(new Error("运行时文件超出预期大小"));
          hash.update(chunk);
          if (Date.now() - last > 200) {
            last = Date.now();
            this.update({ received });
          }
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream<Uint8Array>,
        ),
        meter,
        fs.createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      this.update({ phase: "verifying", received });
      if (hash.digest("hex") !== this.spec.sha256)
        throw new Error("下载文件校验失败，请重试");
      signal.throwIfAborted();
      this.update({ phase: "extracting" });
      const target = path.join(staging, "runtime");
      await fsp.mkdir(target);
      await this.extract(archive, target, signal);
      for (const name of this.spec.programs) {
        const file = path.join(target, name);
        const stat = await fsp.lstat(file);
        if (!stat.isFile()) throw new Error("运行时文件不完整");
        await fsp.access(
          file,
          process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
        );
      }
      signal.throwIfAborted();
      await fsp.writeFile(
        path.join(target, "installed.json"),
        JSON.stringify({
          sha256: this.spec.sha256,
          version: this.spec.version,
        }),
        { mode: 0o600 },
      );
      // A damaged managed copy is replaced only after the new copy is complete.
      let previous = null;
      try {
        await fsp.rename(this.directory, path.join(staging, "previous"));
        previous = path.join(staging, "previous");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      try {
        await fsp.rename(target, this.directory);
      } catch (e: any) {
        if (previous) await fsp.rename(previous, this.directory);
        throw e;
      }
      this.update({ phase: "ready", error: null });
      return this.directory;
    } catch (error: any) {
      const message = signal.aborted
        ? signal.reason?.message === "下载超时，请重试"
          ? "下载超时，请重试"
          : "已取消下载"
        : error.message;
      this.update({
        phase: signal.aborted ? "cancelled" : "error",
        error: message,
      });
      throw new Error(message);
    } finally {
      clearTimeout(timer);
      if (staging) await fsp.rm(staging, { recursive: true, force: true });
    }
  }
}
export { RuntimeInstaller };
