/** Real product menu -> Rust host -> sidecar -> ZIP; synthetic history, no model calls.
 * Build the host first. VIBE_EXPORT_EVIDENCE optionally retains the ZIP and screenshot.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createServer as reservePort } from "node:net";
import { chromium } from "playwright";
import { unzipSync, strFromU8 } from "fflate";
import {
  conversationExportFixture,
  fixtureId,
  fullOutput,
  savedOutput,
  outputId,
  writeConversationOutputs,
} from "./fixtures/conversation-export.mts";
import { exportRecord } from "../../packages/agent-runtime/src/conversations/export.mts";

const root = path.resolve(import.meta.dirname, "../..");
const { createServer } = await import(
  pathToFileURL(
    createRequire(path.join(root, "apps/workbench/package.json")).resolve(
      "vite",
    ),
  ).href
);
const directory = await mkdtemp(
  path.join(tmpdir(), "vibe-conversation-export-"),
);
const state = path.join(directory, "state"),
  folder = path.join(directory, "workspace");
await mkdir(state);
await mkdir(folder);
const reservation = reservePort();
await new Promise<void>((resolve) =>
  reservation.listen(0, "127.0.0.1", resolve),
);
const browserPort = (reservation.address() as { port: number }).port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const child = spawn(
  process.env.VIBE_VERIFY_HOST ||
    path.join(
      root,
      "target/debug/vibe-workbench-host" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
  [],
  {
    cwd: root,
    env: {
      ...process.env,
      VIBE_WORKBENCH_STATE: state,
      VIBE_WORKBENCH_PORT: "0",
      VIBE_WORKBENCH_DEV_PORT: String(browserPort),
      VIBE_LOGISIM_NO_UPDATE_CHECK: "1",
      VIBE_LOGISIM_AGENT_ROOT: root,
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let url = "",
  logs = "";
child.stderr!.on("data", (chunk) => {
  logs += chunk;
  url = logs.match(/Rust host: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] || url;
});
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const command = async (request: unknown) => {
  const response = await fetch(url + "/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
};
try {
  for (let i = 0; i < 200 && !url; i++) {
    assert.equal(child.exitCode, null, logs);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(url, logs);
  const opened = await command({ op: "folderOpen", path: folder });
  const workspaceKey = opened.id;
  const fixture = conversationExportFixture(workspaceKey);
  await writeConversationOutputs(state);
  await writeFile(
    path.join(state, "conversations.json"),
    JSON.stringify(fixture),
  );
  await mkdir(path.join(state, "profile"));
  await writeFile(
    path.join(state, "profile", "private-fixture.txt"),
    "PROFILE_MUST_NOT_BE_EXPORTED",
  );
  const originals = fixture.workspaces[workspaceKey].conversations;
  const request = {
    op: "conversationExport",
    workspace_key: workspaceKey,
    ids: Object.keys(originals),
  };
  const verify = (bytes: Uint8Array, ids: string[]) => {
    const archive = unzipSync(bytes);
    const records = Object.entries(archive).filter(([name]) =>
      name.endsWith("/conversation.json"),
    );
    assert.equal(records.length, ids.length);
    assert.equal(
      Object.keys(archive).length,
      ids.length * 2 +
        1 +
        ids.filter((id) =>
          [fixtureId(0), fixtureId(1), fixtureId(2)].includes(id),
        ).length,
    );
    assert(
      !Object.keys(archive).some(
        (name) => name.includes("profile") || name.includes(".."),
      ),
    );
    const found = records.map(([name, bytes]) => {
      const entry = JSON.parse(strFromU8(bytes));
      const record = entry.conversation;
      assert.deepEqual(
        record,
        JSON.parse(JSON.stringify(exportRecord(originals[record.id]))),
        `Lossless content for ${record.id}`,
      );
      const markdown = strFromU8(archive[name.replace(/\.json$/, ".md")]);
      assert(
        markdown.includes(fullOutput),
        "Readable export includes results beyond the activity preview",
      );
      assert(markdown.includes("ARGUMENT_END_"), "Full tool arguments");
      assert(markdown.includes("Available reasoning summary"));
      for (const artifact of record.outputArtifacts) {
        assert.equal(
          strFromU8(
            archive[
              name.replace("conversation.json", `outputs/${artifact.id}`)
            ],
          ),
          savedOutput,
        );
        assert(markdown.includes(`](outputs/${artifact.id})`));
        assert(!markdown.includes(savedOutput), "Saved blobs stay in files");
      }
      assert(!strFromU8(bytes).includes("not-exported"));
      return record.id;
    });
    assert.deepEqual(found, ids);
    assert(
      !Object.values(archive).some((bytes) =>
        /OTHER_WORKSPACE_NOT_SELECTED|PROFILE_MUST_NOT_BE_EXPORTED|UNREFERENCED_OUTPUT_MUST_NOT_BE_EXPORTED/.test(
          strFromU8(bytes),
        ),
      ),
    );
    return archive;
  };
  const exported = await command(request);
  verify(Buffer.from(exported.data, "base64"), request.ids);
  const read = (args: Record<string, unknown>) =>
    command({
      op: "agent",
      method: "readToolOutput",
      args: { workspaceKey, conversationId: fixtureId(0), ...args },
    });
  let offset = 0,
    reconstructed = "";
  do {
    const page = await read({ id: outputId(0), offset });
    assert(Buffer.byteLength(page.text) <= 64 * 1024);
    reconstructed += page.text;
    offset = page.nextOffset;
  } while (offset !== undefined);
  assert.equal(
    reconstructed,
    savedOutput,
    "UTF-8 pages reproduce the saved output after process startup",
  );
  assert.equal(
    (await read({ toolCallId: "tool-0-598" })).text,
    fullOutput,
    "UI-only clipping reads the original transcript",
  );
  await assert.rejects(read({ id: outputId(1) }), /没有引用/);
  await assert.rejects(read({ id: outputId(999) }), /没有引用/);
  await assert.rejects(
    read({ id: outputId(0), workspaceKey: "other-workspace" }),
    /工作区已切换/,
  );
  await assert.rejects(
    read({ id: outputId(0), conversationId: "other-workspace" }),
    /不属于/,
  );
  await assert.rejects(read({ id: outputId(0), limit: 10000000 }), /范围无效/);
  const outputFile = path.join(
    state,
    "tool-outputs",
    fixtureId(0),
    outputId(0),
  );
  await rm(outputFile);
  await assert.rejects(read({ id: outputId(0) }), /丢失|移除/);
  await assert.rejects(command(request), /缺失|改变/);
  await writeFile(outputFile, savedOutput);
  const saved = path.join(directory, "selected.zip");
  await command({ ...request, ids: [fixtureId(1), fixtureId(2)], path: saved });
  verify(await readFile(saved), [fixtureId(1), fixtureId(2)]);
  await assert.rejects(command({ ...request, path: saved }), /已存在|已经改变/);
  const target = await command({ op: "projectExportTarget", path: saved });
  await command({
    ...request,
    path: saved,
    expected_revision: target.revision,
  });
  verify(await readFile(saved), request.ids);
  await assert.rejects(
    command({ ...request, ids: ["other-workspace"] }),
    /不属于/,
  );
  await assert.rejects(
    command({ ...request, workspace_key: "other-workspace" }),
    /工作区已切换/,
  );
  assert.deepEqual(await readdir(path.join(state, "conversation-exports")), []);

  process.env.VIBE_WORKBENCH_PORT = new URL(url).port;
  vite = await createServer({
    root: path.join(root, "apps/workbench"),
    configFile: path.join(root, "apps/workbench/vite.config.ts"),
    server: { host: "127.0.0.1", port: browserPort, strictPort: true },
    logLevel: "error",
  });
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || "chrome",
    executablePath: process.env.BROWSER_PATH,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(vite.resolvedUrls!.local[0]);
  await page
    .locator('[data-segment="q-0-599"]')
    .waitFor()
    .catch(async (error) => {
      console.error({
        errors,
        body: (await page.locator("body").innerText()).slice(0, 1800),
      });
      throw error;
    });
  assert(
    (await page.locator(".conversation-segment").count()) < 100,
    "Only a fraction of the 600-turn history is mounted",
  );
  const last = page.locator('[data-segment="q-0-599"]');
  await last.locator(".turn-summary").click();
  await last.locator(".turn-tool summary").click();
  await last.getByRole("button", { name: "查看完整输出", exact: true }).click();
  const outputDialog = page.getByRole("dialog", {
    name: "完整工具输出",
    exact: true,
  });
  await outputDialog.locator("pre").waitFor();
  assert(
    (await outputDialog.locator("pre").innerText()).startsWith("保存的输出"),
  );
  assert(
    await outputDialog.getByRole("button", { name: "上一页" }).isDisabled(),
  );
  await outputDialog.getByRole("button", { name: "下一页" }).click();
  await outputDialog
    .getByRole("status")
    .filter({ hasText: "第 2 页 ·" })
    .waitFor();
  await outputDialog.getByRole("button", { name: "上一页" }).click();
  await outputDialog
    .getByRole("status")
    .filter({ hasText: "第 1 页 ·" })
    .waitFor();
  await page.setViewportSize({ width: 640, height: 720 });
  const bounds = await outputDialog.boundingBox();
  assert(
    bounds &&
      bounds.x >= 0 &&
      bounds.x + bounds.width <= 640 &&
      bounds.height <= 720,
  );
  if (process.env.VIBE_EXPORT_EVIDENCE) {
    await mkdir(process.env.VIBE_EXPORT_EVIDENCE, { recursive: true });
    await page.screenshot({
      path: path.join(process.env.VIBE_EXPORT_EVIDENCE, "tool-output-page.png"),
    });
  }
  await outputDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await rm(outputFile);
  await last.getByRole("button", { name: "查看完整输出", exact: true }).click();
  await outputDialog.getByRole("alert").filter({ hasText: "丢失" }).waitFor();
  assert.equal(
    await outputDialog.locator("pre").count(),
    0,
    "A missing file must not display a preview as full output",
  );
  await writeFile(outputFile, savedOutput);
  await outputDialog.getByRole("button", { name: "重试", exact: true }).click();
  await outputDialog.locator("pre").waitFor();
  await outputDialog.getByRole("button", { name: "关闭", exact: true }).click();
  const inline = page.locator('[data-segment="q-0-598"]');
  await inline.locator(".turn-summary").click();
  await inline.locator(".turn-tool summary").click();
  await inline
    .getByRole("button", { name: "查看完整输出", exact: true })
    .click();
  await outputDialog.locator("pre").waitFor();
  assert.equal(
    await outputDialog.locator("pre").textContent(),
    fullOutput,
    "The UI-only preview opens the full persisted transcript text",
  );
  assert(
    await outputDialog.getByRole("button", { name: "下一页" }).isDisabled(),
  );
  await outputDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".conversation-picker").click();
  await page.getByRole("button", { name: "导出会话…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出会话", exact: true });
  await dialog.getByRole("button", { name: "全选", exact: true }).click();
  assert.equal(
    await dialog.getByRole("checkbox", { checked: true }).count(),
    24,
  );
  await dialog.getByRole("button", { name: "取消全选", exact: true }).click();
  assert.equal(
    await dialog.getByRole("checkbox", { checked: true }).count(),
    0,
  );
  assert(
    await dialog.getByRole("button", { name: "导出会话（0）" }).isDisabled(),
  );
  const search = dialog.getByRole("textbox", { name: "查找要导出的会话" });
  await search.fill("重复标题");
  await dialog
    .getByRole("button", { name: "全选当前结果", exact: true })
    .click();
  assert.equal(
    await dialog.getByRole("checkbox", { checked: true }).count(),
    2,
  );
  await search.fill("");
  assert.equal(
    await dialog.getByRole("checkbox", { checked: true }).count(),
    2,
    "Selecting search results must not export hidden unmatched conversations",
  );
  await dialog.getByRole("button", { name: "取消全选", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "长记录：600 回合", exact: true })
    .check();
  const duplicates = dialog.getByRole("checkbox", {
    name: "重复标题 / 会话",
    exact: true,
  });
  assert.equal(await duplicates.count(), 2);
  await duplicates.nth(0).check();
  await duplicates.nth(1).focus();
  await page.keyboard.press("Space");
  const evidence = process.env.VIBE_EXPORT_EVIDENCE;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: path.join(evidence, "conversation-export.png"),
    });
  }
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "导出会话（3）" }).click();
  const download = await downloaded;
  const bytes = await readFile((await download.path())!);
  const archive = verify(bytes, [fixtureId(0), fixtureId(1), fixtureId(2)]);
  const long = Object.entries(archive).find(
    ([name]) => name.includes("600") && name.endsWith(".md"),
  )![1];
  assert(strFromU8(long).includes("Question 0-0\r\n"));
  assert(strFromU8(long).includes("Answer 0-599"));
  if (evidence)
    await writeFile(path.join(evidence, download.suggestedFilename()), bytes);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(state, "conversations.json"), "utf8")),
    fixture,
    "Export does not change saved histories",
  );
  console.log(
    "PASS: scoped UTF-8 output pages and inline transcript fallback; expanded tool row, narrow dialog, previous/next, missing-file retry; selected ZIP includes referenced output bytes and portable links only; 600-turn history, duplicate titles, archived/errors/thinking, browser download and native replacement preserved.",
  );
} finally {
  await browser?.close();
  await vite?.close();
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore" },
      );
      await once(killer, "exit");
    } else child.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
