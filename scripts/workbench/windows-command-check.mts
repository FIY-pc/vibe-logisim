/** Real PowerShell and bundled-interpreter checks; no model service is used. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileTools } from "../../packages/agent-runtime/src/tools/files.mts";

if (process.platform !== "win32") {
  console.log("Windows command checks run on Windows.");
} else {
  // Spaces, non-ASCII and PowerShell wildcard characters must remain literal.
  const root = await mkdtemp(path.join(tmpdir(), "Vibe 电路 [command] "));
  const runtimeRoot = process.argv[2]
    ? path.resolve(process.argv[2], "runtimes")
    : undefined;
  const tools = fileTools({ root, runtimeRoot, assertCurrent() {} });
  const tool = tools.find((t) => t.name === "exec_command");
  assert.ok(tool, "Windows exposes exec_command to the agent");
  const run = async (command: string, timeout = 30, signal?: AbortSignal) => {
    const result = await tool.execute(
      "command-check",
      { command, timeout },
      signal,
    );
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  const waitFor = async (name: string) => {
    for (let i = 0; i < 200; i++) {
      try {
        return await readFile(path.join(root, name), "utf8");
      } catch {}
      await delay(100);
    }
    throw new Error("Command child did not start");
  };
  const assertDead = async (pid: number) => {
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await delay(100);
    }
    assert.fail("A command descendant survived completion or cancellation");
  };
  // Synthetic sentinels only. Never inspect or print actual credentials.
  const injected = {
    VIBE_COMMAND_TEST_SECRET: "synthetic-sentinel",
    NODE_OPTIONS: "--invalid-test-option",
  };
  const saved = Object.fromEntries(
    Object.keys(injected).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, injected);
  try {
    await writeFile(
      path.join(root, "edit.mjs"),
      `
import { readFileSync, writeFileSync } from 'node:fs';
if (process.env.VIBE_COMMAND_TEST_SECRET || process.env.NODE_OPTIONS) throw Error('inherited environment');
const file = '电路.circ';
writeFileSync(file, '<project><circuit name="main"/></project>', 'utf8');
writeFileSync(file, readFileSync(file, 'utf8').replace('main', '修改后'), 'utf8');
console.log('脚本完成', process.version);
`,
    );
    const edited = await run(
      "node ./edit.mjs\n[xml]$circuit = Get-Content -LiteralPath './电路.circ' -Raw\n$circuit.project.circuit.name",
    );
    assert.equal(edited.exitCode, 0, edited.output);
    assert.match(edited.output, /脚本完成 v24\./);
    assert.match(edited.output, /修改后/);
    assert.equal(
      await readFile(path.join(root, "电路.circ"), "utf8"),
      '<project><circuit name="修改后"/></project>',
    );
    assert.equal((await run("exit 7")).exitCode, 7);
    assert.equal((await run("node -e 'process.exit(9)'")).exitCode, 9);
    assert.notEqual(
      (await run("Get-Content -LiteralPath './missing-file'")).exitCode,
      0,
    );
    assert.notEqual((await run("throw 'synthetic failure'")).exitCode, 0);
    const long = await run(
      "#" + "long command ".repeat(4000) + "\nWrite-Output 'long-ok'",
    );
    assert.equal(long.exitCode, 0, long.output);
    assert.match(long.output, /long-ok/);
    const noisy = await run(
      "Write-Output ('x' * 70000)\nWrite-Output 'tail-marker'",
    );
    assert.equal(noisy.truncated, true);
    assert.equal(noisy.output.length, 64000);
    assert.match(noisy.output, /tail-marker/);
    const references = await run(
      "Test-Path -LiteralPath (Join-Path $env:VIBE_CIRCUIT_REFERENCE 'index.md')",
    );
    assert.match(references.output, /True/);
    if (runtimeRoot) {
      const java = await run("java -version");
      assert.equal(java.exitCode, 0, java.output);
      assert.match(java.output, /version "21\./);
    }

    await writeFile(
      path.join(root, "child.mjs"),
      `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    // The shell is cancelled while a real descendant is still running.
    const controller = new AbortController();
    const cancelled = assert.rejects(
      run("node ./child.mjs cancelled.pid", 0, controller.signal),
      /停止|超时/,
    );
    const cancelledPid = Number(await waitFor("cancelled.pid"));
    controller.abort();
    await cancelled;
    await assertDead(cancelledPid);

    const timed = assert.rejects(
      run("node ./child.mjs timed.pid", 6),
      /停止|超时/,
    );
    const timedPid = Number(await waitFor("timed.pid"));
    await timed;
    await assertDead(timedPid);

    // A detached grandchild must also end when its launching shell succeeds.
    await writeFile(
      path.join(root, "detach.mjs"),
      `
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const child = spawn(process.execPath, ['child.mjs', 'detached.pid'], { detached: true, stdio: 'ignore' });
child.unref();
const timer = setInterval(() => { if (existsSync('detached.pid')) clearInterval(timer); }, 20);
`,
    );
    const detached = await run("node ./detach.mjs", 0);
    assert.equal(detached.exitCode, 0, detached.output);
    await assertDead(Number(await waitFor("detached.pid")));
    await assert.rejects(
      run("Write-Output 'never'", 0, AbortSignal.abort()),
      /abort/i,
    );
    await assert.rejects(run("Write-Output 'never'", -1), /timeout/);
    console.log(
      "Verified Windows command execution, UTF-8 circuit edits, bundled runtimes, exit codes, clean environment, long commands, cancellation, timeout and descendant cleanup.",
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
