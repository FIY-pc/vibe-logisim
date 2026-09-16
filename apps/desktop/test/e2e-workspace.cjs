"use strict";
const {simulationMenu}=require("./support/simulation-menu.cjs");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {waitUntil} = require("./support/wait-until.cjs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const repoRoot = path.resolve(__dirname, "../../..");
const circuit = process.env.VIBE_E2E_CIRCUIT || path.join(repoRoot, "archive/tooling/tmp/half_adder.circ");
const chrome = process.env.VIBE_CHROME || [
  path.join(os.homedir(), ".local/bin/google-chrome"), "/usr/bin/google-chrome", "/usr/bin/chromium",
].find(fs.existsSync);

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = chunk => {
      output += chunk.toString();
      const match = output.match(/^Circuit Lens: (http:\/\/127\.0\.0\.1:\d+)\/?$/m);
      if (match) resolve(match[1]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Circuit service exited (${code}): ${output.slice(-2000)}`)));
  });
}

async function main() {
  assert.equal(fs.existsSync(circuit), true, `missing circuit: ${circuit}`);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-logisim-e2e-"));
  const sourceFile = path.join(stateDir, path.basename(circuit));
  fs.copyFileSync(circuit, sourceFile);
  const service = spawn("python3", [path.join(repoRoot, "apps/desktop/circuit-lens/server.py"), "--no-browser", "--port", "0", "--state-dir", stateDir, sourceFile], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  const url = await waitForUrl(service);
  const browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(350);
    assert.equal(await page.locator(".circuit-component").count(), 6);
    assert.equal(await page.locator(".wire-group").count(), 11);
    await page.locator(".circuit-component").first().click();
    assert.equal(await page.locator(".circuit-component.is-selected").count(), 1);
    assert.match(await page.locator("#objectInspector").textContent(), /属性/);
    const before = await page.evaluate(() => fetch("/api/session").then(response => response.json()).then(value => value.revision.id));
    await simulationMenu(page,'simulationStart');
    await page.waitForTimeout(750);
    assert.equal(await page.evaluate(() => fetch("/api/simulation").then(response => response.json()).then(value => Boolean(value.session))), true);
    const watch = page.getByRole("button", { name: "观察端口 0", exact: true });
    await watch.click();
    assert.equal(await page.locator(".signal-watch").count(), 1);
    assert.equal(await watch.getAttribute("aria-pressed"), "true");
    await watch.click();
    assert.equal(await page.locator(".signal-watch").count(), 0);
    await simulationMenu(page,'simulationStop');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => fetch("/api/simulation").then(response => response.json()).then(value => value.session)), null);
    const after = await page.evaluate(() => fetch("/api/session").then(response => response.json()).then(value => value.revision.id));
    assert.equal(after, before);
    // Supply a deterministic agent submission, then exercise the real review
    // and apply UI. This tests collaboration plumbing, not model capability.
    const original = fs.readFileSync(sourceFile, "utf8");
    const changed = original.replace('val="sum"', 'val="result"');
    assert.notEqual(changed, original);
    const session = await (await page.request.get(`${url}/api/session`)).json();
    const submission = await page.request.post(`${url}/api/agent/tool`, { data: {
      projectId: session.workspace.id, revisionId: before, tool: "submit_circuit",
      arguments: { circuitXml: changed, title: "Rename sum" },
    } });
    assert.equal(submission.ok(), true, await submission.text());
    await page.locator("#proposalTab").click();
    await page.locator(".candidate-card").filter({ hasText: "Rename sum" }).getByRole("button", { name: "查看改动" }).click();
    await page.locator("#comparisonDialog").waitFor({ state: "visible" });
    await waitUntil(()=>page.locator("#comparisonSummary").textContent().then(t=>t.includes("连接关系未变")));
    await page.locator("#comparisonBefore").click();
    assert.equal(await page.locator("#comparisonBefore").getAttribute("aria-pressed"), "true");
    await page.locator("#comparisonAfter").click();
    await page.locator("#comparisonPrimary").click();
    await waitUntil(() => page.evaluate(() => fetch("/api/session").then(r => r.json())).then(s => s.revision.id !== before));
    await page.locator("#comparisonDialog").waitFor({ state: "hidden" });
    assert.equal(fs.readFileSync(sourceFile, "utf8"), original, "applying must not save the source");
    await page.locator("#projectHistoryButton").click();
    await page.locator("#projectHistory .history-entry").first().click();
    await page.locator("#comparisonDialog").waitFor({ state: "visible" });
    await waitUntil(()=>page.locator("#comparisonSummary").textContent().then(t=>t.includes("连接关系未变")));
    assert.equal(await page.locator("#comparisonKind").textContent(), "工程历史");
    assert.equal(await page.locator("#comparisonPrimary").isEnabled(), false);
    await page.locator("#comparisonClose").click();
    await page.locator("#undoButton").click();
    await waitUntil(() => page.evaluate(() => fetch("/api/session").then(r => r.json())).then(s => s.revision.id === before));
    assert.equal(fs.readFileSync(sourceFile, "utf8"), original);
    // Hold A's real native preview response, then open an equal-content B.
    // Completing A must not reopen its dialog over the new project.
    await page.locator("#pendingChangesButton").click();
    let releasePreview, previewArrived;
    const previewGate = new Promise(resolve => { releasePreview = resolve; });
    const arrived = new Promise(resolve => { previewArrived = resolve; });
    await page.route("**/api/comparison?*", async route => {
      const response = await route.fetch();
      previewArrived();
      await previewGate;
      await route.fulfill({ response });
    });
    await page.locator(".candidate-card").filter({ hasText: "Rename sum" }).getByRole("button", { name: "查看改动" }).click();
    await arrived;
    try {
      await page.locator("#fileInput").setInputFiles({ name: "isolated-copy.circ", mimeType: "application/xml", buffer: Buffer.from(original) });
      await page.waitForFunction(() => document.querySelector("#workspaceName").textContent.includes("isolated-copy"));
      const changedProject = await (await page.request.get(`${url}/api/session`)).json();
      assert.notEqual(changedProject.workspace.id, session.workspace.id);
      assert.equal(changedProject.revision.id, before);
    } finally { releasePreview(); }
    await page.waitForResponse(response => response.url().includes("/api/comparison?"));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#comparisonDialog").isVisible(), false);
    // Select a real SVG wire through its keyboard interaction, delete, then
    // undo. Native reload must validate the proposed circuit, not the old one.
    await page.waitForFunction(() => document.querySelector('#appShell').getAttribute('aria-busy') === 'false');
    await page.locator('.wire-group').first().press('Enter');
    assert.equal(await page.locator('.is-selected-wire').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.is-selected-wire').count(), 0);
    assert.equal(await page.locator('#deleteSelectionButton').isEnabled(), false);
    await page.locator('.wire-group').first().press('Enter');
    // Make only the derived connection index unwritable in this temporary
    // workspace; the authoritative project record remains writable.
    const pointerPath = path.join(stateDir, 'current.json');
    fs.unlinkSync(pointerPath);
    fs.mkdirSync(pointerPath);
    try {
      await page.keyboard.press('Delete');
      await page.waitForFunction(() => document.querySelectorAll('.wire-group').length === 10 && document.querySelector('#appShell').getAttribute('aria-busy') === 'false');
      await page.locator('#connectionWarning').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#undoButton').isEnabled(), true);
    } finally { fs.rmdirSync(pointerPath); }
    await page.locator('#connectionWarning').waitFor({ state: 'hidden' });
    await page.locator('#undoButton').click();
    await page.waitForFunction(() => document.querySelectorAll('.wire-group').length === 11 && document.querySelector('#appShell').getAttribute('aria-busy') === 'false');
    assert.equal(await page.evaluate(() => fetch('/api/session').then(r => r.json()).then(s => s.revision.id)), before);
    const romCircuit = original.replace('</circuit>', `<comp lib="5" loc="(700,400)" name="ROM">
      <a name="addrWidth" val="8"/><a name="dataWidth" val="8"/>
      <a name="label" val="Program"/><a name="contents">addr/data: 8 8\nab cd</a>
    </comp></circuit>`);
    await page.locator("#fileInput").setInputFiles({ name: "memory-check.circ", mimeType: "application/xml", buffer: Buffer.from(romCircuit) });
    await page.waitForFunction(() => document.querySelector("#workspaceName").textContent.includes("memory-check"));
    await page.locator("#evidenceTab").click();
    const rom = page.getByRole("button", { name: "Program，ROM", exact: true });
    await rom.click();
    const viewport = await page.locator("#circuitCanvas").getAttribute("viewBox");
    await page.locator(".object-memory").click();
    await page.locator('#memoryContent input[data-address="0"]').waitFor();
    assert.equal((await page.locator('#memoryContent input[data-address="0"]').inputValue()).toLowerCase(), "ab");
    const romRevision = await page.evaluate(() => fetch('/api/session').then(r => r.json()).then(s => s.revision.id));
    const firstWord = page.locator('#memoryContent input[data-address="0"]');
    await firstWord.fill('12');
    await firstWord.press('Enter');
    await page.waitForFunction(() => document.querySelector('#memoryContent input[data-address="0"]')?.value === '12' && !document.querySelector('#memoryContent input[data-address="0"]')?.disabled);
    assert.notEqual(await page.evaluate(() => fetch('/api/session').then(r => r.json()).then(s => s.revision.id)), romRevision);
    await page.locator("#memoryNext").click();
    await page.locator('#memoryContent input[data-address="64"]').waitFor();
    await page.locator("#memoryPrev").click();
    await page.locator('#memoryContent input[data-address="0"]').waitFor();
    await page.locator("#memoryClose").click();
    assert.equal(await page.locator("#memoryPanel").isVisible(), false);
    await page.waitForFunction(expected => document.querySelector("#circuitCanvas").getAttribute("viewBox") === expected, viewport);
    await page.locator('#undoButton').click();
    await waitUntil(() => page.evaluate(() => fetch('/api/session').then(r => r.json())).then(s => s.revision.id === romRevision));
    await page.waitForFunction(() => document.querySelector('#appShell').getAttribute('aria-busy') === 'false');
    await rom.click();
    await page.locator('.object-memory').click();
    await page.waitForFunction(() => document.querySelector('#memoryContent input[data-address="0"]')?.value.toLowerCase() === 'ab');
    await page.locator('#memoryClose').click();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ circuit: path.basename(circuit), selected: true, simulation: "start-stop", revisionStable: true, candidate: "review-apply-undo", sourceUnchanged: true, stalePreviewDiscarded: true, wire: "delete-undo", rom: "read-edit-page-undo", connectionIndex: "failure-warning-recovery" }));
  } finally {
    await browser.close();
    service.kill("SIGTERM");
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
