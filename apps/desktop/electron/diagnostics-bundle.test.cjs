'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createZip, readZip, pathTraits, buildReport, buildSummary, issueUrl, verifyBundle, stripPaths, createDiagnosticsBundle, bundleFileName, probeJavaVersion} = require('./diagnostics-bundle.cjs');
const {createRedactor} = require('./diagnostics-log.cjs');

const KEY = 'sk-live-5f3c9a0b7e2d4c1a9b8e';
const HOME = 'C:\\Users\\张三';
const ROOT = 'C:\\Users\\张三\\Desktop\\组原 课设';
const SN = 'U' + '202112345';
const redactor = () => createRedactor({homeDir: HOME, username: '张三'}).update({secrets: [KEY], workspaceRoots: [ROOT], endpoints: ['https://api.example.org/v1']});

// Raw facts in the shapes the main process collects them.
function inputs(overrides = {}) {
  return {
    generatedAt: new Date('2026-09-27T06:00:00Z'),
    app: {name: 'Vibe Logisim', version: '0.3.1', packaged: true, electron: '44.2.0', chrome: '146.0', node: '24.20.0', locale: 'zh-CN'},
    system: {platform: 'win32', arch: 'x64', release: '10.0.22631', version: 'Windows 11 Home China'},
    userDataPath: `${HOME}\\AppData\\Roaming\\vibe-logisim`, homeDir: HOME, tempDir: `${HOME}\\AppData\\Local\\Temp`,
    env: {JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8', PATH: 'C:\\Windows'},
    java: {version: '21.0.5', runtime: 'OpenJDK Runtime Environment Temurin-21.0.5+11'},
    keyLength: KEY.length,
    agent: {
      status: 'unavailable', detail: `连接失败：${HOME}\\AppData\\Roaming\\vibe-logisim\\circuit-agent\\codex-home 不可写`, available: false, busy: false,
      accountMode: 'application', account: null, providerName: '自定义接口', model: 'gpt-6-sol', effort: 'high',
      transmission: {phase: 'failed', message: `401 Incorrect API key provided: ${KEY}`, attempts: 0},
      customProvider: {name: '自定义接口', baseUrl: 'https://api.example.org/v1', model: 'gpt-6-sol', effort: 'high', contextWindow: 256000, apiKeyHint: 'sk-l••••9b8e', models: ['gpt-6-sol', 'gpt-6-astra']},
      network: {proxyUrl: 'http://alice:secret@127.0.0.1:7890'},
      messages: [{role: 'user', text: '帮我做一个全加器，我的学号是 ' + SN}],
      harness: {schema: 'vibe-logisim.harness-capabilities/v1'},
    },
    capabilities: {schema: 'vibe-logisim.harness-capabilities/v1', detail: true},
    network: {
      current: {proxyUrl: 'http://alice:secret@127.0.0.1:7890', scheme: 'http', hostPort: '127.0.0.1:7890', credentials: true, source: 'system', noProxy: ['corp.example'], target: 'https://api.example.org/v1', description: {kind: 'proxy', label: '系统代理 127.0.0.1:7890'}},
      active: null, stale: false,
    },
    workspace: {folder: {id: 'folder-1', root: ROOT, name: '组原 课设', activeFile: 'cpu/' + SN + '_单周期.circ', conversationKey: 'folder:abc'}, error: `无法读取 ${ROOT}\\cpu\\x.circ`},
    session: {revision: {id: 'r'}, source: {mode: 'path', path: `${ROOT}\\cpu.circ`}, sourceStatus: {canReload: true, exists: true, changed: false, stale: false, reason: `watching ${ROOT}\\cpu.circ`},
      workspace: {dirty: false}, capabilities: {exactConnectivity: null, sourceWrite: true, observationProfile: {status: 'observed', display: 'Logisim-ITA 2.16.2.2 · 0123456789ab', reportedVersion: '2.16.2.2', runtimeJarSha256: 'ab'.repeat(32)},
        relativeExternalLibraries: {supported: true, mode: 'frozen course libraries', descriptors: ['file#cs3410.jar']}}, connectionIndex: {available: true, error: null}},
    toolFailures: [1, 2, 3, 4].map(index => ({at: `2026-09-27T05:0${index}:00.000Z`, tool: 'wire_candidate', error: {code: 'TOOL_REJECTED', message: `要求连接的信号仍然断开: AND Gate@(12${index},80) bit 0，见 ${ROOT}\\cpu.circ`, retryable: false},
      context: {failingPort: 'in0'}, arguments: {connections: [{from: 'c120_80', to: 'c200_80'}]}})),
    ...overrides,
  };
}

test('zip entries round-trip with correct CRCs, deflated or stored, UTF-8 names', () => {
  const big = 'x'.repeat(10000);
  const zip = createZip([{name: 'a.txt', data: big}, {name: '日志/b.bin', data: Buffer.from([1, 2, 3])}], {now: new Date(2026, 8, 27, 13, 5, 8)});
  const entries = readZip(zip);
  assert.deepEqual(entries.map(entry => entry.name), ['a.txt', '日志/b.bin']);
  assert.equal(entries[0].data.toString(), big);
  assert.deepEqual([...entries[1].data], [1, 2, 3]);
  assert.ok(zip.length < 2000, 'repetitive text is deflated');
  const corrupt = Buffer.from(zip);
  corrupt[40] ^= 0xff;
  assert.throws(() => readZip(corrupt));
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /不是 zip/);
});

