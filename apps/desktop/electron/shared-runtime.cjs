'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
module.exports = name => {
  const packaged = path.join(__dirname, '../runtime/core', name);
  if (fs.existsSync(packaged)) return require(packaged);
  const source = path.join(__dirname, '../../../packages/agent-runtime/core');
  // npm --prefix apps/desktop ci owns this host's SDK installation. Shared
  // modules must not depend on another workspace's node_modules being present.
  require(path.join(source, 'sdk-loader.cjs')).setSdkLoader(
    () => import(pathToFileURL(path.join(__dirname, 'builtin-sdk.mjs')).href));
  return require(path.join(source, name));
};
