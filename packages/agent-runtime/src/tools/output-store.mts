import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

export interface OutputArtifact {
  id: string;
  /** A read_file path, also accessible inside exec_command. */
  path: string;
  bytes: number;
  mimeType: string;
}

export const OUTPUT_MOUNT = "/tmp/vibe-tool-output";
const ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(txt|json)$/;

/** Immutable outputs retained with a conversation, outside the user's project.
 * Archiving a conversation keeps its outputs available for reading and export.
 * Only generated file names are accepted; paths from model text are not authority.
 */
export class ToolOutputStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async ensure() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  private async file(id: string) {
    if (!ID.test(id)) throw new Error("工具输出编号无效");
    const file = path.join(this.root, id);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("工具输出文件无效");
    return file;
  }

  async describe(id: string): Promise<OutputArtifact> {
    const file = await this.file(id);
    return {
      id,
      path: process.platform === "linux" ? `${OUTPUT_MOUNT}/${id}` : file,
      bytes: (await fs.stat(file)).size,
      mimeType: id.endsWith(".json") ? "application/json" : "text/plain",
    };
  }

  async write(text: string, extension: "txt" | "json" = "txt") {
    await this.ensure();
    const id = `${randomUUID()}.${extension}`;
    await fs.writeFile(path.join(this.root, id), text, {
      flag: "wx",
      mode: 0o600,
    });
    return this.describe(id);
  }

  /** Import Pi's closed spill file. Caller removes the source after success. */
  async importFile(source: string) {
    await this.ensure();
    const id = `${randomUUID()}.txt`;
    const destination = path.join(this.root, id);
    try {
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      await fs.chmod(destination, 0o600);
      return await this.describe(id);
    } catch (error) {
      await fs.rm(destination, { force: true });
      throw error;
    }
  }

  async resolve(value: string): Promise<string | null> {
    const prefixes = [OUTPUT_MOUNT + "/", this.root + path.sep];
    const prefix = prefixes.find((candidate) => value.startsWith(candidate));
    if (!prefix) return null;
    return this.file(value.slice(prefix.length));
  }

  /** UI pages use byte offsets, so even a single huge line remains readable. */
  async read(id: string, offset = 0, limit = 64 * 1024) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 4 ||
      limit > 256 * 1024
    )
      throw new Error("工具输出读取范围无效");
    const handle = await fs.open(await this.file(id), "r");
    try {
      const { size: bytes } = await handle.stat();
      if (offset > bytes) throw new Error("工具输出读取位置超出文件大小");
      const buffer = Buffer.alloc(Math.min(limit + 4, bytes - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead && (buffer[0] & 0xc0) === 0x80)
        throw new Error("工具输出读取位置不在字符边界");
      let end = Math.min(limit, bytesRead);
      // End before a split UTF-8 character, including when pages are tiny.
      while (end < bytesRead && end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      return {
        text: buffer.subarray(0, end).toString("utf8"),
        ...(offset + end < bytes ? { nextOffset: offset + end } : {}),
        bytes,
      };
    } finally {
      await handle.close();
    }
  }
}
