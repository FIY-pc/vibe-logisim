'use strict';
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {UpdateChecker, latestRelease, parseVersion, compareVersions} = require('./update-check.cjs');

const entry = (tag, href = `https://github.com/FIY-pc/vibe-logisim/releases/tag/${tag}`) =>
  `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>2026-09-26T00:00:00Z</updated><link rel="alternate" type="text/html" href="${href}"/><title>${tag}</title><content type="html">&lt;entry&gt;not a tag&lt;/entry&gt;</content></entry>`;
// Newest release first, but an older one was edited later; build-inputs is not a version.
const FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entry('v0.3.1')}${entry('v0.10.0')}${entry('v0.9.9')}${entry('build-inputs')}</feed>`;

const requests = [];
let behaviour = 'ok';
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (behaviour === 'slow') return setTimeout(() => { res.writeHead(200); res.end(FEED); }, 800);
  if (behaviour === 'forbidden') { res.writeHead(403); return res.end('rate limited'); }
  res.writeHead(200, {'Content-Type': 'application/atom+xml'}); res.end(FEED);
});
const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());

async function checker(options = {}) {
  await ready;
  const stateDir = options.stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-update-'));
  let clock = Date.parse('2026-09-27T08:00:00Z');
  const logs = [];
  const updates = new UpdateChecker({currentVersion: '0.3.1', stateDir, fetch: globalThis.fetch,
    feedUrl: `http://127.0.0.1:${server.address().port}/releases.atom`, now: () => clock, timeoutMs: 300, log: line => logs.push(line), ...options});
  return {updates, stateDir, logs, advance: ms => { clock += ms; }};
}

test('the feed yields the highest plain x.y.z release and its page', () => {
  assert.deepEqual(latestRelease(FEED), {version: '0.10.0', tag: 'v0.10.0', url: 'https://github.com/FIY-pc/vibe-logisim/releases/tag/v0.10.0'});
  assert.equal(latestRelease('<feed></feed>'), null);
  // A release page outside github.com is replaced by the canonical one.
  assert.equal(latestRelease(`<feed>${entry('v1.0.0', 'https://evil.example/x')}</feed>`).url, 'https://github.com/FIY-pc/vibe-logisim/releases/tag/v1.0.0');
  assert.deepEqual(parseVersion('v0.3.1'), [0, 3, 1]);
  for (const bad of ['build-inputs', 'v0.4.0-beta.1', '0.4', '']) assert.equal(parseVersion(bad), null, bad);
  assert.ok(compareVersions([0, 10, 0], [0, 9, 9]) > 0);
  assert.equal(compareVersions([0, 3, 1], [0, 3, 1]), 0);
});

test('a newer release is reported once per 6 hours, and dismissing hides it', async () => {
  requests.length = 0; behaviour = 'ok';
  const {updates, advance, stateDir} = await checker();
  let status = await updates.check();
  assert.equal(requests.length, 1);
  assert.deepEqual({latest: status.latest, available: status.available, newer: status.newer, current: status.current}, {latest: '0.10.0', available: true, newer: true, current: '0.3.1'});
  assert.equal(status.url, 'https://github.com/FIY-pc/vibe-logisim/releases/tag/v0.10.0');
  advance(60 * 60 * 1000);
  await updates.check();
  assert.equal(requests.length, 1, 'cached for 6 hours');
  await updates.check({manual: true});
  assert.equal(requests.length, 2, 'a manual check skips the cache');
  status = updates.dismiss('0.10.0');
  assert.deepEqual({available: status.available, newer: status.newer, dismissedVersion: status.dismissedVersion}, {available: false, newer: true, dismissedVersion: '0.10.0'});
  // A restart reads the same state from disk.
  const restarted = new UpdateChecker({currentVersion: '0.3.1', stateDir, fetch: () => { throw new Error('no request expected'); }});
  assert.equal(restarted.status().available, false);
  advance(7 * 60 * 60 * 1000);
  status = await updates.check();
  assert.equal(requests.length, 3);
  assert.equal(status.available, false, 'the dismissed version stays hidden after the next check');
  assert.throws(() => updates.dismiss('latest'), /版本号无效/);
});

test('the current or an older release is not an update', async () => {
  requests.length = 0; behaviour = 'ok';
  const {updates} = await checker({currentVersion: '0.10.0'});
  const status = await updates.check();
  assert.deepEqual({newer: status.newer, available: status.available}, {newer: false, available: false});
});

test('timeouts and HTTP errors are logged and returned, never thrown', async () => {
  behaviour = 'slow';
  const slow = await checker();
  let status = await slow.updates.check();
  assert.match(status.error, /秒没有响应/);
  assert.equal(status.latest, null);
  assert.match(slow.logs.at(-1), /检查失败/);
  behaviour = 'forbidden';
  const forbidden = await checker();
  status = await forbidden.updates.check();
  assert.equal(status.error, 'HTTP 403');
  // A failed attempt does not start the 6 hour quiet period.
  behaviour = 'ok'; requests.length = 0;
  status = await forbidden.updates.check();
  assert.equal(requests.length, 1);
  assert.equal(status.error, null);
  assert.equal(status.latest, '0.10.0');
});

test('with the switch off no request is sent at startup; the override blocks everything', async () => {
  requests.length = 0; behaviour = 'ok';
  const {updates, stateDir} = await checker();
  assert.equal(updates.status().enabled, true);
  updates.setPreference(false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'app-preferences.json'), 'utf8')), {updateCheck: false});
  const status = await updates.check();
  assert.equal(status.enabled, false);
  assert.equal(requests.length, 0);
  await updates.check({manual: true});
  assert.equal(requests.length, 1, 'the user can still ask explicitly');
  const forced = await checker({forcedOff: true});
  await forced.updates.check();
  await forced.updates.check({manual: true});
  assert.equal(requests.length, 1);
  assert.equal(forced.updates.status().forcedOff, true);
});

test('concurrent checks share one request', async () => {
  requests.length = 0; behaviour = 'ok';
  const {updates} = await checker();
  const [a, b] = await Promise.all([updates.check({manual: true}), updates.check({manual: true})]);
  assert.equal(requests.length, 1);
  assert.equal(a.latest, b.latest);
});
