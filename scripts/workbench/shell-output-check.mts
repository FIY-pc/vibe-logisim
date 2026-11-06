/** Actual Linux sandbox and public Pi wrappers; no model service is used. */
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getEventListeners } from "node:events";
import {
  fileTools,
  SANDBOX_REFERENCE,
} from "../../packages/agent-runtime/src/tools/files.mts";
import {
  ToolOutputStore,
  OUTPUT_MOUNT,
} from "../../packages/agent-runtime/src/tools/output-store.mts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

if (process.platform !== "linux") {
  console.log("Linux shell output checks run on Linux.");
} else {
  const temporary = await mkdtemp(path.join(tmpdir(), "vibe-shell-output-"));
  const root = path.join(temporary, "project [中文]");
  const outputs = new ToolOutputStore(path.join(temporary, "outputs [日志]"));
  await mkdir(root);
  const tools = fileTools({ root, outputs, assertCurrent() {} });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const text = (value: AgentToolResult<any>) =>
    value.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
  const run = (
    command: string,
    timeout?: number,
    signal?: AbortSignal,
    updates?: AgentToolResult<any>[],
  ) =>
    tool("exec_command").execute(
      "shell-check",
      { command, ...(timeout !== undefined ? { timeout } : {}) },
      signal,
      (update) => updates?.push(update),
    );
  const read = (file: string, offset?: number, limit?: number) =>
    tool("read_file").execute("read-check", { path: file, offset, limit });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const original = Buffer.from(
    Array.from(
      { length: 18000 },
      (_, i) =>
        `${String(i + 1).padStart(5, "0")} ${i === 0 ? "BEGIN" : i === 9000 ? "MIDDLE" : i === 17999 ? "END" : "DATA"} ${"中文输出🧪".repeat(6)}\n`,
    ).join(""),
  );
  const waitFor = async (file: string) => {
    for (let i = 0; i < 200; i++) {
      try {
        return await readFile(path.join(root, file), "utf8");
      } catch {}
      await delay(25);
    }
    assert.fail(`Command did not write ${file}`);
  };
  const assertDead = async (pid: number) => {
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await delay(25);
    }
    assert.fail("A sandbox descendant survived termination");
  };
  const checkLog = async (value: AgentToolResult<any>, expected = original) => {
    assert.equal(value.details.outputArtifacts.length, 1);
    const artifact = value.details.outputArtifacts[0];
    assert.equal(artifact.path, `${OUTPUT_MOUNT}/${artifact.id}`);
    assert.equal(artifact.bytes, expected.length);
    assert.deepEqual(
      await readFile((await outputs.resolve(artifact.path))!),
      expected,
    );
    assert.ok(text(value).includes(artifact.path));
    assert.ok(text(value).includes("END"));
    assert.ok(!text(value).includes("BEGIN"));
    assert.ok(!text(value).includes("\uFFFD"));
    assert.doesNotMatch(JSON.stringify(value), /pi-bash-/);
    assert.ok(Buffer.byteLength(text(value)) < 52000);
    return artifact;
  };
  const secret = process.env.VIBE_COMMAND_TEST_SECRET;
  process.env.VIBE_COMMAND_TEST_SECRET = "synthetic-sentinel";
  try {
    await writeFile(path.join(root, "long.txt"), original);
    // Record Pi files only by name, to check that successfully imported files
    // are removed. Do not inspect other processes' logs.
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("pi-bash-")),
    );
    const updates: AgentToolResult<any>[] = [];
    const success = await run("cat long.txt", undefined, undefined, updates);
    assert.equal(success.details.exitCode, 0, text(success));
    assert.ok(!success.isError);
    const artifact = await checkLog(success);
    assert.ok(updates.some((update) => text(update).length > 0));
    for (const update of updates) {
      assert.equal(update.details?.fullOutputPath, undefined);
      assert.doesNotMatch(JSON.stringify(update), /pi-bash-/);
    }
    assert.deepEqual(
      new Set(
        (await readdir(tmpdir())).filter((name) => name.startsWith("pi-bash-")),
      ),
      before,
    );
    assert.match(text(await read(artifact.path, 1, 1)), /00001 BEGIN/);
    assert.match(text(await read(artifact.path, 9001, 1)), /09001 MIDDLE/);
    const searched = await run(`grep -n 'MIDDLE' ${quote(artifact.path)}`);
    assert.equal(searched.details.exitCode, 0, text(searched));
    assert.match(text(searched), /9001:09001 MIDDLE/);
    const denied = await run(`printf changed >> ${quote(artifact.path)}`);
    assert.equal(denied.isError, true);
    assert.notEqual(denied.details.exitCode, 0);
    assert.match(text(denied), /Read-only file system|Permission denied/);
    await assert.rejects(
      tool("write_file").execute("deny-log", {
        path: artifact.path,
        content: "changed",
      }),
      /只读/,
    );
    await assert.rejects(read(`${OUTPUT_MOUNT}/../long.txt`));
    await assert.rejects(read("/etc/passwd"), /路径不在/);
    await symlink(
      path.join(temporary, "outside.txt"),
      path.join(root, "outside-link"),
    );
    await writeFile(path.join(temporary, "outside.txt"), "outside");
    await assert.rejects(read("outside-link"), /链接指向/);
    await assert.rejects(
      tool("write_file").execute("deny-ref", {
        path: `${SANDBOX_REFERENCE}/index.md`,
        content: "changed",
      }),
    );
    const env = await run("printf '%s' \"${VIBE_COMMAND_TEST_SECRET-unset}\"");
    assert.equal(text(env), "unset");
    assert.equal(
      (await run(`test -e ${quote(path.join(temporary, "outside.txt"))}`))
        .details.exitCode,
      1,
    );

    const nonzero = await run("cat long.txt; exit 7");
    assert.equal(nonzero.details.exitCode, 7);
    assert.equal(nonzero.isError, true);
    assert.match(text(nonzero), /Command exited with code 7/);
    await checkLog(nonzero);
    const timeout = await run(
      "cat long.txt; sleep 30 & echo $! > timed.pid; wait",
      1,
    );
    assert.equal(timeout.isError, true);
    assert.match(text(timeout), /Command timed out after 1 seconds/);
    await checkLog(timeout);
    await assertDead(Number(await waitFor("timed.pid")));
    const controller = new AbortController();
    const running = run(
      "cat long.txt; sleep 30 & echo $! > cancelled.pid; wait",
      0,
      controller.signal,
    );
    const pid = Number(await waitFor("cancelled.pid"));
    controller.abort();
    const cancelled = await running;
    assert.equal(cancelled.isError, true);
    assert.match(text(cancelled), /Command aborted/);
    await checkLog(cancelled);
    await assertDead(pid);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    const alreadyStopped = await run(
      "touch should-not-exist",
      0,
      AbortSignal.abort(),
    );
    assert.equal(alreadyStopped.isError, true);
    assert.match(text(alreadyStopped), /Command aborted/);
    await assert.rejects(readFile(path.join(root, "should-not-exist")));
    assert.equal(text(await run("printf unlimited", 0)), "unlimited");
    await assert.rejects(run("true", -1), /timeout/);

    // Pi's oversized-line hint is executable in this sandbox, including quotes.
    const wide = "wide 'quote'.txt";
    await writeFile(
      path.join(root, wide),
      "short\n" + "y".repeat(600000) + "\n",
    );
    const hint = text(await read(wide, 2));
    assert.match(hint, /Use exec_command/);
    assert.ok(hint.includes("/tmp/workspace/"));
    const example = hint.split("for example: ")[1].slice(0, -1);
    assert.equal(text(await run(example)), "y".repeat(4096) + "\n");
    // The caller chooses a later byte range; this is not a single-line dead end.
    assert.equal(
      text(await run(`tail -c 100 ${quote(wide)}`)),
      "y".repeat(99) + "\n",
    );
    await mkdir(path.join(root, "many"));
    for (let i = 0; i < 510; i++)
      await writeFile(path.join(root, "many", String(i)), "");
    const listing = await tool("list_files").execute("list-check", {
      path: "many",
    });
    assert.equal(JSON.parse(text(listing)).length, 510);
    assert.deepEqual(
      await readFile((await outputs.resolve(artifact.path))!),
      original,
    );
    console.log(
      `Verified real Linux sandbox: ${original.length} UTF-8 bytes retained; first/middle reads, grep, exit 7, timeout/cancel logs and descendants, readonly paths, long lines, and 510 directory entries.`,
    );
  } finally {
    if (secret === undefined) delete process.env.VIBE_COMMAND_TEST_SECRET;
    else process.env.VIBE_COMMAND_TEST_SECRET = secret;
    await rm(temporary, { recursive: true, force: true });
  }
}
