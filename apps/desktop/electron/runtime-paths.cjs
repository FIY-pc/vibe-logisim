'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WINDOWS = process.platform === 'win32';

// Layout of the bundled toolchain inside resources/runtime. python-build-standalone
// "install_only" ships bin/python3 on Linux but python.exe at the root on Windows;
// Temurin and the Codex package keep a bin/ directory on both.
function runtimeLayout(runtimeRoot) {
  const exe = WINDOWS ? '.exe' : '';
  return {
    python: WINDOWS ? path.join(runtimeRoot, 'python', 'python.exe') : path.join(runtimeRoot, 'python', 'bin', 'python3'),
    pythonBin: WINDOWS ? path.join(runtimeRoot, 'python') : path.join(runtimeRoot, 'python', 'bin'),
    codex: path.join(runtimeRoot, 'codex', 'bin', 'codex' + exe),
    codeModeHost: path.join(runtimeRoot, 'codex', 'bin', 'codex-code-mode-host' + exe),
    java: path.join(runtimeRoot, 'java', 'bin', 'java' + exe),
    javac: path.join(runtimeRoot, 'java', 'bin', 'javac' + exe),
    javaBin: path.join(runtimeRoot, 'java', 'bin'),
    codexBin: path.join(runtimeRoot, 'codex', 'bin'),
  };
}

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
  const layout = runtimeLayout(runtimeRoot);
  const programs = {
    VIBE_LOGISIM_PYTHON: layout.python,
    VIBE_LOGISIM_CODEX: layout.codex,
    VIBE_LOGISIM_CODE_MODE_HOST: layout.codeModeHost,
  };
  for (const program of [...Object.values(programs), layout.java, layout.javac]) {
    try { fs.accessSync(program, WINDOWS ? fs.constants.F_OK : fs.constants.X_OK); }
    catch { throw new Error('应用运行文件不完整，请重新解压完整的 Vibe Logisim 安装包。'); }
  }
  Object.assign(process.env, programs, {
    JAVA_HOME: path.join(runtimeRoot, 'java'),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    PATH: [layout.pythonBin, layout.javaBin, layout.codexBin, process.env.PATH || (WINDOWS ? '' : '/usr/bin:/bin')]
      .filter(Boolean).join(path.delimiter),
  });
  // An inherited development Python environment must not redirect stdlib loads.
  delete process.env.PYTHONHOME;
  delete process.env.PYTHONPATH;
  return {repoRoot, runtimeRoot};
}

module.exports = {configureRuntime, runtimeLayout};