test('the report keeps traits and states, never names, paths, keys or messages', () => {
  const report = buildReport(inputs(), redactor());
  const text = JSON.stringify(report);
  for (const forbidden of [KEY, 'sk-l', '9b8e', 'alice', 'secret@', '张三', '组原', SN, '单周期', '帮我做', 'apiKeyHint', 'messages']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(report.paths.userData, {length: 40, depth: 6, nonAscii: true, spaces: false, oneDrive: false, network: false, drive: 'C'});
  assert.deepEqual(report.workspace.root, {length: ROOT.length, depth: 5, nonAscii: true, spaces: true, oneDrive: false, network: false, drive: 'C'});
  assert.equal(report.workspace.activeFile.extension, '.circ');
  assert.equal(report.workspace.error, '无法读取 <工作区>\\cpu\\x.circ');
  assert.deepEqual(report.environment, ['JAVA_TOOL_OPTIONS']);
  assert.deepEqual(report.ai.customProvider, {endpoint: 'https://api.example.org/v1', model: 'gpt-6-sol', effort: 'high', contextWindow: 256000, models: 2, keySet: true, keyLength: KEY.length});
  assert.equal(report.ai.connection, 'custom');
  assert.equal(report.ai.transmission.message, '401 Incorrect API key provided: ***');
  assert.equal(report.ai.detail, '连接失败：~\\AppData\\Roaming\\vibe-logisim\\circuit-agent\\codex-home 不可写');
  assert.deepEqual(report.network.current, {kind: 'proxy', source: 'system', scheme: 'http', hostPort: '127.0.0.1:7890', credentials: true, unsupported: null, noProxyEntries: 1, target: 'https://api.example.org/v1', error: null});
  assert.equal(report.studio.runtime.display, 'Logisim-ITA 2.16.2.2 · 0123456789ab');
  assert.equal(report.studio.sourceStatus.reason, 'watching <工作区>\\cpu.circ');
  assert.equal(report.studio.externalLibraries.count, 1);
  assert.equal(report.toolFailures, 4);
});

test('the summary is short, path-free and lists the last three failed tool calls', () => {
  const redact = redactor();
  const data = inputs();
  const report = buildReport(data, redact);
  const summary = buildSummary(report, data.toolFailures.map(item => JSON.parse(redact(JSON.stringify(item)))));
  assert.ok(Buffer.byteLength(summary) <= 3072);
  assert.match(summary, /^Vibe Logisim 诊断摘要\n版本：0\.3\.1（安装包）\n系统：Windows 11 10\.0\.22631 x64\nJava：21\.0\.5\nAI 连接：自定义接口 · 模型 gpt-6-sol · 思考深度 high\n网络：系统代理\nAI 状态：连接失败\n/);
  assert.match(summary, /最近错误：401 Incorrect API key provided: \*\*\*/);
  assert.match(summary, /已设置的环境变量：JAVA_TOOL_OPTIONS/);
  assert.match(summary, /共 4 次，列出最后 3 次/);
  assert.equal((summary.match(/^- /gm) || []).length, 3);
  assert.match(summary, /wire_candidate TOOL_REJECTED：要求连接的信号仍然断开: AND Gate@\(124,80\) bit 0，见 <路径>/);
  for (const forbidden of ['<工作区>', '~\\', 'C:\\', 'api.example.org', '127.0.0.1', KEY]) assert.equal(summary.includes(forbidden), false, forbidden);
  const long = buildSummary(report, Array.from({length: 3}, () => ({tool: 't', error: {code: 'X', message: '很长的错误'.repeat(400)}})));
  assert.ok(Buffer.byteLength(long) <= 3072);
});

test('summary text loses every kind of path but keeps ordinary text', () => {
  const cases = [
    ['找不到可执行文件：/tmp/vibe-x/missing-codex', '找不到可执行文件：<路径>'],
    ['读取 <工作区>\\cpu\\a.circ 失败，改用 ~/备份/a.circ', '读取 <路径> 失败，改用 <路径>'],
    ['打开 C:/Users/x/a.circ 或 d:\\作业\\b.circ', '打开 <路径> 或 <路径>'],
    ['共享盘 \\\\nas\\课设\\c.circ 不可写', '共享盘 <路径> 不可写'],
    ['401 from https://api.example.org/v1/responses', '401 from https://api.example.org/v1/responses'],
    ['大约 ~5 秒后重试，端口 in0/out1 断开', '大约 ~5 秒后重试，端口 in0/out1 断开'],
  ];
  for (const [input, expected] of cases) assert.equal(stripPaths(input), expected, input);
});

test('the issue link prefills the form fields and stays far below the URL limit', () => {
  const url = new URL(issueUrl(buildReport(inputs(), redactor())));
  assert.equal(url.origin + url.pathname, 'https://github.com/FIY-pc/vibe-logisim/issues/new');
  assert.equal(url.searchParams.get('template'), 'bug-report.yml');
  assert.equal(url.searchParams.get('version'), '0.3.1');
  assert.equal(url.searchParams.get('os'), 'Windows 11 10.0.22631 x64');
  assert.equal(url.searchParams.get('connection'), '自定义接口');
  assert.ok(url.href.length < 8192);
});

test('the bundle redacts logs and the opted-in circuit, and lists its entries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-bundle-'));
  const log = path.join(directory, 'vibe-logisim.log'), older = path.join(directory, 'vibe-logisim.1.log');
  fs.writeFileSync(log, `2026 [codex] Authorization: Bearer ${KEY}\n2026 [studio] open ${ROOT}\\cpu.circ\n`);
  fs.writeFileSync(older, `2026 [main] home ${HOME}\\AppData\n`);
  const circuit = {text: `<project><lib desc="file#${HOME}\\libs\\cs3410.jar" name="7"/><comp name="Pin"><a name="label" val="${SN}"/></comp></project>`};
  const bundle = createDiagnosticsBundle({inputs: inputs(), logFiles: [log, older, path.join(directory, 'missing.log')], circuit, redact: redactor(), secrets: [KEY], homeDir: HOME, now: new Date(2026, 8, 27, 14, 5)});
  const entries = readZip(bundle.buffer);
  assert.deepEqual(entries.map(entry => entry.name), ['README.txt', 'summary.txt', 'report.json', 'tool-failures.json', 'logs/vibe-logisim.log', 'logs/vibe-logisim.1.log', 'circuit/current.circ']);
  assert.deepEqual(bundle.entries.map(entry => entry.name), entries.map(entry => entry.name));
  const all = entries.map(entry => entry.data.toString('utf8')).join('\n');
  for (const forbidden of [KEY, '张三', '组原', SN]) assert.equal(all.includes(forbidden), false, forbidden);
  assert.match(entries[4].data.toString(), /Bearer \*\*\*\n.*open <工作区>\\cpu\.circ/);
  assert.match(entries[6].data.toString(), /file#~\\libs\\cs3410\.jar.*val="<学号>"/);
  assert.equal(JSON.parse(entries[3].data).length, 4);
  assert.equal(bundle.summary, entries[1].data.toString());
  assert.match(bundle.issueUrl, /template=bug-report\.yml/);
  const without = createDiagnosticsBundle({inputs: inputs({toolFailures: []}), redact: redactor(), secrets: [KEY], homeDir: HOME});
  assert.equal(readZip(without.buffer).some(entry => entry.name.startsWith('circuit/')), false);
  assert.match(without.summary, /最近没有失败的电路工具调用/);
});

