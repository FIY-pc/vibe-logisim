'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {resolveStartupTarget} = require('./startup-target.cjs');

test('resolves a workspace folder passed to the desktop launcher', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-startup-target-'));
  try {
    fs.mkdirSync(path.join(root, 'workspace'));
    assert.deepEqual(resolveStartupTarget(['workspace'], {workingDirectory: root, repoRoot: root}), {
      kind: 'folder', path: path.join(root, 'workspace'),
    });
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('resolves a circuit file and keeps a missing explicit file visible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-startup-target-'));
  try {
    const circuit = path.join(root, 'main.circ');
    fs.writeFileSync(circuit, '<circuit/>');
    assert.deepEqual(resolveStartupTarget(['main.circ'], {workingDirectory: root, repoRoot: root}), {
      kind: 'circuit', path: circuit,
    });
    assert.match(resolveStartupTarget(['missing.circ'], {workingDirectory: root, repoRoot: root}).error, /missing\.circ/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('does not mistake Electron app path for a folder target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-startup-target-'));
  try {
    fs.mkdirSync(path.join(root, 'electron-app'));
    fs.mkdirSync(path.join(root, 'project'));
    assert.deepEqual(resolveStartupTarget(['electron-app', 'project'], {
      workingDirectory: root,
      repoRoot: root,
      ignoredPaths: [path.join(root, 'electron-app')],
    }), {kind: 'folder', path: path.join(root, 'project')});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
