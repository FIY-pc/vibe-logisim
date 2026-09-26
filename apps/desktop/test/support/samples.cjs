'use strict';
// Skip a test script cleanly when its sample files are not present.
//
// Several acceptance scripts were written against circuits, course libraries
// and runtime files that are not distributed with the repository (exports/,
// archive/, experiments/, the course package under workspaces/). In a plain
// checkout they must say so and exit 0 instead of failing on a missing path.
//
//   const {requireSamples} = require('./support/samples.cjs');
//   requireSamples(repo, 'exports/interface-editing/stage6-if-id.circ');
const fs = require('node:fs');
const path = require('node:path');

const NOTE = 'sample files not in the repository (development material kept alongside a checkout)';

function missingSamples(repo, ...relative) {
  return relative.filter(p => !fs.existsSync(path.resolve(repo, p)));
}

function requireSamples(repo, ...relative) {
  const missing = missingSamples(repo, ...relative);
  if (!missing.length) return;
  console.log(`SKIP: ${NOTE}: ${missing.join(', ')}`);
  process.exit(0);
}

module.exports = {requireSamples, missingSamples, NOTE};
