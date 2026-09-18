'use strict';

const fs = require('node:fs');
const path = require('node:path');

function candidatePaths(value, workingDirectory, repoRoot) {
  if (path.isAbsolute(value)) return [path.resolve(value)];
  return [
    path.resolve(workingDirectory, value),
    path.resolve(repoRoot, value),
  ];
}

// Electron's argv shape differs between the development launcher and a
// packaged app. The caller removes Electron's own app path before invoking
// this resolver; the resolver only decides what the user's positional path
// means and never guesses a circuit from a directory listing.
function resolveStartupTarget(argv, {
  workingDirectory = process.cwd(),
  repoRoot = workingDirectory,
  ignoredPaths = [],
} = {}) {
  for (const value of argv) {
    if (typeof value !== 'string' || !value || value.startsWith('-')) continue;
    const candidates = candidatePaths(value, workingDirectory, repoRoot);
    if (ignoredPaths.some((ignored) => candidates.some((candidate) => path.resolve(ignored) === candidate))) continue;
    for (const absolute of candidates) {
      let stat;
      try { stat = fs.statSync(absolute); } catch (_) { continue; }
      if (stat.isDirectory()) return {kind: 'folder', path: absolute};
      if (stat.isFile() && path.extname(absolute).toLowerCase() === '.circ') {
        return {kind: 'circuit', path: absolute};
      }
    }

    if (path.extname(value).toLowerCase() === '.circ') {
      return {error: `找不到指定的 .circ 文件：${candidates[0]}`};
    }
    return {error: `找不到指定的工作区文件夹或电路文件：${candidates[0]}`};
  }
  return null;
}

module.exports = {resolveStartupTarget};
