'use strict';
// Feedback and release checks in the dev Electron shell, with no samples and
// no AI connection: a fake release feed makes the new-version banner appear,
// "忽略此版本" survives a restart, the "…" menu switch stops every startup
// request, and the feedback dialog previews, saves (save dialog stubbed) and
// prefills the GitHub issue page (openExternal stubbed). The saved zip is
// unpacked and checked for the home directory, the folder and file names,
// student numbers and name prefixes; the prefilled fields must match the
// issue form's ids. Last, a missing AI engine puts "反馈这个问题" on the AI
// notice, and the summary carries that failure without its path.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const {_electron} = require('playwright');
const {waitUntil} = require('./support/wait-until.cjs');
const {readZip} = require('../electron/diagnostics-bundle.cjs');
const repo = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-feedback-'));
// A student number and a name prefix in the file name, as coursework often has.
const number = 'U' + '202512345';
const folder = path.join(root, '组原 课设'); fs.mkdirSync(folder);
const circuitName = `${'测试' + '_'}${number}.circ`;
fs.copyFileSync(path.join(repo, 'apps/desktop/electron/templates/blank.circ'), path.join(folder, circuitName));
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'out'); fs.mkdirSync(out, {recursive: true});
const codexHome = path.join(root, 'codex-home-empty'); fs.mkdirSync(codexHome);
const log = [];
const note = m => { const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`; log.push(line); console.log(line); };

const feed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>tag:github.com,2008:Repository/1/v9.9.9</id><link rel="alternate" type="text/html" href="https://github.com/FIY-pc/vibe-logisim/releases/tag/v9.9.9"/><title>Vibe Logisim 9.9.9</title></entry>
<entry><id>tag:github.com,2008:Repository/1/build-inputs</id><link rel="alternate" type="text/html" href="https://github.com/FIY-pc/vibe-logisim/releases/tag/build-inputs"/><title>Build inputs</title></entry></feed>`;
const feedRequests = [];
const server = http.createServer((req, res) => { feedRequests.push(req.url); res.writeHead(200, {'Content-Type': 'application/atom+xml'}); res.end(feed); });

// Field ids of the issue form, which the prefilled URL must use.
const formIds = [...fs.readFileSync(path.join(repo, '.github/ISSUE_TEMPLATE/bug-report.yml'), 'utf8').matchAll(/^\s+id:\s*(\S+)/gm)].map(m => m[1]);

async function launch(port, extra = {}) {
  const env = {...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), VIBE_LOGISIM_STATE_DIR: path.join(root, 'state'), CODEX_HOME: codexHome,
    VIBE_LOGISIM_UPDATE_URL: `http://127.0.0.1:${port}/releases.atom`, ...extra};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VIBE_LOGISIM_NO_UPDATE_CHECK', 'VIBE_LOGISIM_MODEL', 'VIBE_LOGISIM_EFFORT']) delete env[key];
  const app = await _electron.launch({executablePath: require('electron'), args: [path.join(repo, 'apps/desktop'), path.join(folder, circuitName), '--no-sandbox'], env, timeout: 120000});
  const page = await app.firstWindow(); page.setDefaultTimeout(60000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  app.process().stderr.on('data', data => fs.appendFileSync(path.join(root, 'app.log'), data));
  await page.setViewportSize({width: 1440, height: 920});
  await page.waitForFunction(() => document.querySelector('#appShell').getAttribute('aria-busy') !== 'true', null, {timeout: 60000});
  return {app, page, errors};
}

async function menuItem(page, label) {
  await page.locator('#appMenuButton').click();
  await page.locator('#appMenu').getByRole(label === '自动检查更新' ? 'menuitemcheckbox' : 'menuitem', {name: label}).click();
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let phase = 'launch', session = await launch(port), {app, page} = session;
  const shot = name => page.screenshot({path: path.join(out, name + '.png')});
  try {
    const userData = await app.evaluate(({app}) => app.getPath('userData'));
    const logFile = path.join(userData, 'logs', 'vibe-logisim.log');

    phase = 'banner for a newer release';
    await page.locator('#updateBanner').waitFor({state: 'visible', timeout: 30000});
    const bannerText = await page.locator('#updateText').textContent();
    note(`banner: ${bannerText}; feed requests ${feedRequests.length}`);
    assert.match(bannerText, /^新版本 v9\.9\.9 可用（当前 \d+\.\d+\.\d+）$/);
    assert.equal(feedRequests.length, 1);
    await shot('01-update-banner');
    await page.locator('#updateDismiss').click();
    await waitUntil(() => page.locator('#updateBanner').isHidden(), {label: 'banner hidden'});
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'update-check.json'), 'utf8')).dismissedVersion, '9.9.9');

    phase = 'renderer errors reach the log';
    await page.evaluate(() => console.error('e2e renderer marker'));
    await waitUntil(() => fs.existsSync(logFile) && /\[renderer\] 错误：e2e renderer marker/.test(fs.readFileSync(logFile, 'utf8')), {label: 'renderer line in log'});

    phase = 'feedback dialog preview';
    await menuItem(page, '反馈问题…');
    await page.locator('#feedbackDialog').waitFor({state: 'visible'});
    await waitUntil(() => page.locator('#feedbackSave').isEnabled(), {label: 'preview ready'});
    const summary = await page.locator('#feedbackSummary').textContent();
    note('summary:\n' + summary);
    assert.match(summary, /^Vibe Logisim 诊断摘要\n版本：/);
    assert.match(summary, /工作区：已打开（文件夹层级 \d+ · 含非 ASCII：是 · 含空格：是）/);
    const entriesText = async () => (await page.locator('#feedbackEntries li').allTextContents()).map(text => text.split(' · ')[0]);
    assert.deepEqual(await entriesText(), ['README.txt', 'summary.txt', 'report.json', 'tool-failures.json', 'logs/vibe-logisim.log']);
    await page.locator('#feedbackIncludeCircuit').check();
    await waitUntil(async () => (await entriesText()).includes('circuit/current.circ') && page.locator('#feedbackSave').isEnabled(), {label: 'circuit in preview'});
    await shot('02-feedback-dialog');

    phase = 'save the bundle';
    const target = path.join(root, 'saved', 'diagnostics.zip'); fs.mkdirSync(path.dirname(target));
    await app.evaluate(({dialog, shell}, file) => {
      globalThis.__e2e = {saves: [], shown: [], opened: []};
      dialog.showSaveDialog = async (_window, options) => { globalThis.__e2e.saves.push(options.defaultPath); return {canceled: false, filePath: file}; };
      shell.showItemInFolder = file => { globalThis.__e2e.shown.push(file); };
      shell.openExternal = async url => { globalThis.__e2e.opened.push(url); };
    }, target);
    await page.locator('#feedbackSave').click();
    await page.locator('#toast', {hasText: '诊断包已保存'}).waitFor();
    const stubs = await app.evaluate(() => globalThis.__e2e);
    note(`save dialog default: ${path.basename(stubs.saves[0])}`);
    assert.match(path.basename(stubs.saves[0]), /^vibe-logisim-诊断-\d+\.\d+\.\d+-\d{8}-\d{4}\.zip$/);
    assert.deepEqual(stubs.shown, [target]);
    fs.copyFileSync(target, path.join(out, 'diagnostics.zip'));
    const entries = readZip(fs.readFileSync(target));
    note('zip: ' + entries.map(entry => `${entry.name}(${entry.data.length})`).join(', '));
    assert.deepEqual(entries.map(entry => entry.name), ['README.txt', 'summary.txt', 'report.json', 'tool-failures.json', 'logs/vibe-logisim.log', 'circuit/current.circ']);
    const all = entries.map(entry => entry.data.toString('utf8')).join('\n');
    for (const forbidden of [os.homedir(), root, folder, '组原', number, '测试' + '_', circuitName]) assert.equal(all.includes(forbidden), false, `bundle contains ${forbidden}`);
    assert.ok(!/U20[0-9]{7}|[一-鿿]{2,3}_/.test(all), 'bundle passes the personal-data check');
    const report = JSON.parse(entries.find(entry => entry.name === 'report.json').data);
    assert.equal(report.workspace.open, true);
    assert.equal(report.workspace.root.nonAscii, true);
    assert.equal(report.workspace.activeFile.extension, '.circ');
    assert.ok(report.java.version, 'java version probed');
    assert.equal(summary, entries.find(entry => entry.name === 'summary.txt').data.toString());

    phase = 'copy summary and open the issue page';
    await page.locator('#feedbackCopy').click();
    await page.locator('#toast', {hasText: '摘要已复制'}).waitFor();
    assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), summary);
    await page.locator('#feedbackOpenIssue').click();
    const opened = await waitUntil(() => app.evaluate(() => globalThis.__e2e.opened).then(list => list.length && list), {label: 'openExternal'});
    const issue = new URL(opened[0]);
    note(`issue url (${opened[0].length} chars): ${opened[0]}`);
    assert.equal(issue.origin + issue.pathname, 'https://github.com/FIY-pc/vibe-logisim/issues/new');
    assert.ok(opened[0].length <= 8192);
    assert.equal(issue.searchParams.get('template'), 'bug-report.yml');
    for (const field of [...issue.searchParams.keys()].filter(key => key !== 'template')) assert.ok(formIds.includes(field), `issue form has field ${field}`);
    for (const field of ['version', 'os', 'connection']) assert.ok(issue.searchParams.get(field), field);
    await page.locator('#feedbackClose').click();

    phase = 'turn automatic checks off';
    await menuItem(page, '自动检查更新');
    await page.locator('#toast', {hasText: '已关闭自动检查更新'}).waitFor();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'app-preferences.json'), 'utf8')), {updateCheck: false});
    const logText = fs.readFileSync(logFile, 'utf8');
    assert.match(logText, /\[main\] Vibe Logisim \S+（源码运行）启动/);
    assert.match(logText, /\[update\] 最新发布 9\.9\.9/);
    assert.equal(logText.includes(os.homedir() + path.sep), false, 'log has no home paths');
    assert.ok(session.errors.length === 0, 'page errors: ' + session.errors.join(' | '));
    await app.close();

    phase = 'restart: no request, no banner';
    const before = feedRequests.length;
    session = await launch(port); ({app, page} = session);
    await new Promise(resolve => setTimeout(resolve, 8000));
    assert.equal(feedRequests.length, before, 'switched off: no request at startup');
    assert.equal(await page.locator('#updateBanner').isHidden(), true);
    await page.locator('#appMenuButton').click();
    assert.equal(await page.locator('#appMenu').getByRole('menuitemcheckbox', {name: '自动检查更新'}).getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Escape');

    phase = 'manual check shows the ignored version again';
    await menuItem(page, '立即检查更新');
    await page.locator('#updateBanner').waitFor({state: 'visible'});
    assert.equal(feedRequests.length, before + 1);
    assert.equal(await page.locator('#agentReportIssue').isHidden(), true, 'no failure: no report button on the notice');
    await shot('03-manual-check');
    assert.ok(session.errors.length === 0, 'page errors: ' + session.errors.join(' | '));
    await app.close();

    phase = 'a failed AI connection offers a report';
    session = await launch(port, {VIBE_LOGISIM_CODEX: path.join(root, 'missing-codex')}); ({app, page} = session);
    await waitUntil(() => page.evaluate(() => window.vibeDesktop.agent.getState()).then(state => state.status === 'unavailable'), {timeout: 60000, label: 'agent unavailable'});
    await page.locator('#agentTab').click().catch(() => {});
    await page.locator('#agentReportIssue').waitFor({state: 'visible'});
    await shot('04-report-from-notice');
    await page.locator('#agentReportIssue').click();
    await waitUntil(() => page.locator('#feedbackSave').isEnabled(), {label: 'preview ready'});
    const failed = await page.locator('#feedbackSummary').textContent();
    note('summary after failure:\n' + failed);
    assert.match(failed, /AI 状态：连接失败/);
    assert.match(failed, /最近错误：.*<路径>/);
    assert.equal(failed.includes(root), false, 'summary has no paths');
    assert.ok(session.errors.length === 0, 'page errors: ' + session.errors.join(' | '));
    note('PASS');
  } catch (error) {
    note(`FAIL in phase "${phase}": ${error.stack || error}`);
    await shot('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, 'e2e-feedback.log'), log.join('\n') + '\n');
    await app.close().catch(() => {});
    server.close();
    if (!process.exitCode) fs.rmSync(root, {recursive: true, force: true});
  }
})();
