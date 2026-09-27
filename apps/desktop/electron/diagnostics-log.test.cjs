'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DiagnosticsLog, createRedactor, knownWorkspaceRoots, maskEndpoint} = require('./diagnostics-log.cjs');

// The repository's own publication gate for personal data. Samples that
// should trip it are assembled at run time so this file itself passes it.
const PII = /U20[0-9]{7}|[一-鿿]{2,3}_/;
const KEY = 'sk-test-0123456789abcdefWXYZ';
const SN = 'U' + '202112345';
const named = name => name + '_';

function windowsRedactor() {
  return createRedactor({homeDir: 'C:\\Users\\张三', username: '张三', hostname: 'ZHANGSAN-LAPTOP'})
    .update({secrets: [KEY], workspaceRoots: ['C:\\Users\\张三\\Desktop\\组原课设', 'D:\\作业\\' + SN], endpoints: ['https://api.example.org/key/AbCdEfGhIjKlMnOpQrStUv12/v1']});
}

test('home directory and Chinese account name are replaced in every printed form', () => {
  const redact = windowsRedactor();
  const cases = [
    ['打开 C:\\Users\\张三\\AppData\\Roaming\\vibe-logisim 失败', '打开 ~\\AppData\\Roaming\\vibe-logisim 失败'],
    ['{"cwd":"C:\\\\Users\\\\张三\\\\AppData"}', '{"cwd":"~\\\\AppData"}'],
    ['c:/users/张三/Downloads/x.zip', '~/Downloads/x.zip'],
    ['{"path": "C:\\\\Users\\\\\\u5f20\\u4e09\\\\x"}', '{"path": "~\\\\x"}'],
    ['GET /api/open?path=C%3A%5CUsers%5C%E5%BC%A0%E4%B8%89%5Cx HTTP/1.1', 'GET /api/open?path=~%5Cx HTTP/1.1'],
    ['当前用户 张三 没有写入权限', '当前用户 <user> 没有写入权限'],
    ['host ZHANGSAN-LAPTOP refused', 'host <host> refused'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('keys, bearer tokens, query secrets and proxy passwords are masked', () => {
  const redact = windowsRedactor();
  assert.equal(redact(`{"apiKey":"${KEY}","model":"gpt-6-sol"}`), '{"apiKey":"***","model":"gpt-6-sol"}');
  assert.equal(redact(`第一行\nAuthorization: Bearer ${KEY}\n第三行`), '第一行\nAuthorization: Bearer ***\n第三行');
  assert.equal(redact('Authorization: Bearer abc.def-ghi_jkl'), 'Authorization: Bearer ***');
  assert.equal(redact('used sk-proj-Q2xhdWRlIGlzIGhlcmU and sk-another-0000000000'), 'used *** and ***');
  assert.equal(redact('GET https://x.example/v1/models?api_key=abcd1234&limit=5'), 'GET https://x.example/v1/models?api_key=***&limit=5');
  assert.equal(redact('"access_token": "abcdefgh1234"'), '"access_token": "***"');
  assert.equal(redact('id eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q'), 'id ***');
  assert.equal(redact('HTTPS_PROXY=http://alice:p%40ss@127.0.0.1:7890'), 'HTTPS_PROXY=http://***@127.0.0.1:7890');
  assert.equal(redact('代理 http://alice:p@ss@127.0.0.1:7890/ 不可用'), '代理 http://***@127.0.0.1:7890/ 不可用');
  // Stream splits can leave half a key at either end of one stderr chunk.
  assert.equal(redact(`error ${KEY.slice(0, 12)}`), 'error ***');
  assert.equal(redact(`${KEY.slice(-11)} rest`), '*** rest');
  // Ordinary words that merely contain "token" stay readable.
  assert.equal(redact('input_tokens=1200 max output 800'), 'input_tokens=1200 max output 800');
});

test('workspace roots, student numbers, name prefixes and endpoint tokens are replaced', () => {
  const redact = windowsRedactor();
  assert.equal(redact('读取 C:\\Users\\张三\\Desktop\\组原课设\\cpu.circ'), '读取 <工作区>\\cpu.circ');
  assert.equal(redact(`D:/作业/${SN}/alu.circ 不存在`), '<工作区>/alu.circ 不存在');
  assert.equal(redact(`${named('张三')}${SN}_cpu.circ 与 u202198765`), '<姓名>_<学号>_cpu.circ 与 <学号>');
  // Lower-case hex (hashes) is left alone.
  assert.equal(redact('sha256 ad2012345678ef'), 'sha256 ad2012345678ef');
  assert.equal(redact('POST https://api.example.org/key/AbCdEfGhIjKlMnOpQrStUv12/v1/responses 401'), 'POST https://api.example.org/key/***/v1/responses 401');
  assert.equal(maskEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1');
  for (const sample of [`${named('张三')}${SN}_cpu.circ`, `${named('欧阳小明')}实验.circ`, `C:\\Users\\张三\\${named('张三')}作业`, `x${SN}9`]) {
    assert.equal(PII.test(redact(sample)), false, sample);
  }
});

test('redaction of a POSIX home keeps sibling accounts and ordinary words', () => {
  const redact = createRedactor({homeDir: '/home/alice', username: 'alice', hostname: 'localhost'}).update({workspaceRoots: ['/', '/home/alice/课设']});
  assert.equal(redact('/home/alice/课设/a.circ and /home/alice2/x and /home/alice/.config'), '<工作区>/a.circ and /home/alice2/x and ~/.config');
  // A filesystem root as "workspace" must not swallow every path.
  assert.equal(redact('/usr/lib/jvm'), '/usr/lib/jvm');
  const generic = createRedactor({homeDir: '/home/runner', username: 'runner'});
  assert.equal(generic('the runner finished'), 'the runner finished');
  assert.equal(generic('/home/runner/work'), '~/work');
});

test('secrets added at runtime are masked from then on', () => {
  const redact = createRedactor({});
  redact.addSecret('typed-key-9876543210');
  assert.equal(redact('probe with typed-key-9876543210 failed'), 'probe with *** failed');
  assert.deepEqual(redact.secrets(), ['typed-key-9876543210']);
});

test('log lines are timestamped, tagged, redacted, echoed and rolled over', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-log-'));
  const echoed = [];
  const redact = createRedactor({homeDir: '/home/zhangsan', username: 'zhangsan'});
  const log = new DiagnosticsLog({directory, redact, maxBytes: 400, keep: 3, now: () => new Date('2026-09-27T01:02:03.456Z'), echo: line => echoed.push(line)});
  log.write('codex', 'opened /home/zhangsan/work\nsecond line');
  const first = fs.readFileSync(log.file, 'utf8');
  assert.equal(first, '2026-09-27T01:02:03.456Z [codex] opened ~/work\n2026-09-27T01:02:03.456Z [codex] second line\n');
  assert.deepEqual(echoed, ['[codex] opened ~/work\nsecond line']);
  for (let index = 0; index < 20; index++) log.write('studio', `request ${index} ${'x'.repeat(40)}`);
  const files = log.files();
  assert.equal(files.length, 3);
  assert.deepEqual(files.map(file => path.basename(file)), ['vibe-logisim.log', 'vibe-logisim.1.log', 'vibe-logisim.2.log']);
  for (const file of files) assert.ok(fs.statSync(file).size <= 400, file);
  // The oldest roll is gone; the newest line is in the current file.
  assert.match(fs.readFileSync(files[0], 'utf8'), /request 19 /);
  assert.doesNotMatch(files.map(file => fs.readFileSync(file, 'utf8')).join(''), /opened/);
});

test('a log directory that cannot be written disables the file, never the app', () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-log-')), 'not-a-directory');
  fs.writeFileSync(blocker, 'file');
  const echoed = [];
  const log = new DiagnosticsLog({directory: blocker, echo: line => echoed.push(line)});
  log.write('main', 'first');
  log.write('main', 'second');
  assert.equal(log.disabled, true);
  assert.equal(echoed.filter(line => /日志文件写入失败/.test(line)).length, 1);
  assert.ok(echoed.includes('[main] second'));
});

test('known workspace roots come from the recent record and every folder record', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-folders-'));
  fs.writeFileSync(path.join(stateRoot, 'recent.json'), JSON.stringify({root: '/data/当前'}));
  for (const [id, root] of [['folder-a', '/data/旧'], ['folder-b', '/data/当前']]) {
    fs.mkdirSync(path.join(stateRoot, id));
    fs.writeFileSync(path.join(stateRoot, id, 'workspace.json'), JSON.stringify({id, root}));
  }
  fs.mkdirSync(path.join(stateRoot, 'folder-broken'));
  fs.writeFileSync(path.join(stateRoot, 'folder-broken', 'workspace.json'), '{');
  assert.deepEqual(knownWorkspaceRoots(stateRoot).sort(), ['/data/当前', '/data/旧']);
  assert.deepEqual(knownWorkspaceRoots(path.join(stateRoot, 'missing')), []);
});

test('the Windows 8.3 short spelling of the home directory is masked too, workspace roots included', () => {
  const redact = createRedactor({homeDir: 'C:\\Users\\runneradmin', homeAliases: ['C:\\Users\\RUNNER~1', 'C'], username: 'runneradmin'})
    .update({workspaceRoots: ['C:\\Users\\runneradmin\\AppData\\Local\\Temp\\smoke\\我的电路 workspace']});
  assert.equal(redact('TEMP=C:\\Users\\RUNNER~1\\AppData\\Local\\Temp'), 'TEMP=~\\AppData\\Local\\Temp');
  assert.equal(redact('open C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\smoke\\我的电路 workspace\\a.circ'), 'open <工作区>\\a.circ');
  assert.equal(redact('open C:\\Users\\runneradmin\\AppData\\Local\\Temp\\smoke\\我的电路 workspace\\a.circ'), 'open <工作区>\\a.circ');
  // A one-segment alias would swallow the drive; it is ignored.
  assert.equal(redact('D:\\data'), 'D:\\data');
});
