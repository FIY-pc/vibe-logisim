'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WINDOWS = process.platform === 'win32';

// Layout of the bundled toolchain inside resources/runtime. python-build-standalone
// "install_only" ships bin/python3 on Linux but python.exe at the root on Windows;
// Temurin and the Codex package keep a bin/ directory on both.
function runtimeLayout(runtimeRoot, codexRoot=path.join(runtimeRoot, 'codex')) {
  const exe = WINDOWS ? '.exe' : '';
  return {
    python: WINDOWS ? path.join(runtimeRoot, 'python', 'python.exe') : path.join(runtimeRoot, 'python', 'bin', 'python3'),
    pythonBin: WINDOWS ? path.join(runtimeRoot, 'python') : path.join(runtimeRoot, 'python', 'bin'),
    codex: path.join(codexRoot, 'bin', 'codex' + exe),
    codeModeHost: path.join(codexRoot, 'bin', 'codex-code-mode-host' + exe),
    java: path.join(runtimeRoot, 'java', 'bin', 'java' + exe),
    javac: path.join(runtimeRoot, 'java', 'bin', 'javac' + exe),
    javaBin: path.join(runtimeRoot, 'java', 'bin'),
    codexBin: path.join(codexRoot, 'bin'),
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
  const manifestFile = path.join(process.resourcesPath, 'codex-runtime.json');
  const spec = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  if (spec && (spec.target !== `${process.platform}-${process.arch}` || !/^[a-f0-9]{64}$/.test(spec.sha256))) throw new Error('Codex 运行时清单不适用于当前系统。');
  const codexRoot = spec ? path.join(app.getPath('userData'), 'runtimes', 'codex', spec.sha256.slice(0, 16)) : path.join(runtimeRoot, 'codex');
  const layout = runtimeLayout(runtimeRoot, codexRoot);
  const programs = {
    VIBE_LOGISIM_PYTHON: layout.python,
    VIBE_LOGISIM_CODEX: layout.codex,
    VIBE_LOGISIM_CODE_MODE_HOST: layout.codeModeHost,
  };
  for (const program of [layout.python, layout.java, layout.javac]) {
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
  return {repoRoot, runtimeRoot, codexRoot, codexInstallerOptions:spec?{spec, directory:codexRoot, python:layout.python}:null};
}

module.exports = {configureRuntime, runtimeLayout};
