'use strict';
// The production systemd sandbox, no Codex model/provider or authentication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {isolatedSpawn} = require('../electron/agent-process.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-reference-mount-'));
try {
  for (const dir of ['profile','workspace']) fs.mkdirSync(path.join(root,dir));
  const agent = {codex:'/usr/bin/python3',profileDir:path.join(root,'profile'),workDir:path.join(root,'workspace')};
  const script = `
from pathlib import Path
import json
p=Path('/tmp/vibe-circuit-reference/java-runtime.md')
assert 'Instance.getInstanceFor' in p.read_text()
try:
    with p.open('ab') as f: f.write(b'')
except OSError: pass
else: raise AssertionError('Reference mount is writable')
assert not list(Path('/tmp/workspace').iterdir())
Path('/tmp/workspace/check.txt').write_text('workspace stays writable')
print(json.dumps({'referenceReadable':True,'referenceReadOnly':True,'workspaceUnpolluted':True,'workspaceWritable':True}))
`;
  const command = isolatedSpawn(agent,['-c',script],process.env);
  const result = spawnSync(command.command,command.args,{cwd:command.cwd,env:command.env,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr || String(result.error));
  assert.equal(fs.readFileSync(path.join(root,'workspace/check.txt'),'utf8'),'workspace stays writable');
  console.log(result.stdout.trim());
} finally {fs.rmSync(root,{recursive:true,force:true});}
