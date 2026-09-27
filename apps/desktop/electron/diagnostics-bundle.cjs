'use strict';

// One-click diagnostics for a public GitHub issue.
//
// The bundle is a zip the user saves and drags into the issue: a summary, a
// report (versions, OS, Java, AI connection state, path *traits*), the last
// failed circuit-tool calls with redacted arguments, and the redacted logs.
// It never contains the API key, conversation text, ChatGPT tokens or other
// files; the current .circ only when the user ticks the box. Folder and file
// names are reduced to traits (length, non-ASCII, depth, spaces, OneDrive)
// because they often carry the student's name.
//
// After building, every entry is unpacked again and checked for the key,
// the home directory, student numbers and name-shaped file prefixes; any hit
// aborts the export.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {execFile} = require('node:child_process');
const {maskEndpoint} = require('./diagnostics-log.cjs');

const ISSUE_URL = 'https://github.com/FIY-pc/vibe-logisim/issues/new';
const ISSUE_TEMPLATE = 'bug-report.yml';
const SUMMARY_BYTES = 3 * 1024;
const REPORTED_ENV = ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'CODEX_HOME', 'PYTHONPATH', 'PYTHONHOME', 'ELECTRON_RUN_AS_NODE'];

// ------------------------------------------------------------------- zip

const CRC_TABLE = zlib.crc32 ? null : Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data) {
  if (zlib.crc32) return zlib.crc32(data) >>> 0;
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// Minimal zip writer: deflate when it helps, stored otherwise; names flagged
// UTF-8 (bit 11) so Windows Explorer and unzip agree on them.
function createZip(entries, {now = new Date()} = {}) {
  const parts = [], central = [];
  const {time, date} = dosTime(now);
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const method = deflated.length < raw.length ? 8 : 0;
    const body = method ? deflated : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10); record.writeUInt16LE(time, 12); record.writeUInt16LE(date, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(record, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// Reads back what createZip writes (and any plain stored/deflated zip);
// verifies sizes and CRCs.
function readZip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('不是 zip 文件');
  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('zip 目录损坏');
    const method = buffer.readUInt16LE(pointer + 10), crc = buffer.readUInt32LE(pointer + 16);
    const compressed = buffer.readUInt32LE(pointer + 20), size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28), extra = buffer.readUInt16LE(pointer + 30), comment = buffer.readUInt16LE(pointer + 32);
    const local = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + compressed);
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式：${name}`);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip 条目校验失败：${name}`);
    entries.push({name, data});
    pointer += 46 + nameLength + extra + comment;
  }
  return entries;
}

// ---------------------------------------------------------------- traits

// What matters about a path for bug reports, without the path itself.
function pathTraits(value) {
  if (!value) return null;
  const text = String(value);
  return {
    length: text.length,
    depth: text.split(/[\\/]+/).filter(Boolean).length,
    nonAscii: /[^\x00-\x7f]/.test(text),
    spaces: /\s/.test(text),
    oneDrive: /onedrive/i.test(text),
    network: /^(\\\\|\/\/)/.test(text),
    drive: /^([A-Za-z]):/.exec(text)?.[1].toUpperCase() || null,
  };
}

function fileTraits(relative) {
  if (!relative) return null;
  const text = String(relative);
  return {length: text.length, depth: text.split(/[\\/]+/).filter(Boolean).length, nonAscii: /[^\x00-\x7f]/.test(text),
    spaces: /\s/.test(text), extension: path.extname(text).toLowerCase() || null};
}

function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactDeep(item, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)]));
  return value;
}

// ---------------------------------------------------------------- report

function route(network) {
  if (!network) return null;
  return {kind: network.description?.kind || null, source: network.source || null, scheme: network.scheme || null,
    hostPort: network.hostPort || null, credentials: Boolean(network.credentials), unsupported: network.unsupported || null,
    noProxyEntries: Array.isArray(network.noProxy) ? network.noProxy.length : 0,
    target: network.target ? maskEndpoint(network.target) : null, error: network.error || null};
}

function connectionOf(agent) {
  if (!agent) return 'unavailable';
  if (agent.customProvider) return 'custom';
  if (agent.accountMode === 'application') return agent.account ? 'chatgpt' : 'none';
  return 'local-codex';
}

