import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type DesktopReport = {
  schema: number;
  version: string;
  resources: string;
  frontend: boolean;
  nativeSimulation: boolean;
  builtinRuntime: boolean;
  recovered: boolean;
  documentId: string;
  revision: string;
  error?: string;
};

export async function run(
  binary: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    windowsVerbatimArguments?: boolean;
  } = {},
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: "inherit",
      detached: process.platform !== "win32",
      ...options,
    });
    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        spawn(
          path.join(
            process.env.SystemRoot || "C:\\Windows",
            "System32/taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
        );
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      reject(new Error(`${path.basename(binary)} timed out`));
    }, options.timeout || 150_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(`${path.basename(binary)} exited ${code ?? signal}`),
          );
    });
  });
}

export async function checkDesktop(options: {
  binary: string;
  state: string;
  report: string;
  resources: string;
  portable?: boolean;
  previous?: DesktopReport;
}): Promise<DesktopReport> {
  await mkdir(options.state, { recursive: true });
  await mkdir(path.dirname(options.report), { recursive: true });
  await rm(options.report, { force: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.toLowerCase() === "path" ||
      key.startsWith("VIBE_LOGISIM_") ||
      [
        "VIBE_WORKBENCH_RESOURCES",
        "VIBE_VERIFY_HOST",
        "NODE_PATH",
        "NODE_OPTIONS",
        "JAVA_HOME",
        "JAVA_TOOL_OPTIONS",
        "_JAVA_OPTIONS",
      ].includes(key)
    )
      delete env[key];
  }
  Object.assign(env, {
    PATH: path.join(options.state, "no-system-runtimes"),
    VIBE_WORKBENCH_STATE: options.state,
    VIBE_WORKBENCH_INSTALL_CHECK: options.report,
    VIBE_LOGISIM_NO_UPDATE_CHECK: "1",
  });
  if (options.portable) env.VIBE_WORKBENCH_RESOURCES = options.resources;
  let failure: unknown;
  try {
    await run(options.binary, [], { cwd: options.state, env });
  } catch (error) {
    failure = error;
  }
  let report: DesktopReport;
  try {
    report = JSON.parse(await readFile(options.report, "utf8"));
  } catch {
    throw (
      failure ||
      new Error("Desktop did not write its installation check report")
    );
  }
  // CI artifacts describe synthetic checks, without machine paths or document identifiers.
  const artifact = {
    schema: report.schema,
    version: report.version,
    frontend: report.frontend === true,
    nativeSimulation: report.nativeSimulation === true,
    builtinRuntime: report.builtinRuntime === true,
    recovered: report.recovered === true,
    success: false,
  };
  await writeFile(options.report, JSON.stringify(artifact, null, 2) + "\n");
  assert(!report.error, report.error);
  if (failure) throw failure;
  assert.equal(report.schema, 1);
  assert.equal(
    report.frontend,
    true,
    "Packaged frontend must mount and complete IPC",
  );
  assert.equal(
    report.nativeSimulation,
    true,
    "Bundled Java must evaluate both NOT vectors",
  );
  assert.equal(
    report.builtinRuntime,
    true,
    "Bundled Node must start the runtime",
  );
  const canonical = async (file: string) => {
    const resolved = await realpath(file);
    return process.platform === "win32"
      ? resolved.replace(/^\\\\\?\\/, "").toLowerCase()
      : resolved;
  };
  assert.equal(
    await canonical(report.resources),
    await canonical(options.resources),
    "Desktop resolved resources outside its installed package",
  );
  assert.equal(report.recovered, Boolean(options.previous));
  if (options.previous) {
    assert.equal(
      report.documentId,
      options.previous.documentId,
      "Restart/upgrade changed draft identity",
    );
    assert.equal(
      report.revision,
      options.previous.revision,
      "Restart/upgrade changed draft source",
    );
  }
  await writeFile(
    options.report,
    JSON.stringify({ ...artifact, success: true }, null, 2) + "\n",
  );
  return report;
}