test('the final check refuses a bundle whose redaction was skipped', () => {
  const zip = entries => createZip(entries.map(([name, data]) => ({name, data})));
  assert.throws(() => verifyBundle(zip([['logs/a.log', `token ${KEY}`]]), {secrets: [KEY]}), /logs\/a\.log 里仍有 API 密钥/);
  assert.throws(() => verifyBundle(zip([['r.json', '{"p":"C:\\\\Users\\\\张三\\\\x"}']]), {homeDir: HOME}), /用户目录路径/);
  assert.throws(() => verifyBundle(zip([['r.json', 'c:/users/张三/x']]), {homeDir: HOME}), /用户目录路径/);
  assert.throws(() => verifyBundle(zip([['r.json', 'C:\\Users\\ZHANGS~1\\x']]), {homeDir: [HOME, 'C:\\Users\\ZHANGS~1']}), /用户目录路径/);
  assert.throws(() => verifyBundle(zip([['r.json', `id ${SN}`]]), {}), /学号/);
  assert.throws(() => verifyBundle(zip([['r.json', '张三' + '_cpu.circ']]), {}), /像姓名的文件名前缀/);
  // A sibling account is not the home directory; a redacted bundle passes.
  verifyBundle(zip([['r.json', 'C:\\Users\\张三丰\\x and ~\\AppData and <学号> and <姓名>_cpu']]), {secrets: [KEY], homeDir: HOME});
  // An identity "redactor" cannot slip a key through createDiagnosticsBundle.
  assert.throws(() => createDiagnosticsBundle({inputs: inputs(), redact: value => value, secrets: [KEY], homeDir: HOME}), /仍有/);
});

test('bundle file names, path traits and the Java probe', async () => {
  assert.equal(bundleFileName('0.3.1', new Date(2026, 8, 27, 9, 4)), 'vibe-logisim-诊断-0.3.1-20260927-0904.zip');
  assert.equal(pathTraits(null), null);
  assert.deepEqual(pathTraits('\\\\nas\\共享\\OneDrive - 学校\\课设'), {length: 25, depth: 4, nonAscii: true, spaces: true, oneDrive: true, network: true, drive: null});
  const fake = (stderr, error = null) => (_file, _args, _options, callback) => callback(error, '', stderr);
  assert.deepEqual(await probeJavaVersion('java', {run: fake('openjdk version "21.0.5" 2024-10-15 LTS\nOpenJDK Runtime Environment Temurin-21.0.5+11 (build 21.0.5+11-LTS)\n')}),
    {version: '21.0.5', runtime: 'OpenJDK Runtime Environment Temurin-21.0.5+11 (build 21.0.5+11-LTS)'});
  assert.deepEqual(await probeJavaVersion('java', {run: fake('', Object.assign(new Error('spawn java ENOENT'), {code: 'ENOENT'}))}), {version: null, error: '找不到 java'});
});
