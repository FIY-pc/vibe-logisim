import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Only fixed classifications from a synthetic probe may reach public CI logs. */
export function nodeFailure(output: string) {
  const codes = [
    ...new Set(
      output.match(
        /\b(?:ERR_[A-Z_]+|MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|EISDIR)\b/g,
      ) || [],
    ),
  ];
  const classes = [
    [
      "unsupported-option",
      /bad option|unknown option|not allowed in NODE_OPTIONS/i,
    ],
    ["module-resolution", /Cannot find module|Cannot find package/],
    [
      "esm-path",
      /Only URLs with a scheme|ERR_UNSUPPORTED_ESM_URL_SCHEME|ERR_INVALID_FILE_URL/,
    ],
    ["syntax", /SyntaxError/],
    ["namespaced-realpath", /EISDIR.*(?:lstat|stat)|(?:lstat|stat).*EISDIR/s],
    ["missing-global", /ReferenceError/],
    ["native-library", /specified module could not be found|DLL|0xc0000135/i],
    ["invalid-argument", /TypeError|RangeError/],
  ] as const;
  const modules = [
    "worker.mjs",
    "runtime-lock.json",
    "edit-schema.json",
  ].filter((name) => output.includes(name));
  return {
    codes,
    classes: classes
      .filter(([, pattern]) => pattern.test(output))
      .map(([name]) => name),
    modules,
    capturedBytes: Buffer.byteLength(output),
  };
}
function cleanEnvironment(state: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.toLowerCase() === "path" ||
      /^(NODE_OPTIONS|NODE_PATH|NODE_V8_COVERAGE|VIBE_LOGISIM_CODE_MODE_HOST|VIBE_LOGISIM_NODE|VIBE_LOGISIM_AGENT_ROOT)$/.test(
        key,
      )
    )
      delete env[key];
  env.PATH = path.join(state, "no-system-runtimes");
  env.VIBE_LOGISIM_NO_UPDATE_CHECK = "1";
  return env;
}
async function launcher(resources: string, label: string) {
  const executable = path.join(
    resources,
    "runtimes/node",
    process.platform === "win32" ? "node.exe" : "node",
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["--use-env-proxy", "--version"], {
      env: cleanEnvironment(resources),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => child.kill(), 10000);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes: Buffer) => {
        output = (output + bytes.toString("utf8")).slice(-8192);
      });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `${label}: Node launcher spawn-${(error as NodeJS.ErrnoException).code || "unknown"}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 && /^v24\.\d+\.\d+\s*$/u.test(output)
        ? resolve()
        : reject(
            new Error(
              `${label}: Node launcher exit-${code}; ${JSON.stringify(nodeFailure(output))}`,
            ),
          );
    });
  });
  console.log(`Verified ${label}: bundled Node 24 launcher and proxy option.`);
}
async function probe(resources: string, label: string, namespaced: boolean) {
  const state = await mkdtemp(path.join(tmpdir(), "Vibe Node 电路 check "));
  const executable = path.join(
    resources,
    "runtimes/node",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const entry = path.join(resources, "packages/agent-runtime/src/worker.mjs");
  for (const file of [executable, entry])
    if (!(await stat(file)).isFile())
      throw new Error(`${label}: bundled Node runtime member missing`);
  const argument = namespaced ? path.toNamespacedPath(entry) : entry;
  let terminated: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ["--use-env-proxy", argument, state], {
        cwd: state,
        env: cleanEnvironment(state),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      terminated = new Promise((resolve) =>
        child.once("close", () => resolve()),
      );
      let stderr = "",
        buffer = "",
        complete = false,
        stage = "status",
        settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const failure = (reason: string) =>
        new Error(
          `${label}: ${stage} ${reason}; ${JSON.stringify(nodeFailure(stderr))}`,
        );
      const timer = setTimeout(() => {
        child.kill();
        finish(failure("timeout"));
      }, 20000);
      child.stderr.on("data", (bytes: Buffer) => {
        stderr = (stderr + bytes.toString("utf8")).slice(-16384);
      });
      child.stdin.on("error", () => {});
      child.stdout.on("data", (bytes: Buffer) => {
        buffer += bytes.toString("utf8");
        if (buffer.length > 1024 * 1024) {
          child.kill();
          finish(failure("protocol-overflow"));
          return;
        }
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let value: any;
          try {
            value = JSON.parse(line);
          } catch {
            child.kill();
            finish(failure("invalid-protocol"));
            return;
          }
          if (value.kind !== "result") continue;
          if (value.error) {
            stderr += String(value.error);
            child.kill();
            finish(failure("request-error"));
            return;
          }
          if (value.id === 1) {
            stage = "configure";
            child.stdin.write(
              JSON.stringify({
                id: 2,
                method: "configure",
                args: {
                  name: "Fixture",
                  baseUrl: "http://127.0.0.1:9/v1",
                  model: "fixture",
                  api: "openai-completions",
                  apiKey: "fixture-key",
                },
              }) + "\n",
            );
          }
          if (value.id === 2) {
            if (
              value.result?.runtime !== "builtin" ||
              value.result?.model !== "fixture"
            ) {
              child.kill();
              finish(failure("unexpected-result"));
              return;
            }
            complete = true;
            child.stdin.end();
          }
        }
      });
      child.on("error", (error) =>
        finish(
          failure(
            `spawn-${(error as NodeJS.ErrnoException).code || "unknown"}`,
          ),
        ),
      );
      child.on("close", (code) => {
        if (complete && code === 0) finish();
        else finish(failure(`exit-${code}`));
      });
      child.stdin.write(
        JSON.stringify({ id: 1, method: "status", args: {} }) + "\n",
      );
    });
    console.log(
      `Verified ${label}: bundled Node sidecar status, provider configuration and clean shutdown without system runtimes or model requests.`,
    );
  } finally {
    await terminated;
    await rm(state, { recursive: true, force: true });
  }
}
export async function verifyNodeRuntime(resources: string, label: string) {
  await launcher(resources, label);
  await probe(resources, label, false);
  if (process.platform === "win32")
    await probe(resources, label + " with canonical Windows path", true);
}
export async function verifyNodeRelocation(resources: string) {
  await verifyNodeRuntime(resources, "original Node runtime");
  const directory = await mkdtemp(
    path.join(tmpdir(), "Vibe Node product 电路 check "),
  );
  try {
    for (const item of [
      "runtimes/node",
      "packages/agent-runtime",
      "config/runtime-lock.json",
    ])
      await cp(path.join(resources, item), path.join(directory, item), {
        recursive: true,
        dereference: true,
      });
    await verifyNodeRuntime(
      directory,
      "Node runtime relocated to Unicode path",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