function agentReport(agent, {keyLength = 0} = {}) {
  if (!agent) return null;
  const custom = agent.customProvider;
  return {
    connection: connectionOf(agent),
    status: agent.status || null, detail: agent.detail || null, available: Boolean(agent.available), busy: Boolean(agent.busy),
    accountMode: agent.accountMode || null, account: agent.account ? {type: agent.account.type || null, planType: agent.account.planType || null} : null,
    providerName: agent.providerName || null, model: agent.model || null, effort: agent.effort || null,
    inheritedModel: agent.inheritedModel || null, inheritedEffort: agent.inheritedEffort || null,
    modelConfigurationError: agent.modelConfigurationError || null, modelCatalog: agent.modelCatalog || null,
    transmission: agent.transmission || null, isolation: agent.isolation || null, canReconnect: agent.canReconnect ?? null,
    signingIn: Boolean(agent.signingIn), threadId: agent.threadId || null, turnId: agent.turnId || null,
    // Only whether a key is set and how long it is; never the hint.
    customProvider: custom ? {endpoint: maskEndpoint(custom.baseUrl), model: custom.model || null, effort: custom.effort || null,
      contextWindow: custom.contextWindow || null, models: Array.isArray(custom.models) ? custom.models.length : 0, keySet: keyLength > 0, keyLength} : null,
  };
}

function studioReport(session) {
  if (!session) return null;
  const capabilities = session.capabilities || {};
  const profile = capabilities.observationProfile || capabilities.profile || null;
  const external = capabilities.relativeExternalLibraries || null;
  return {
    open: Boolean(session.revision), sourceMode: session.source?.mode || null,
    sourceStatus: session.sourceStatus ? {canReload: session.sourceStatus.canReload ?? null, exists: session.sourceStatus.exists ?? null,
      changed: session.sourceStatus.changed ?? null, stale: session.sourceStatus.stale ?? null, reason: session.sourceStatus.reason || null} : null,
    dirty: session.workspace?.dirty ?? null,
    exactConnectivity: capabilities.exactConnectivity ?? null, sourceWrite: capabilities.sourceWrite ?? null,
    externalLibraries: external ? {supported: external.supported ?? null, mode: external.mode || null, count: Array.isArray(external.descriptors) ? external.descriptors.length : 0} : null,
    runtime: profile ? {status: profile.status || null, display: profile.display || null, reportedVersion: profile.reportedVersion || null,
      runtimeJarSha256: profile.runtimeJarSha256 || null, error: profile.error || null} : null,
    connectionIndex: session.connectionIndex || null,
  };
}

// inputs: raw facts gathered by the main process (see feedback-ipc.cjs).
// The result holds no path, file name, key or message text that did not go
// through `redact`.
function buildReport(inputs, redact) {
  const folder = inputs.workspace?.folder || null;
  const report = {
    schema: 'vibe-logisim.diagnostics/v1',
    generatedAt: (inputs.generatedAt || new Date()).toISOString(),
    app: inputs.app || null,
    system: inputs.system || null,
    paths: {userData: pathTraits(inputs.userDataPath), home: pathTraits(inputs.homeDir), temp: pathTraits(inputs.tempDir)},
    environment: REPORTED_ENV.filter(name => Boolean(inputs.env?.[name])),
    java: inputs.java || null,
    ai: agentReport(inputs.agent, {keyLength: inputs.keyLength || 0}),
    capabilities: inputs.capabilities || null,
    network: inputs.network ? {current: route(inputs.network.current), active: route(inputs.network.active), stale: Boolean(inputs.network.stale)} : null,
    workspace: {open: Boolean(folder), root: pathTraits(folder?.root), activeFile: fileTraits(folder?.activeFile), error: inputs.workspace?.error || null},
    studio: studioReport(inputs.session),
    toolFailures: Array.isArray(inputs.toolFailures) ? inputs.toolFailures.length : 0,
    logs: (inputs.logFiles || []).map(file => ({name: path.basename(file), bytes: (() => { try { return fs.statSync(file).size; } catch { return null; } })()})),
  };
  return redactDeep(report, redact);
}

// --------------------------------------------------------------- summary

const CONNECTION_LABELS = {custom: '自定义接口', chatgpt: 'ChatGPT 账号', 'local-codex': '本机 Codex 配置', none: '未连接', unavailable: 'AI 服务未启动'};
const STATUS_LABELS = {ready: '已连接', busy: '正在回答', 'auth-required': '未登录', unavailable: '连接失败', starting: '正在启动', stopped: '已停止'};

function osLabel(system) {
  if (!system) return '未知';
  const build = /^10\.0\.(\d+)/.exec(system.release || '')?.[1];
  const name = system.platform === 'win32' ? (build && Number(build) >= 22000 ? 'Windows 11' : 'Windows') :
    system.platform === 'linux' ? 'Linux' : system.platform === 'darwin' ? 'macOS' : system.platform;
  return `${name} ${system.release || ''} ${system.arch || ''}`.replace(/\s+/g, ' ').trim();
}

function networkLabel(network) {
  const current = network?.current;
  if (!current) return '未检测';
  if (current.kind === 'proxy') return current.source === 'env' ? '环境变量代理' : '系统代理';
  if (current.kind === 'unsupported') return '代理不支持（SOCKS）';
  return '直连';
}

