/** Real macOS shell, Unicode files, bundled interpreters and cancellation. No model calls. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileTools } from "../../packages/agent-runtime/src/tools/files.mts";
import { ToolOutputStore } from "../../packages/agent-runtime/src/tools/output-store.mts";

if (process.platform === "darwin") {
  const root = await mkdtemp(path.join(tmpdir(), "Vibe 电路 [command] "));
  const outputRoot = await mkdtemp(path.join(tmpdir(), "Vibe 输出 "));
  const runtimeRoot = process.argv[2]
    ? path.resolve(process.argv[2], "runtimes")
    : undefined;
  const outputs = new ToolOutputStore(outputRoot);
  const tools = fileTools({ root, runtimeRoot, outputs, assertCurrent() {} });
  const tool = tools.find((t) => t.name === "exec_command");
  assert.ok(tool, "macOS exposes exec_command");
  const run = async (command: string, timeout = 15, signal?: AbortSignal) => {
    const value = await tool.execute("mac-check", { command, timeout }, signal);
    return {
      text: value.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("\n"),
      details: value.details,
      isError: value.isError,
    };
  };
  const waitPid = async (name: string) => {
    for (let i = 0; i < 100; i++) {
      try {
        return Number(await readFile(path.join(root, name), "utf8"));
      } catch {
        await delay(50);
      }
    }
    throw new Error("Command child never started");
  };
  const dead = async (pid: number) => {
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await delay(30);
    }
    assert.fail("Command child survived cancellation or completion");
  };
  const keys = ["VIBE_COMMAND_TEST_SECRET", "NODE_OPTIONS", "BASH_ENV"];
  const saved = keys.map((k) => process.env[k]);
  process.env.VIBE_COMMAND_TEST_SECRET = "synthetic-sentinel";
  process.env.NODE_OPTIONS = "--invalid-test-option";
  process.env.BASH_ENV = path.join(root, "profile.sh");
  try {
    await writeFile(
      path.join(root, "profile.sh"),
      "echo inherited-profile; exit 91\n",
    );
    await writeFile(
      path.join(root, "edit.mjs"),
      `
import {writeFileSync} from 'node:fs';
if (process.env.VIBE_COMMAND_TEST_SECRET || process.env.NODE_OPTIONS || process.env.BASH_ENV) throw Error('inherited environment');
writeFileSync('电路.circ', '<project><circuit name="修改后"/></project>');
console.log('完成', process.execPath);
`,
    );
    const edited = await run(
      'node ./edit.mjs\ncat "电路.circ"\ntest -f "$VIBE_CIRCUIT_REFERENCE/index.md"',
    );
    assert.equal(edited.details.exitCode, 0, edited.text);
    assert.match(edited.text, /修改后/);
    assert.ok(
      edited.text.includes(process.execPath),
      "Shell must use the same bundled Node",
    );
    assert.match(
      await readFile(path.join(root, "电路.circ"), "utf8"),
      /修改后/,
    );
    assert.equal((await run("exit 7")).details.exitCode, 7);
    assert.equal(
      (await run("#" + "long ".repeat(50000) + "\necho long-ok")).details
        .exitCode,
      0,
    );
    if (runtimeRoot) {
      const java = await run("java -version");
      assert.equal(java.details.exitCode, 0, java.text);
      assert.match(java.text, /version "21\./);
    }
    const noisy = await run(
      `node -e 'console.log("中文日志🧪".repeat(15000)); console.log("tail-marker")'`,
    );
    assert.equal(noisy.details.truncation?.truncated, true);
    const artifact = noisy.details.outputArtifacts[0];
    assert.match(
      await readFile((await outputs.resolve(artifact.path))!, "utf8"),
      /tail-marker/,
    );
    await writeFile(
      path.join(root, "child.mjs"),
      `
import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
console.log('started-child');
setInterval(() => {}, 1000);
`,
    );
    const controller = new AbortController();
    const cancelled = run(
      "node ./child.mjs cancelled.pid",
      0,
      controller.signal,
    );
    const cancelledPid = await waitPid("cancelled.pid");
    controller.abort();
    assert.match((await cancelled).text, /Command aborted/);
    await dead(cancelledPid);
    const timed = run("node ./child.mjs timed.pid", 2);
    const timedPid = await waitPid("timed.pid");
    assert.match((await timed).text, /Command timed out/);
    await dead(timedPid);
    const background = await run(
      "node ./child.mjs background.pid &\nwhile [ ! -f background.pid ]; do sleep 0.05; done",
    );
    assert.equal(background.details.exitCode, 0, background.text);
    await dead(await waitPid("background.pid"));
    assert.match(
      (await run("echo never", 0, AbortSignal.abort())).text,
      /abort/i,
    );
    console.log(
      "Verified macOS command edits, bundled runtimes, clean environment, Unicode output, long scripts, exit codes, timeout/cancel and process-group cleanup.",
    );
  } finally {
    keys.forEach((k, i) =>
      saved[i] === undefined
        ? delete process.env[k]
        : (process.env[k] = saved[i]),
    );
    await rm(root, { recursive: true, force: true });
    await rm(outputRoot, { recursive: true, force: true });
  }
} else {
  console.log("macOS command checks run on macOS.");
}
