import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readMaterial } from "../materials/read.mts";
import { tmpdir } from "node:os";
import {
  createBashTool,
  createPowerShellTool,
  createReadTool,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
  ToolOutputStore,
  OUTPUT_MOUNT,
  type OutputArtifact,
} from "./output-store.mts";
import { shellCommand } from "./shell-command.mts";
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
async function resolveFile(
  root: string | null,
  value: any,
  write = false,
  outputs?: ToolOutputStore,
) {
  const output = await outputs?.resolve(String(value));
  if (output) {
    if (write) throw new Error("工具输出是只读的");
    return output;
  }
  const target = path.resolve(
    root || referenceRoot,
    fromSandbox(String(value)),
  );
  const outputRoot = outputs
    ? await fs.realpath(outputs.root).catch((error) => {
        if (error.code === "ENOENT") return outputs.root;
        throw error;
      })
    : undefined;
  const writable = (file: string) => {
    if (
      write &&
      (inside(OUTPUT_MOUNT, file) || (outputRoot && inside(outputRoot, file)))
    )
      throw new Error("工具输出是只读的");
  };
  writable(target);
  const allowed =
    (root && inside(root, target)) || (!write && inside(referenceRoot, target));
  if (!allowed) throw new Error("路径不在工作区或内置参考目录中");
  const base =
    root && inside(root, target)
      ? await fs.realpath(root)
      : await fs.realpath(referenceRoot);
  const parent = await fs.realpath(path.dirname(target));
  writable(parent);
  if (!inside(base, parent)) throw new Error("链接指向工作区之外");
  try {
    const resolved = await fs.realpath(target);
    writable(resolved);
    if (!inside(base, resolved)) throw new Error("链接指向工作区之外");
  } catch (e: any) {
    if (e.code !== "ENOENT" || !write) throw e;
  }
  return target;
}
// Use Pi's text pagination, with this application's already-checked path. Image
// reading remains the responsibility of read_material.
async function readText(
  file: string,
  args: { offset?: number; limit?: number },
  signal?: AbortSignal,
  shellPath = file,
) {
  const read = createReadTool(path.dirname(file), {
    operations: {
      access: () => fs.access(file),
      readFile: () => fs.readFile(file),
    },
  });
  const value = await read.execute(
    "read_file",
    { ...args, path: shellPath },
    signal,
  );
  let text = value.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  if (value.details?.truncation?.firstLineExceedsLimit) {
    const line = args.offset ?? 1;
    const quoted =
      process.platform === "win32"
        ? "'" + shellPath.replaceAll("'", "''") + "'"
        : "'" + shellPath.replaceAll("'", "'\"'\"'") + "'";
    const command =
      process.platform === "win32"
        ? `[IO.File]::ReadLines(${quoted}) | Select-Object -Skip ${line - 1} -First 1 | ForEach-Object { $_.Substring(0, [Math]::Min(12000, $_.Length)) }`
        : `awk 'NR == ${line} { print substr($0, 1, 4096); exit }' ${quoted}`;
    // Pi's default hint names bash and an unchecked host path. Supply a usable
    // command for our actual platform/mounts, keeping the pagination decision.
    text =
      text.slice(0, text.indexOf(" Use bash:")) +
      ` Use exec_command to search or inspect a range, for example: ${command}]`;
  }
  return text;
}

