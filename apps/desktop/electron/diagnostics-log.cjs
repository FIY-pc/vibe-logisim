'use strict';

// Rolling on-disk log for the packaged app, plus the one redaction function
// shared by the log, the diagnostics bundle and the copied summary.
//
// Everything written here may end up attached to a public GitHub issue, so
// text is redacted before it touches the disk: keys and tokens, proxy
// passwords, the home directory and account name, workspace roots, student
// numbers and the Chinese name that coursework file names start with.
// Workspace-relative paths stay, since "file not found" reports cannot be
// diagnosed without them.

const fs = require('node:fs');
const path = require('node:path');

const LOG_NAME = 'vibe-logisim';
const MAX_MESSAGE = 16 * 1024;
// Account names too generic to be personal; replacing them would only garble text.
const GENERIC_USERS = new Set(['user', 'users', 'admin', 'administrator', 'root', 'guest', 'default', 'public', 'runner', 'runneradmin', 'localhost']);

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Non-ASCII as "\uXXXX": how Python's json.dumps and some native tools print paths.
const asciiEscaped = value => value.replace(/[^\x00-\x7f]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));

// One regex source matching a path however it was printed: "/" or "\"
// separators, doubled "\\" inside JSON or repr, "\uXXXX" escapes, and
// percent-encoding inside URLs.
function pathSources(value) {
  const text = String(value || '').trim();
  const segments = text.split(/[\\/]+/).filter(Boolean);
  if (!segments.length) return [];
  const lead = /^[\\/]/.test(text) ? '[\\\\/]+' : '';
  const sep = '[\\\\/]+';
  const plain = lead + segments.map(escapeRegExp).join(sep);
  const escaped = lead + segments.map(segment => escapeRegExp(asciiEscaped(segment))).join(sep);
  const encodedLead = /^[\\/]/.test(text) ? '(?:%5C|%2F)+' : '';
  const encoded = encodedLead + segments.map(segment => escapeRegExp(encodeURIComponent(segment))).join('(?:%5C|%2F)+');
  return [...new Set([plain, escaped, encoded])];
}

function wordSources(value) {
  const text = String(value || '');
  return [...new Set([text, asciiEscaped(text), encodeURIComponent(text)])].map(escapeRegExp);
}

function alternation(sources, {tail = '', head = ''} = {}) {
  if (!sources.length) return null;
  // Longest first, so a workspace inside another workspace is matched whole.
  const sorted = [...sources].sort((a, b) => b.length - a.length);
  return new RegExp(`${head}(?:${sorted.join('|')})${tail}`, 'giu');
}

// A secret (API key) plus the pieces a stream split could leave at the start
// or end of one stderr chunk.
function maskSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join('***');
    if (secret.length < 16) continue;
    for (let n = secret.length - 1; n >= 8; n--) {
      if (out.startsWith(secret.slice(-n))) { out = '***' + out.slice(n); break; }
    }
    for (let n = secret.length - 1; n >= 8; n--) {
      if (out.endsWith(secret.slice(0, n))) { out = out.slice(0, out.length - n) + '***'; break; }
    }
  }
  return out;
}

// Endpoint shown as scheme://host[:port]/path with token-like path segments
// (20+ letters/digits; some endpoints carry the key in the path) masked.
function maskEndpoint(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return null; }
  const pathname = url.pathname.split('/').map(segment => /^[A-Za-z0-9_-]{20,}$/.test(segment) ? '***' : segment).join('/');
  return `${url.protocol}//${url.host}${pathname === '/' ? '' : pathname}`;
}

const TOKEN_RULES = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***'],
  [/((?<![A-Za-z0-9])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|authorization)["']?\s*[=:]\s*["']?)(?!Bearer\b|Basic\b|\*\*\*)[^\s"'&,;}<>]{4,}/gi, '$1***'],
  // Greedy up to the last "@" before the host: WHATWG URL parsing accepts a
  // raw "@" inside the password (http://user:p@ss@host).
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s"'<>]*@/gi, '$1***@'],
];
// Student numbers: U/M/D, "20", seven digits. Upper case without boundaries,
// so the result never matches the repository's own publication check;
// lower case only outside hex strings (hashes are lower-case hex).
const STUDENT_NUMBERS = [/[UMD]20[0-9]{7}/g, /(?<![0-9a-f])[umd]20[0-9]{7}/g];
// Coursework files are usually named <name>_<student number>_…; the whole CJK
// run before "_" goes, so no 2–3 character tail of a longer name survives.
const NAME_PREFIX = /[一-鿿]{2,}_/g;

