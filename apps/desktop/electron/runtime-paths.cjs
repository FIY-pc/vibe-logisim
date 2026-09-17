'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A packaged app has one private, relocatable toolchain. Never silently fall
// back to tools installed on the user's machine when a bundle is incomplete.
function configureRuntime(app) {
  if (!app.isPackaged) return {repoRoot: path.resolve(__dirname, '../../..'), runtimeRoot: null};
  // Development and the distributed app must not delete/rewrite each other's
  // login profile or thread mappings when used on the same computer.
  app.setName('Vibe Logisim');
  app.setPath('userData', path.join(app.getPath('appData'), 'vibe-logisim'));
  const runtimeRoot = path.join(process.resourcesPath, 'runtime');
  const repoRoot = path.join(process.resourcesPath, 'product');
  const programs = {
    VIBE_LOGISIM_PYTHON: path.join(runtimeRoot, 'python/bin/python3'),
    VIBE_LOGISIM_CODEX: path.join(runtimeRoot, 'codex/bin/codex'),
    VIBE_LOGISIM_CODE_MODE_HOST: path.join(runtimeRoot, 'codex/bin/codex-code-mode-host'),
  };
  for (const program of [...Object.values(programs), path.join(runtimeRoot, 'java/bin/java'), path.join(runtimeRoot, 'java/bin/javac')]) {
    try { fs.accessSync(program, fs.constants.X_OK); }
    catch { throw new Error('应用运行文件不完整，请重新解压完整的 Vibe Logisim 安装包。'); }
  }
  Object.assign(process.env, programs, {
    JAVA_HOME: path.join(runtimeRoot, 'java'),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PATH: [path.join(runtimeRoot, 'python/bin'), path.join(runtimeRoot, 'java/bin'),
      path.join(runtimeRoot, 'codex/bin'), process.env.PATH || '/usr/bin:/bin'].join(path.delimiter),
  });
  // An inherited development Python environment must not redirect stdlib loads.
  delete process.env.PYTHONHOME;
  delete process.env.PYTHONPATH;
  return {repoRoot, runtimeRoot};
}

module.exports = {configureRuntime};
