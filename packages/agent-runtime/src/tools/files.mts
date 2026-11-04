import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { spawn, execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readMaterial } from "../materials/read.mts";
import { windowsCommand } from "./windows-command.mts";
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

// Page large files without filling the conversation with the whole source.
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
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 0 ||
    timeout * 1000 > 2147483647
  )
    throw new Error("timeout 必须是非负整数秒，0 表示运行到完成或主动停止");
  if (process.platform === "win32")
    return windowsCommand(commandText, {
      root,
      referenceRoot,
      runtimeRoot,
      signal,
      timeout,
    });
  if (process.platform !== "linux")
    throw new Error("当前系统尚不支持命令执行，请使用文件和电路工具");
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
    "--expand-environment=no",
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
    ...(timeout > 0 ? [`--property=RuntimeMaxSec=${timeout + 2}`] : []),
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
    const timer = timeout > 0 ? setTimeout(stop, timeout * 1000) : undefined;
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
 * list_files and exec_command (Linux systemd sandbox / Windows PowerShell). Paths are
 * folder-relative; the bundled references are readable too.
 */
function fileTools({ root, runtimeRoot, assertCurrent, vision = true }: any) {
  const versions = new Map<string, string | null>();
  const digestFile = async (file: string) => {
    try {
      return createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex");
    } catch (error: any) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const schema = (properties: any) => ({
    type: "object",
    properties,
    required: Object.keys(properties).filter((x: any) => x !== "timeout"),
    additionalProperties: false,
  });
  const string = { type: "string" };
  const tools: AgentTool<any, any>[] = [
    {
      name: "read_material",
      label: "读取资料",
      description:
        "Read a project PDF or image independently of the user's viewer. PDF: page is 1-based; omit it for page 1, page count and outline. query searches 20 pages from startPage and returns nextPage to continue. render includes the page image (diagrams/tables); pages without text return an image automatically, not OCR. Long page text returns nextOffset to continue. Images return a fitted image. Use read_file for text. A quoted page or region is a focus, not a limit on reading.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          page: { type: "integer", minimum: 1 },
          query: { type: "string" },
          startPage: { type: "integer", minimum: 1 },
          render: { type: "boolean" },
          offset: { type: "integer", minimum: 0 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (_id: any, args: any, signal: any) => {
        assertCurrent();
        const file = await resolveFile(root, args.path);
        const { image, ...value } = await readMaterial(file, args, signal);
        assertCurrent();
        signal?.throwIfAborted();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(value) },
            ...(image
              ? vision
                ? [
                    {
                      type: "image" as const,
                      data: image.split(",")[1],
                      mimeType: "image/png",
                    },
                  ]
                : [
                    {
                      type: "text" as const,
                      text: "此页含图片；当前模型未启用图片输入，不能声称已看图。",
                    },
                  ]
              : []),
          ],
          details: null,
        };
      },
    },
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
        const version = await digestFile(file);
        const text = await readText(file, args);
        if (version !== (await digestFile(file)))
          throw new Error("文件在读取时发生变化，请重新读取");
        versions.set(file, version);
        return result(text);
      },
    },
    {
      name: "write_file",
      label: "写入文件",
      description:
        "Write UTF-8 text atomically to a folder-relative file. Read an existing file with read_file first; a changed file must be re-read before writing. Parent directory must exist. Open .circ files follow the next host request.",
      parameters: schema({ path: string, content: string }),
      execute: async (_id: any, args: any, signal: any) => {
        assertCurrent();
        signal?.throwIfAborted();
        const file = await resolveFile(root, args.path, true);
        if (Buffer.byteLength(args.content) > 2 * 1024 * 1024)
          throw new Error("单次写入超过 2 MB");
        const baseline = versions.get(file) ?? null;
        const current = await digestFile(file);
        if (current !== baseline)
          throw new Error(
            "文件已存在或读取后发生变化，请先用 read_file 重新读取再修改",
          );
        const temp = path.join(
          path.dirname(file),
          `.vibe-write-${randomUUID()}.tmp`,
        );
        try {
          const mode = current === null ? 0o600 : (await fs.stat(file)).mode;
          const staged = await fs.open(temp, "wx", mode);
          try {
            await staged.writeFile(args.content, { encoding: "utf8", signal });
            await staged.sync();
          } finally {
            await staged.close();
          }
          await resolveFile(root, args.path, true);
          if ((await digestFile(file)) !== baseline)
            throw new Error("文件在写入前发生变化，请重新读取");
          assertCurrent();
          signal?.throwIfAborted();
          if (current === null) await fs.link(temp, file);
          else await fs.rename(temp, file);
          versions.set(
            file,
            createHash("sha256").update(args.content).digest("hex"),
          );
        } finally {
          await fs.rm(temp, { force: true });
        }
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
  if (process.platform === "linux" || process.platform === "win32")
    tools.push({
      name: "exec_command",
      label: "执行命令",
      description:
        process.platform === "win32"
          ? "Run Windows PowerShell 5.1 in the open project folder. Commands and scripts edit the user's files directly. node is the app's bundled Node.js; java is available in packaged builds. Use PowerShell syntax, not bash; for large scripts, write a .mjs file then run node ./script.mjs. For PowerShell file cmdlets use absolute -LiteralPath (Join-Path $env:VIBE_PROJECT_ROOT 'file') to handle brackets in directory names. References: $env:VIBE_CIRCUIT_REFERENCE; runtimes: $env:VIBE_RUNTIME. The shell has the current user's filesystem permissions, not a filesystem sandbox; operate on the project and requested materials. No user profile or inherited model credentials. UTF-8 output is limited to the last 64000 characters, with truncated=true when shortened."
          : "Run bash in a sandbox whose working directory /tmp/workspace is the open folder itself: files written there are the user's files. Bundled references are read-only at " +
            SANDBOX_REFERENCE +
            ". No model credentials or user home access. Output is limited to the last 64000 characters.",
      parameters: schema({
        command: string,
        timeout: {
          type: "integer",
          minimum: 0,
          description:
            "Deadline in seconds (default 120). Set a longer duration for long work, or 0 to run until completion or cancellation.",
        },
      }),
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
