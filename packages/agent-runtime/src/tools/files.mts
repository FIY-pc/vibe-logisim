import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
/**
 * The bundled circuit-knowledge directory. In development it sits two levels
 * up from this file; in the esbuild bundle (worker.mjs at src/) one level up.
 * Searching upward covers both without a build-time constant.
 */
const referenceRoot = (() => {
  let directory = import.meta.dirname;
  for (let i = 0; i < 4; i += 1) {
    const candidate = path.join(directory, "circuit-knowledge");
    if (existsSync(path.join(candidate, "index.md"))) return candidate;
    directory = path.dirname(directory);
  }
  throw new Error(
    "circuit-knowledge directory not found beside the agent runtime",
  );
})();
const inside = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);
/** Where exec_command's sandbox mounts the reference directory. */
const SANDBOX_REFERENCE = "/tmp/vibe-circuit-reference";
// A reference path as the shell sees it, so that the two spellings of the
// same file both read.
const fromSandbox = (value: string) =>
  value === SANDBOX_REFERENCE || value.startsWith(SANDBOX_REFERENCE + "/")
    ? path.join(referenceRoot, value.slice(SANDBOX_REFERENCE.length))
    : value;
const result = (text: string): AgentToolResult<any> => ({
  content: [{ type: "text", text }],
  details: null,
});
async function resolveFile(root: string, value: any, write = false) {
  const target = path.resolve(root, fromSandbox(String(value)));
  const allowed =
    inside(root, target) || (!write && inside(referenceRoot, target));
  if (!allowed) throw new Error("路径不在工作区或内置参考目录中");
  const base = inside(root, target)
    ? await fs.realpath(root)
    : await fs.realpath(referenceRoot);
  const parent = await fs.realpath(path.dirname(target));
  if (!inside(base, parent)) throw new Error("链接指向工作区之外");
  try {
    if (!inside(base, await fs.realpath(target)))
      throw new Error("链接指向工作区之外");
  } catch (e: any) {
    if (e.code !== "ENOENT" || !write) throw e;
  }
  return target;
}
const READ_LIMIT = 512000;

// Without a shell (Windows), paging is the only way to read a large file.
async function readText(
  file: string,
  { offset, limit }: { offset?: number; limit?: number },
) {
  const size = (await fs.stat(file)).size;
  if (!size) return "";
  if (offset === undefined && limit === undefined && size <= READ_LIMIT)
    return fs.readFile(file, "utf8");
  const first = offset ?? 1;
  const lines: string[] = [];
  let total = 0,
    bytes = 0,
    full = false;
  const input = createReadStream(file, { encoding: "utf8" });
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      total += 1;
      if (full || total < first) continue;
      const cost = Buffer.byteLength(line, "utf8") + 1;
      if (
        (limit !== undefined && lines.length >= limit) ||
        bytes + cost > READ_LIMIT
      ) {
        if (!lines.length)
          throw new Error(`第 ${total} 行超过单次读取上限 ${READ_LIMIT} 字节`);
        full = true;
        continue;
      }
      lines.push(line);
      bytes += cost;
    }
  } finally {
    input.destroy();
  }
  if (first > total) throw new Error(`offset ${first} 超出文件行数 ${total}`);
  const last = first + lines.length - 1;
  return (
    lines.join("\n") +
    `\n[lines ${first}-${last} of ${total}; ${size} bytes total.` +
    (last < total ? ` Continue with offset=${last + 1}.]` : "]")
  );
}

