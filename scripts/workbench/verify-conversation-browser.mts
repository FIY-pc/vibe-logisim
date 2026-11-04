/** Run with npm run test:conversation-browser. Uses installed Chrome by default;
 * set BROWSER_PATH for another Chromium, or install Playwright Chromium and set
 * BROWSER_CHANNEL=chromium. All data is synthetic and the server uses a free port. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temp = await fs.mkdtemp(
  path.join(os.tmpdir(), "vibe-conversation-browser-"),
);
await build({
  entryPoints: [path.join(root, "scripts/workbench/browser/conversation.tsx")],
  bundle: true,
  jsx: "automatic",
  format: "esm",
  outfile: path.join(temp, "fixture.js"),
  plugins: [
    {
      name: "synthetic-runtime",
      setup(builder) {
        builder.onResolve({ filter: /\?worker&url$/ }, () => ({
          path: "worker",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: 'export default "worker.js";',
        }));
        builder.onLoad({ filter: /[\\/]shared[\\/]transport\.ts$/ }, () => ({
          contents:
            "export const command=(v)=>globalThis.__command(v);export const desktop=()=>false;export const openPath=async()=>null;export const savePath=async()=>null;",
        }));
        builder.onLoad({ filter: /[\\/]shared[\\/]events\.ts$/ }, () => ({
          contents:
            "export const subscribeEvents=(fn)=>globalThis.__subscribe(fn);",
        }));
      },
    },
  ],
});
const server = createServer(async (request, response) => {
  const asset =
    request.url === "/fixture.js"
      ? "fixture.js"
      : request.url === "/fixture.css"
        ? "fixture.css"
        : null;
  response.setHeader(
    "Content-Type",
    asset?.endsWith("js")
      ? "text/javascript"
      : asset
        ? "text/css"
        : "text/html",
  );
  response.end(
    asset
      ? await fs.readFile(path.join(temp, asset))
      : '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>',
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
const browser = await chromium
  .launch({
    headless: true,
    channel: process.env.BROWSER_CHANNEL || "chrome",
    executablePath: process.env.BROWSER_PATH,
  })
  .catch(async (error) => {
    server.close();
    await fs.rm(temp, { recursive: true, force: true });
    throw error;
  });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const bottom = () =>
  page.waitForFunction(() => {
    const e = document.querySelector(".messages")!;
    return e.scrollHeight - e.clientHeight - e.scrollTop < 34;
  });
const position = () => page.locator(".messages").evaluate((e) => e.scrollTop);
const scroll = async (top: number) => {
  if (top === 0) {
    await page.locator(".messages").focus();
    await page.keyboard.press("Home");
  }
  await page
    .locator(".messages")
    .evaluate((e, top) => e.scrollTo({ top }), top);
  await page.waitForTimeout(180);
};
const choose = async (id: string) => {
  await page.locator(".conversation-picker").click();
  await page
    .locator('.conversation-list [role="option"]')
    .filter({ hasText: new RegExp(`^${id}$`) })
    .click();
};
try {
  await page.addInitScript(() => {
    if (
      localStorage.getItem("vibe.draft:fixture-folder:long:references") !== null
    )
      return;
    localStorage.setItem(
      "vibe.draft:fixture-folder:long:references",
      JSON.stringify(
        Array.from({ length: 8 }, (_, i) => ({
          id: `reference-${i}`,
          kind: "material",
          label: "Reference document.pdf",
          path: "reference.pdf",
          page: 20,
          region: { x: 0.1, y: i / 10, width: 0.5, height: 0.08 },
          hasImage: true,
        })),
      ),
    );
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator('[data-segment="q-599"]').waitFor();
  await page.setViewportSize({ width: 360, height: 640 });
  const composer = page.getByRole("group", { name: "消息编辑器" });
  const editor = page.getByRole("textbox", { name: "消息", exact: true });
  await editor.fill("Review the selected regions.\n".repeat(40));
  await editor.press("Shift+Enter");
  const geometry = await composer.evaluate((root) => {
    const attachments = root.querySelector<HTMLElement>(
      ".ui-message-composer-attachments",
    )!;
    const input = root.querySelector<HTMLTextAreaElement>("textarea")!;
    const field = input.parentElement!;
    const actions = root.querySelector("footer")!;
    return {
      frame: getComputedStyle(root).outlineWidth,
      inputShadow: getComputedStyle(field).boxShadow,
      inputOutline: getComputedStyle(field).outlineStyle,
      attachmentOverflow: attachments.scrollHeight > attachments.clientHeight,
      inputOverflow: input.scrollHeight > input.clientHeight,
      separate:
        attachments.getBoundingClientRect().bottom <=
          input.getBoundingClientRect().top &&
        input.getBoundingClientRect().bottom <=
          actions.getBoundingClientRect().top,
      contained:
        root.getBoundingClientRect().left >= 0 &&
        root.getBoundingClientRect().right <= innerWidth &&
        actions.getBoundingClientRect().bottom <= innerHeight,
    };
  });
  assert.deepEqual(
    geometry,
    {
      frame: "2px",
      inputShadow: "none",
      inputOutline: "none",
      attachmentOverflow: true,
      inputOverflow: true,
      separate: true,
      contained: true,
    },
    JSON.stringify(
      await composer.evaluate((node) =>
        [node, node.parentElement!, node.parentElement!.parentElement!].map(
          (element) => ({
            className: element.className,
            bounds: element.getBoundingClientRect().toJSON(),
            minWidth: getComputedStyle(element).minWidth,
          }),
        ),
      ),
    ),
  );
  assert(
    (await editor.inputValue()).endsWith("\n\n"),
    "Shift+Enter inserts a newline without sending",
  );
  const attachments = composer.getByRole("region", { name: "待发送引用" });
  await attachments.focus();
  await attachments.press("End");
  await page.waitForFunction(
    () =>
      document.querySelector(".ui-message-composer-attachments")!.scrollTop > 0,
  );
  await composer.getByRole("button", { name: "发送", exact: true }).focus();
  assert.equal(
    await composer.evaluate((node) => getComputedStyle(node).outlineWidth),
    "2px",
    "Action focus retains the whole field boundary",
  );
  if (process.env.COMPOSER_SCREENSHOT)
    await page.screenshot({ path: process.env.COMPOSER_SCREENSHOT });
  while (await composer.getByRole("button", { name: /^取消引用/ }).count())
    await composer
      .getByRole("button", { name: /^取消引用/ })
      .first()
      .click();
  await editor.fill("");
  await page.setViewportSize({ width: 1000, height: 900 });
  console.log(
    "PASS: message composer has one focus boundary; eight distinct regions and long text scroll independently without covering actions at 360×640.",
  );
  // Start history checks with settled initial geometry, independent of the
  // composer scenario's viewport and input-height changes.
  await page.reload();
  await page.locator('[data-segment="q-599"]').waitFor();
  await bottom();
  const mounted = await page.locator("[data-segment]").count();
  assert(mounted < 25, `600 turns should not all mount: ${mounted}`);
  console.log(`600 turns / 3000 records: ${mounted} mounted turn rows`);
  const last = page.locator('[data-segment="q-599"]');
  await last.locator(".turn-summary").click();
  await last.locator(".turn-thought > summary").click();
  await last.locator(".turn-tool > summary").click();
  await scroll(0);
  await page.locator('[data-segment="q-0"]').waitFor();
  assert.equal(await last.count(), 0, "Last turn was recycled");
  await scroll(1e9);
  await last.waitFor();
  assert.equal(
    await last.locator('.turn-summary[aria-expanded="true"]').count(),
    1,
  );
  assert.equal(await last.locator(".turn-thought[open]").count(), 1);
  assert.equal(await last.locator(".turn-tool[open]").count(), 1);
  await last.locator(".message-reference").click();
  const followed = await page.evaluate(() => (window as any).fixture.followed);
  assert.equal(followed.href, "./notes.txt");
  assert.equal(followed.message.id, "answer-599");
  assert.equal(followed.message.context.circuit, "circuit-599");
  if (await page.locator(".follow-latest").count())
    await page.locator(".follow-latest").click();
  await page.evaluate(() => (window as any).fixture.start());
  await page.evaluate(() => (window as any).fixture.stream(24));

  await bottom();
  await page.locator(".messages").hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(250);
  const reading = await position();
  await page.evaluate(() => (window as any).fixture.stream(10));
  await page.waitForTimeout(150);
  assert(
    Math.abs((await position()) - reading) < 2,
    "Streaming must not pull the reader down within a tall turn",
  );
  await scroll(0);
  const atTop = await position();
  await page.evaluate(() => (window as any).fixture.stream(10));
  assert(
    Math.abs((await position()) - atTop) < 2,
    "Offscreen streaming must not pull history down",
  );
  await page.evaluate(() => (window as any).fixture.setVisible(false));
  await page.evaluate(() => (window as any).fixture.stream(3));
  await page.evaluate(() => (window as any).fixture.setVisible(true));
  await page.waitForTimeout(200);
  assert(
    Math.abs((await position()) - atTop) < 2,
    "Showing the tab preserves the reading position",
  );
  await page.locator(".follow-latest").click();
  await bottom();
  await page.evaluate(() => (window as any).fixture.stream(5));
  await bottom();
  await page.evaluate(() => (window as any).fixture.setVisible(false));
  await page.evaluate(() => (window as any).fixture.stream(3));
  await page.evaluate(() => (window as any).fixture.setVisible(true));
  await bottom();
  await page.evaluate(() => (window as any).fixture.finish());
  await bottom();
  await choose("other");
  await page.getByText("Another answer", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-segment="q-599"]').count(), 0);
  await choose("empty");
  await page.locator(".conversation-starter").first().waitFor();
  assert.equal(await page.locator("[data-segment]").count(), 0);
  await choose("long");
  await bottom();
  await page.evaluate(() => (window as any).fixture.remount());
  await page.locator('[data-segment="live-user-1"]').waitFor();
  await bottom();
  assert((await page.locator("[data-segment]").count()) < 25);
  assert.deepEqual(
    await page.evaluate(() => (window as any).fixture.errors),
    [],
  );
  assert.deepEqual(errors, []);
  if (process.env.CONVERSATION_SCREENSHOT)
    await page.screenshot({ path: process.env.CONVERSATION_SCREENSHOT });
  console.log(
    "PASS: virtual row recycling preserves all disclosures and reference context; streaming follows only at bottom; history reading, hidden tabs, switching, empty state and remount work.",
  );
} catch (error) {
  await page.screenshot({
    path:
      process.env.CONVERSATION_SCREENSHOT ||
      path.join(os.tmpdir(), "vibe-conversation-failure.png"),
  });
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await fs.rm(temp, { recursive: true, force: true });
}
