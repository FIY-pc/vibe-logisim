'use strict';
const fs = require('node:fs');
const path = require('node:path');
module.exports = name => {
  const packaged = path.join(__dirname, '../runtime/core', name);
  return require(fs.existsSync(packaged) ? packaged : path.join(__dirname, '../../../packages/agent-runtime/core', name));
};