function command(
  commandText: string,
  { root, runtimeRoot, signal, timeout = 120 }: any,
) {
  if (process.platform !== "linux")
    throw new Error("当前系统尚不支持隔离的命令执行，请使用文件和电路工具");
  const unit = `vibe-builtin-${randomUUID()}.service`;
  const bind = (source: any, target: string) =>
    `${JSON.stringify(source)}:${JSON.stringify(target)}`;
  const readOnly = [bind(referenceRoot, SANDBOX_REFERENCE)];
  if (runtimeRoot) readOnly.push(bind(runtimeRoot, "/tmp/vibe-runtime"));
  const args = [
    "--user",
    "--pipe",
    "--quiet",
    "--collect",
    "--service-type=exec",
    `--unit=${unit}`,
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=tmpfs",
    "--property=PrivateTmp=yes",
    "--property=PrivateDevices=yes",
    "--property=PrivateIPC=yes",
    "--property=ProtectProc=invisible",
    "--property=ProcSubset=pid",
    "--property=InaccessiblePaths=/run /var -/opt -/srv -/media -/mnt -/boot -/sys -/.snapshots",
    `--property=BindPaths=${bind(root, "/tmp/workspace")}`,
    `--property=BindReadOnlyPaths=${readOnly.join(" ")}`,
    "--property=NoNewPrivileges=yes",
    "--property=CapabilityBoundingSet=",
    "--property=RestrictSUIDSGID=yes",
    `--property=RuntimeMaxSec=${Math.min(300, Math.max(1, timeout)) + 2}`,
    "--property=UMask=0077",
    "--property=MemoryMax=6442450944",
    "--property=TasksMax=512",
    "--working-directory=/tmp/workspace",
    "/usr/bin/env",
    "-i",
    "HOME=/tmp",
    `PATH=${runtimeRoot ? "/tmp/vibe-runtime/java/bin:" : ""}/usr/bin:/bin`,
    "LANG=C.UTF-8",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
    commandText,
  ];
  return new Promise<AgentToolResult<any>>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("已停止"));
    const child = spawn("systemd-run", args, {
      cwd: "/",
      env: {
        PATH: process.env.PATH,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      stopped = false,
      stopTimer: ReturnType<typeof setInterval> | undefined;
    const append = (chunk: any) => {
      output = (output + chunk.toString()).slice(-64000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const kill = () =>
      execFile(
        "systemctl",
        ["--user", "kill", "--signal=SIGKILL", unit],
        () => {},
      );
    const stop = () => {
      stopped = true;
      kill();
      stopTimer ||= setInterval(kill, 100);
    };
    const timer = setTimeout(stop, Math.min(300, Math.max(1, timeout)) * 1000);
    signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(stopTimer);
      signal?.removeEventListener("abort", stop);
    };
    child.on("error", (e: any) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code: any) => {
      cleanup();
      stopped
        ? reject(new Error("命令已停止或超时"))
        : resolve(result(JSON.stringify({ exitCode: code, output })));
    });
  });
}
/**
 * General file tools rooted at the open folder: read_file, write_file,
 * list_files and, on Linux, exec_command in a systemd sandbox. Paths are
 * folder-relative; the bundled references are readable too.
 */
function fileTools({ root, runtimeRoot, assertCurrent }: any) {
  const schema = (properties: any) => ({
    type: "object",
    properties,
    required: Object.keys(properties).filter((x: any) => x !== "timeout"),
    additionalProperties: false,
  });
  const string = { type: "string" };
  const tools: AgentTool<any, any>[] = [
    {
      name: "read_file",
      label: "读取文件",
      description:
        "Read UTF-8 text from a folder-relative path or the bundled reference directory. Returns at most 512000 bytes per call; for longer files pass offset (1-based first line) and limit (line count) to read in pages.",
      parameters: {
        type: "object",
        properties: {
          path: string,
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (_id: any, args: any, signal: any) => {
        assertCurrent();
        signal?.throwIfAborted();
        const file = await resolveFile(root, args.path);
        return result(await readText(file, args));
      },
    },
    {
      name: "write_file",
      label: "写入文件",
      description:
        "Write UTF-8 text to a folder-relative file. Parent directory must exist. Writing an open .circ is allowed: the circuit tools read the file again on their next call and the canvas follows (a document with unsaved changes keeps them instead).",
      parameters: schema({ path: string, content: string }),
      execute: async (_id: any, args: any, signal: any) => {
        assertCurrent();
        signal?.throwIfAborted();
        const file = await resolveFile(root, args.path, true);
        if (Buffer.byteLength(args.content) > 2 * 1024 * 1024)
          throw new Error("单次写入超过 2 MB");
        await fs.writeFile(file, args.content, "utf8");
        return result("已写入 " + args.path);
      },
    },
    {
      name: "list_files",
      label: "列出文件",
      description:
        "List entries of a folder-relative directory (use . for the folder root).",
      parameters: schema({ path: string }),
      execute: async (_id: any, args: any, signal: any) => {
        assertCurrent();
        signal?.throwIfAborted();
        const requested = path.resolve(root, args.path);
        const file =
          requested === root
            ? await fs.realpath(root)
            : await resolveFile(root, args.path);
        const entries = await fs.readdir(file, { withFileTypes: true });
        return result(
          JSON.stringify(
            entries
              .slice(0, 500)
              .map((e: any) => ({ name: e.name, directory: e.isDirectory() })),
          ),
        );
      },
    },
  ];
  if (process.platform === "linux")
    tools.push({
      name: "exec_command",
      label: "执行命令",
      description:
        "Run bash in a sandbox whose working directory /tmp/workspace is the open folder itself: files written there are the user's files. Bundled references are read-only at " +
        SANDBOX_REFERENCE +
        ". No model credentials or user home access. Output is limited to the last 64000 characters.",
      parameters: schema({ command: string, timeout: { type: "number" } }),
      execute: async (_id: any, args: any, signal: any) => {
        assertCurrent();
        return command(args.command, {
          root,
          runtimeRoot,
          signal,
          timeout: args.timeout,
        });
      },
    });
  return tools;
}
export {
  fileTools,
  resolveFile,
  command,
  referenceRoot,
  SANDBOX_REFERENCE,
  readText,
};