// The summary is pasted into the public issue text: no paths at all. Chinese
// messages put a path right after "：" or "，", so a POSIX path is any "/…"
// not preceded by a word, path or URL character.
function stripPaths(text) {
  return String(text || '')
    .replace(/<工作区>([\\/][^\s，。；、"'<>]*)?/g, '<路径>')
    .replace(/~[\\/][^\s，。；、"'<>]*/g, '<路径>')
    .replace(/\b[A-Za-z]:[\\/][^\s，。；、"'<>]*/g, '<路径>')
    .replace(/\\\\[^\s，。；、"'<>]+/g, '<路径>')
    .replace(/(^|[^\w.~<>/:-])\/(?!\/)[^\s，。；、"'<>]+/g, '$1<路径>')
    .replace(/\s+/g, ' ').trim();
}

const clip = (text, limit) => text.length > limit ? text.slice(0, limit) + '…' : text;
const yes = value => value ? '是' : '否';

function pathLine(label, traits) {
  if (!traits) return `${label}：未知`;
  return `${label}：长度 ${traits.length} · 含非 ASCII：${yes(traits.nonAscii)} · 含空格：${yes(traits.spaces)}${traits.oneDrive ? ' · 在 OneDrive 中' : ''}${traits.network ? ' · 网络路径' : ''}`;
}

function buildSummary(report, failures = []) {
  const ai = report.ai;
  const lastError = ai?.transmission?.message || ai?.modelConfigurationError?.message || (['unavailable', 'stopped'].includes(ai?.status) ? ai?.detail : null);
  const connection = CONNECTION_LABELS[ai?.connection || 'unavailable'];
  const header = [
    'Vibe Logisim 诊断摘要',
    `版本：${report.app?.version || '未知'}（${report.app?.packaged ? '安装包' : '源码运行'}）`,
    `系统：${osLabel(report.system)}`,
    `Java：${report.java?.version || report.java?.error || '未知'}`,
    `AI 连接：${connection}${ai?.model ? ` · 模型 ${ai.model}` : ''}${ai?.effort ? ` · 思考深度 ${ai.effort}` : ''}`,
    `网络：${networkLabel(report.network)}`,
    `AI 状态：${STATUS_LABELS[ai?.status] || ai?.status || '未知'}`,
    ...(lastError ? [`最近错误：${clip(stripPaths(lastError), 300)}`] : []),
    pathLine('数据目录', report.paths?.userData),
    pathLine('用户目录', report.paths?.home),
    ...(report.environment?.length ? [`已设置的环境变量：${report.environment.join(', ')}`] : []),
    `工作区：${report.workspace?.open ? `已打开（文件夹层级 ${report.workspace.root?.depth ?? '?'} · 含非 ASCII：${yes(report.workspace.root?.nonAscii)} · 含空格：${yes(report.workspace.root?.spaces)}）` : '未打开'}`,
  ];
  const recent = failures.slice(-3);
  const failureLines = failures.length
    ? [`最近失败的电路工具调用（共 ${failures.length} 次，列出最后 ${recent.length} 次）：`,
      ...recent.map(item => `- ${String(item.at || '').replace('T', ' ').slice(0, 16)} ${item.tool || '?'} ${item.error?.code || ''}：${clip(stripPaths(item.error?.message), 240)}`)]
    : ['最近没有失败的电路工具调用'];
  let lines = [...header, ...failureLines];
  // Keep within the budget by shortening the failure texts first.
  for (const limit of [120, 60]) {
    if (Buffer.byteLength(lines.join('\n')) <= SUMMARY_BYTES) break;
    lines = [...header, ...failureLines.map(line => line.startsWith('- ') ? clip(line, limit) : line)];
  }
  const text = lines.join('\n');
  return Buffer.byteLength(text) <= SUMMARY_BYTES ? text : Buffer.from(text).subarray(0, SUMMARY_BYTES).toString('utf8').replace(/\uFFFD+$/, '');
}

// Prefilled "new issue" page. GitHub fills issue-form fields whose `id`
// matches a query parameter (.github/ISSUE_TEMPLATE/bug-report.yml).
function issueUrl(report) {
  const url = new URL(ISSUE_URL);
  url.searchParams.set('template', ISSUE_TEMPLATE);
  url.searchParams.set('version', report.app?.version || '');
  url.searchParams.set('os', osLabel(report.system));
  url.searchParams.set('connection', CONNECTION_LABELS[report.ai?.connection || 'unavailable']);
  return url.href;
}

// ---------------------------------------------------------------- bundle

function readme(report, {includeCircuit}) {
  return [
    'Vibe Logisim 诊断包',
    `生成时间：${report.generatedAt}　版本：${report.app?.version || '未知'}`,
    '',
    '包含：',
    '- summary.txt：诊断摘要（可以直接贴进 issue）',
    '- report.json：版本、系统、Java、AI 连接状态、网络方式、路径特征（长度、是否含中文或空格，不含路径本身）',
    '- tool-failures.json：最近失败的电路工具调用，含 AI 发出的参数（已截断、已脱敏）',
    '- logs/：应用日志',
    ...(includeCircuit ? ['- circuit/current.circ：你选择附上的当前电路（文件中的路径和学号已替换）'] : []),
    '',
    '不包含：API 密钥、对话内容、ChatGPT 登录信息、其他文件。',
    '用户目录、用户名、工作区位置、学号，以及文件名开头的姓名（中文名加下划线）已分别替换为 ~、<user>、<工作区>、<学号>、<姓名>。',
    'issue 是公开的，发之前请看一眼：文件名或元件标签里仍可能有你的姓名。',
    '',
  ].join('\n');
}

function literalForms(value) {
  const text = String(value);
  return [...new Set([text, text.replace(/\\/g, '/'), text.replace(/\\/g, '\\\\'), encodeURIComponent(text)])];
}

// Independent second check on the unpacked bytes: the redactor is not
// trusted to have run on every entry. homeDir: one path or several spellings.
function verifyBundle(buffer, {secrets = [], homeDir = null} = {}) {
  const homes = [homeDir].flat().filter(value => typeof value === 'string' && value.split(/[\\/]+/).filter(Boolean).length >= 2);
  const home = homes.length
    ? new RegExp(`(?:${homes.flatMap(literalForms).map(form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}_.-])`, 'iu') : null;
  const keys = secrets.filter(value => typeof value === 'string' && value.length >= 6).flatMap(value => [...new Set([value, encodeURIComponent(value)])]);
  for (const entry of readZip(buffer)) {
    const text = entry.data.toString('utf8');
    for (const target of [entry.name, text]) {
      if (keys.some(key => target.includes(key))) throw new Error(`诊断包的 ${entry.name} 里仍有 API 密钥，已停止保存。请把这条提示截图反馈。`);
      if (home?.test(target)) throw new Error(`诊断包的 ${entry.name} 里仍有用户目录路径，已停止保存。请把这条提示截图反馈。`);
      if (/U20[0-9]{7}|[一-鿿]{2,3}_/.test(target)) throw new Error(`诊断包的 ${entry.name} 里仍有学号或像姓名的文件名前缀，已停止保存。请把这条提示截图反馈。`);
    }
  }
}

// {inputs, logFiles, circuit: {text} | null, redact, secrets, homeDir}
function createDiagnosticsBundle({inputs, logFiles = [], circuit = null, redact, secrets = [], homeDir = null, now = new Date()}) {
  const report = buildReport({...inputs, logFiles}, redact);
  const failures = redactDeep(inputs.toolFailures || [], redact);
  const summary = buildSummary(report, failures);
  const entries = [
    {name: 'README.txt', data: readme(report, {includeCircuit: Boolean(circuit)})},
    {name: 'summary.txt', data: summary},
    {name: 'report.json', data: JSON.stringify(report, null, 2)},
    {name: 'tool-failures.json', data: JSON.stringify(failures, null, 2)},
  ];
  for (const file of logFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    entries.push({name: `logs/${path.basename(file)}`, data: redact(text)});
  }
  if (circuit) entries.push({name: 'circuit/current.circ', data: redact(circuit.text)});
  const buffer = createZip(entries, {now});
  verifyBundle(buffer, {secrets, homeDir});
  return {buffer, summary, report, issueUrl: issueUrl(report), entries: entries.map(({name, data}) => ({name, bytes: Buffer.byteLength(data)}))};
}

function bundleFileName(version, date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `vibe-logisim-诊断-${version}-${stamp}.zip`;
}

// `java -version` of the runtime the app actually uses.
function probeJavaVersion(java, {run = execFile, timeoutMs = 5000} = {}) {
  return new Promise(resolve => {
    run(java, ['-version'], {timeout: timeoutMs, windowsHide: true, encoding: 'utf8'}, (error, stdout, stderr) => {
      const text = `${stderr || ''}\n${stdout || ''}`;
      const version = /version "([^"]+)"/.exec(text)?.[1];
      if (version) return resolve({version, runtime: /^.*(?:Runtime Environment|OpenJDK).*$/m.exec(text)?.[0].trim().slice(0, 160) || null});
      resolve({version: null, error: error ? (error.code === 'ENOENT' ? '找不到 java' : String(error.message || error).slice(0, 200)) : '无法识别 java -version 的输出'});
    });
  });
}

module.exports = {createZip, readZip, pathTraits, fileTraits, buildReport, buildSummary, issueUrl, verifyBundle, stripPaths,
  createDiagnosticsBundle, bundleFileName, probeJavaVersion, redactDeep, CONNECTION_LABELS, ISSUE_TEMPLATE};