// {homeDir, homeAliases, username, hostname} are fixed per machine;
// homeAliases are other spellings of the home directory (the Windows 8.3
// short form). Keys, workspace roots and endpoints change while the app
// runs; update() rebuilds those patterns.
function createRedactor({homeDir = null, homeAliases = [], username = null, hostname = null} = {}) {
  let secrets = [], endpoints = [], roots = null, home = null, host = null, user = null;
  const namePattern = value => {
    const text = String(value || '').trim();
    if (!text || GENERIC_USERS.has(text.toLowerCase())) return null;
    // ASCII names shorter than 3 letters appear inside ordinary words.
    if (/^[\x00-\x7f]+$/.test(text) && text.length < 3) return null;
    return alternation(wordSources(text), {head: '(?<![\\p{L}\\p{N}_])', tail: '(?![\\p{L}\\p{N}_])'});
  };
  const deepEnough = value => typeof value === 'string' && value.split(/[\\/]+/).filter(Boolean).length >= 2;
  const homes = [homeDir, ...homeAliases].filter(deepEnough);
  home = homes.length ? alternation(homes.flatMap(pathSources), {tail: '(?![\\p{L}\\p{N}_.-])'}) : null;
  // A root under the home directory, re-spelled with each alias.
  const respelled = root => {
    if (!deepEnough(homeDir)) return [root];
    const normal = value => value.replace(/[\\/]+/g, '/').toLowerCase();
    if (!normal(root).startsWith(normal(homeDir) + '/')) return [root];
    const rest = root.replace(/^[\\/]*/, '').split(/[\\/]+/).slice(homeDir.split(/[\\/]+/).filter(Boolean).length).join('/');
    return [root, ...homeAliases.filter(deepEnough).map(alias => `${alias}/${rest}`)];
  };
  user = namePattern(username);
  host = namePattern(hostname);

  function update({secrets: nextSecrets, workspaceRoots, endpoints: nextEndpoints} = {}) {
    if (nextSecrets) secrets = [...new Set(nextSecrets.filter(value => typeof value === 'string' && value.length >= 6))];
    if (nextEndpoints) endpoints = nextEndpoints.filter(Boolean).map(value => ({value: String(value), masked: maskEndpoint(value)})).filter(entry => entry.masked && entry.masked !== entry.value);
    if (workspaceRoots) {
      // A drive or filesystem root would swallow every path.
      const usable = workspaceRoots.filter(deepEnough).flatMap(respelled);
      roots = alternation(usable.flatMap(pathSources), {tail: '(?![\\p{L}\\p{N}_.-])'});
    }
    return redact;
  }

  function addSecret(value) {
    if (typeof value === 'string' && value.length >= 6 && !secrets.includes(value)) secrets.push(value);
  }

  function redact(value) {
    let text = typeof value === 'string' ? value : value instanceof Error ? (value.stack || value.message) : String(value ?? '');
    text = maskSecrets(text, secrets);
    for (const [pattern, replacement] of TOKEN_RULES) text = text.replace(pattern, replacement);
    for (const {value: endpoint, masked} of endpoints) text = text.split(endpoint).join(masked);
    if (roots) text = text.replace(roots, '<工作区>');
    if (home) text = text.replace(home, '~');
    if (host) text = text.replace(host, '<host>');
    if (user) text = text.replace(user, '<user>');
    for (const pattern of STUDENT_NUMBERS) text = text.replace(pattern, '<学号>');
    return text.replace(NAME_PREFIX, '<姓名>_');
  }

  redact.update = update;
  redact.addSecret = addSecret;
  redact.secrets = () => [...secrets];
  return redact;
}

// Roots of every folder the app has opened: the current one plus the records
// under userData/folder-workspaces (recent.json and <id>/workspace.json).
function knownWorkspaceRoots(stateRoot) {
  const roots = new Set();
  const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const recent = read(path.join(stateRoot, 'recent.json'));
  if (typeof recent?.root === 'string') roots.add(recent.root);
  let entries = [];
  try { entries = fs.readdirSync(stateRoot, {withFileTypes: true}); } catch { return [...roots]; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = read(path.join(stateRoot, entry.name, 'workspace.json'));
    if (typeof record?.root === 'string') roots.add(record.root);
  }
  return [...roots];
}

// Size-rolled log: vibe-logisim.log, .1.log, .2.log (2 MiB each by default).
// Writes are synchronous so the line before a crash is on disk. Every line is
// also echoed to stderr, which the smoke tests and a terminal launch collect.
// A failing disk (full, read-only) disables the file and never throws.
class DiagnosticsLog {
  constructor({directory, redact = value => String(value), maxBytes = 2 * 1024 * 1024, keep = 3, now = () => new Date(), echo = line => console.error(line)} = {}) {
    this.directory = directory;
    this.redact = redact;
    this.maxBytes = maxBytes;
    this.keep = Math.max(1, keep);
    this.now = now;
    this.echo = echo;
    this.size = null;
    this.disabled = !directory;
  }

  fileAt(index) { return path.join(this.directory, index ? `${LOG_NAME}.${index}.log` : `${LOG_NAME}.log`); }
  get file() { return this.fileAt(0); }

  // Newest first.
  files() {
    if (!this.directory) return [];
    return Array.from({length: this.keep}, (_, index) => this.fileAt(index)).filter(file => fs.existsSync(file));
  }

  write(source, message) {
    let text = this.redact(message);
    if (text.length > MAX_MESSAGE) text = `${text.slice(0, MAX_MESSAGE)}…（截断 ${text.length - MAX_MESSAGE} 字符）`;
    text = text.replace(/\s+$/, '');
    const tag = `[${source}]`;
    try { this.echo(`${tag} ${text}`); } catch { /* stderr is best effort */ }
    if (this.disabled) return;
    const stamp = this.now().toISOString();
    const chunk = text.split(/\r?\n/).map(line => `${stamp} ${tag} ${line}\n`).join('');
    try {
      if (this.size === null) {
        fs.mkdirSync(this.directory, {recursive: true});
        try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
      }
      const bytes = Buffer.byteLength(chunk);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, chunk);
      this.size += bytes;
    } catch (error) {
      this.disabled = true;
      try { this.echo(`[main] 日志文件写入失败，之后只输出到终端：${this.redact(error.message)}`); } catch { /* nothing left to report to */ }
    }
  }

  rotate() {
    fs.rmSync(this.fileAt(this.keep - 1), {force: true});
    for (let index = this.keep - 1; index >= 1; index--) {
      if (fs.existsSync(this.fileAt(index - 1))) fs.renameSync(this.fileAt(index - 1), this.fileAt(index));
    }
    this.size = 0;
  }
}

module.exports = {DiagnosticsLog, createRedactor, knownWorkspaceRoots, maskEndpoint, LOG_NAME};