/** Persist Pi's closed log before returning any final result, including errors. */
async function command(
  commandText: string,
  {
    root,
    runtimeRoot,
    outputs,
    signal,
    timeout = 120,
    onUpdate,
  }: {
    root: string;
    runtimeRoot?: string | null;
    outputs: ToolOutputStore;
    signal?: AbortSignal;
    timeout?: number;
    onUpdate?: AgentToolUpdateCallback;
  },
): Promise<AgentToolResult<any>> {
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 0 ||
    timeout * 1000 > 2147483647
  )
    throw new Error("timeout 必须是非负整数秒，0 表示运行到完成或主动停止");
  await outputs.ensure();
  const tool = (
    process.platform === "win32" ? createPowerShellTool : createBashTool
  )(root, {
    exposeSessionEnvironment: false,
    operations: {
      exec: (text, _cwd, options) =>
        shellCommand(text, {
          root,
          referenceRoot,
          runtimeRoot,
          outputRoot: outputs.root,
          onData: options.onData,
          signal: options.signal,
          timeout: options.timeout,
          // Deliberately do not inherit Pi's env: each backend builds a clean one.
        }),
    },
  });
  let partial: AgentToolResult<any> | undefined;
  let value: AgentToolResult<any>;
  try {
    value = await tool.execute(
      "exec_command",
      { command: commandText, timeout: timeout || undefined },
      signal,
      (update) => {
        partial = update;
        // The file is still open. Do not publish or copy its temporary path yet.
        onUpdate?.({
          content: update.content,
          details: { truncation: update.details?.truncation },
        });
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const log =
      partial?.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n") ?? "";
    value = {
      content: [
        {
          type: "text",
          text:
            log && !message.startsWith(log) ? `${log}\n\n${message}` : message,
        },
      ],
      details: partial?.details,
      isError: true,
    };
  }
  const source =
    value.details?.fullOutputPath ?? partial?.details?.fullOutputPath;
  const structured = value.structuredContent as
    { exit_code?: number } | undefined;
  let artifact: OutputArtifact | undefined;
  let outputPersistenceError: string | undefined;
  if (source) {
    try {
      artifact = await outputs.importFile(source);
    } catch (error) {
      outputPersistenceError =
        error instanceof Error ? error.message : String(error);
    }
  }
  // Copying only after execute settles includes buffered bytes on timeout/stop.
  // A failed temporary-file cleanup must not discard the persisted result.
  if (source && artifact) await fs.rm(source, { force: true }).catch(() => {});
  const content = value.content.map((block) =>
    block.type === "text" && source
      ? {
          ...block,
          text: block.text.replaceAll(
            source,
            artifact?.path ?? "(完整日志未持久保存)",
          ),
        }
      : block,
  );
  // Pi's compaction serializer keeps the beginning of each tool result.
  if (artifact)
    content.unshift({
      type: "text",
      text: `Full output: ${artifact.path}\nRead with read_file or search with exec_command.`,
    });
  if (outputPersistenceError)
    content.unshift({
      type: "text",
      text: `完整输出保存失败：${outputPersistenceError}。命令已经执行，以下保留原输出预览及执行状态；不要仅因保存失败重复执行命令。`,
    });
  return {
    content,
    details: {
      ...(value.details?.truncation
        ? { truncation: value.details.truncation }
        : {}),
      ...(structured?.exit_code !== undefined
        ? { exitCode: structured.exit_code }
        : {}),
      outputArtifacts: artifact ? [artifact] : [],
      ...(outputPersistenceError ? { outputPersistenceError } : {}),
    },
    ...(value.isError ? { isError: true } : {}),
  };
}
/**
 * General file tools rooted at the open folder: read_file, write_file,
 * list_files and exec_command (Linux systemd sandbox / Windows PowerShell). Paths are
 * folder-relative; the bundled references are readable too.
 */
function fileTools({
  root,
  runtimeRoot,
  assertCurrent,
  vision = true,
  outputs = new ToolOutputStore(
    path.join(tmpdir(), `vibe-tool-output-${randomUUID()}`),
  ),
}: {
  root: string | null;
  runtimeRoot?: string | null;
  assertCurrent: () => void;
  vision?: boolean;
  outputs?: ToolOutputStore;
}) {
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
        "Read UTF-8 text from a folder-relative path, the bundled reference directory, or a saved output path. Returns up to 2000 lines or 50 KiB per call; pass offset (1-based first line) and limit (line count) for pages. Very long lines include an exec_command suggestion for reading a range.",
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
        const file = await resolveFile(root, args.path, false, outputs);
        const version = await digestFile(file);
        const shellPath =
          process.platform !== "linux"
            ? file
            : inside(referenceRoot, file)
              ? path.join(SANDBOX_REFERENCE, path.relative(referenceRoot, file))
              : inside(outputs.root, file)
                ? `${OUTPUT_MOUNT}/${path.basename(file)}`
                : path.join("/tmp/workspace", path.relative(root!, file));
        const text = await readText(file, args, signal, shellPath);
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
        const file = await resolveFile(root, args.path, true, outputs);
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
          await resolveFile(root, args.path, true, outputs);
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
        if (!root) throw new Error("单电路模式不提供工程文件列表");
        const requested = path.resolve(root, args.path);
        const file =
          requested === root
            ? await fs.realpath(root)
            : await resolveFile(root, args.path);
        const entries = await fs.readdir(file, { withFileTypes: true });
        return result(
          JSON.stringify(
            entries.map((e: any) => ({
              name: e.name,
              directory: e.isDirectory(),
            })),
          ),
        );
      },
    },
  ];
  if (root && ["linux", "win32", "darwin"].includes(process.platform))
    tools.push({
      name: "exec_command",
      label: "执行命令",
      description:
        process.platform === "win32"
          ? "Run Windows PowerShell 5.1 in the open project folder. Commands and scripts edit the user's files directly. node is the app's bundled Node.js; java is available in packaged builds. Use PowerShell syntax, not bash; for large scripts, write a .mjs file then run node ./script.mjs. For PowerShell file cmdlets use absolute -LiteralPath (Join-Path $env:VIBE_PROJECT_ROOT 'file') to handle brackets in directory names. References: $env:VIBE_CIRCUIT_REFERENCE; runtimes: $env:VIBE_RUNTIME. The shell has the current user's filesystem permissions, not a filesystem sandbox; operate on the project and requested materials. No user profile or inherited model credentials. Saved command outputs are in $env:VIBE_TOOL_OUTPUT. Output shows the last 2000 lines or 50 KiB; if shortened, the full log path is returned for read_file or shell searches."
          : process.platform === "darwin"
            ? "Run macOS bash in the open project folder, without shell profiles or inherited model credentials. node is the app's bundled Node.js; java is available in packaged builds. Use $VIBE_CIRCUIT_REFERENCE for references, $VIBE_RUNTIME for runtimes, and $VIBE_TOOL_OUTPUT for saved outputs. The shell has the current user's filesystem permissions, not a filesystem sandbox; operate on the project and requested materials. Commands must stay in their process group; do not daemonize. Output shows the last 2000 lines or 50 KiB; if shortened, the full log path is returned for read_file or shell searches."
            : "Run bash in a sandbox whose working directory /tmp/workspace is the open folder itself: files written there are the user's files. Bundled references are read-only at " +
              SANDBOX_REFERENCE +
              ". Saved outputs are read-only at /tmp/vibe-tool-output. No model credentials or user home access. Output shows the last 2000 lines or 50 KiB; if shortened, the full log path is returned for read_file or shell searches.",
      parameters: schema({
        command: string,
        timeout: {
          type: "integer",
          minimum: 0,
          description:
            "Deadline in seconds (default 120). Set a longer duration for long work, or 0 to run until completion or cancellation.",
        },
      }),
      execute: async (_id: any, args: any, signal: any, onUpdate) => {
        assertCurrent();
        return command(args.command, {
          root,
          runtimeRoot,
          signal,
          timeout: args.timeout,
          outputs,
          onUpdate,
        });
      },
    });
  return root ? tools : tools.filter((tool) => tool.name === "read_file");
}
export {
  fileTools,
  resolveFile,
  command,
  referenceRoot,
  SANDBOX_REFERENCE,
  readText,
};
