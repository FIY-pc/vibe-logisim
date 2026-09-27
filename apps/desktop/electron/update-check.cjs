'use strict';

// Tells the user when a newer release exists; it never downloads anything.
//
// Source: GitHub's releases.atom. Every release so far is a prerelease, and
// the REST /releases/latest endpoint skips prereleases (404); the Atom feed
// lists them, needs no API quota (60 unauthenticated calls per hour per IP
// would be shared by a whole campus NAT) and names each entry by its tag.
// Tags that are not plain x.y.z (e.g. build-inputs) are ignored.
//
// State in userData: update-check.json {lastCheckedAt, latest, url,
// dismissedVersion} and the user's switch in app-preferences.json
// {updateCheck}. With the switch off no request is sent at startup; the
// VIBE_LOGISIM_NO_UPDATE_CHECK=1 override (CI, tests) blocks every request.

const fs = require('node:fs');
const path = require('node:path');

const FEED_URL = 'https://github.com/FIY-pc/vibe-logisim/releases.atom';
const RELEASES_PAGE = 'https://github.com/FIY-pc/vibe-logisim/releases';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_FEED_BYTES = 2 * 1024 * 1024;

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

const decodeXml = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Highest x.y.z release in the feed: {version, tag, url} or null. Entry order
// and <updated> are not release order (editing old notes bumps <updated>).
function latestRelease(xml) {
  let best = null;
  for (const [, entry] of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const tag = decodeXml(/<id>([^<]*)<\/id>/.exec(entry)?.[1] || '').split('/').pop();
    const parsed = parseVersion(tag);
    if (!parsed) continue;
    const href = decodeXml(/<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/.exec(entry)?.[1] || '');
    const url = /^https:\/\/github\.com\//.test(href) ? href : `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;
    if (!best || compareVersions(parsed, best.parsed) > 0) best = {parsed, version: parsed.join('.'), tag, url};
  }
  return best && {version: best.version, tag: best.tag, url: best.url};
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

class UpdateChecker {
  constructor({currentVersion, stateDir, fetch, feedUrl = FEED_URL, now = () => Date.now(), timeoutMs = TIMEOUT_MS, intervalMs = CHECK_INTERVAL_MS, forcedOff = false, log = () => {}} = {}) {
    if (typeof fetch !== 'function') throw new TypeError('更新检查需要 fetch');
    this.currentVersion = String(currentVersion || '0.0.0');
    this.cachePath = path.join(stateDir, 'update-check.json');
    this.preferencesPath = path.join(stateDir, 'app-preferences.json');
    this.fetch = fetch;
    this.feedUrl = feedUrl || FEED_URL;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.intervalMs = intervalMs;
    this.forcedOff = Boolean(forcedOff);
    this.log = log;
    this.lastError = null;
    this.inflight = null;
  }

  // The user's switch (default on). The environment override is separate so
  // the menu still shows what the user chose.
  get preference() { return readJson(this.preferencesPath)?.updateCheck !== false; }

  setPreference(enabled) {
    writeJson(this.preferencesPath, {...(readJson(this.preferencesPath) || {}), updateCheck: Boolean(enabled)});
    return this.status();
  }

  status() {
    const cache = readJson(this.cachePath) || {};
    const latest = parseVersion(cache.latest), current = parseVersion(this.currentVersion);
    const newer = Boolean(latest && current && compareVersions(latest, current) > 0);
    return {
      enabled: this.preference, forcedOff: this.forcedOff, current: this.currentVersion,
      latest: cache.latest || null, url: cache.url || null, lastCheckedAt: cache.lastCheckedAt || null,
      dismissedVersion: cache.dismissedVersion || null,
      newer, available: newer && cache.latest !== cache.dismissedVersion,
      error: this.lastError,
    };
  }

  // Automatic checks respect the switch and the 6 h cache; a manual check
  // ("立即检查更新") is the user's explicit request and skips both. Nothing
  // throws: failures are logged and returned in status().error.
  async check({manual = false} = {}) {
    if (this.forcedOff || (!manual && !this.preference)) return this.status();
    const last = Date.parse((readJson(this.cachePath) || {}).lastCheckedAt || '');
    if (!manual && Number.isFinite(last) && this.now() - last < this.intervalMs) return this.status();
    if (!this.inflight) {
      this.inflight = this.#refresh().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  dismiss(version) {
    if (!parseVersion(version)) throw new Error('版本号无效');
    writeJson(this.cachePath, {...(readJson(this.cachePath) || {}), dismissedVersion: String(version)});
    return this.status();
  }

  async #refresh() {
    try {
      const latest = latestRelease(await this.#download());
      writeJson(this.cachePath, {...(readJson(this.cachePath) || {}), lastCheckedAt: new Date(this.now()).toISOString(),
        latest: latest?.version || null, url: latest?.url || null});
      this.lastError = null;
      this.log(`最新发布 ${latest?.version || '（无）'}，当前 ${this.currentVersion}`);
    } catch (error) {
      this.lastError = error.message || String(error);
      this.log(`检查失败：${this.lastError}`);
    }
    return this.status();
  }

  async #download() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`超过 ${Math.round(this.timeoutMs / 1000)} 秒没有响应`)); }, this.timeoutMs);
    });
    const request = (async () => {
      const response = await this.fetch(this.feedUrl, {signal: controller.signal, headers: {Accept: 'application/atom+xml'}});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_FEED_BYTES) throw new Error('发布列表过大');
      return text;
    })();
    request.catch(() => {});
    try { return await Promise.race([request, timeout]); } finally { clearTimeout(timer); }
  }
}

module.exports = {UpdateChecker, latestRelease, parseVersion, compareVersions, FEED_URL, RELEASES_PAGE};
