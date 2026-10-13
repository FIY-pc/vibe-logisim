'use strict';

// Hosts may provide the SDK installed beside their own entry. The shared
// runtime keeps its normal bundled/development entry as the default.
let loader = () => import('./builtin-sdk.mjs');
function setSdkLoader(next) {
  if (typeof next !== 'function') throw new TypeError('SDK loader must be a function');
  loader = next;
}
function loadSdk() { return loader(); }

module.exports = {loadSdk, setSdkLoader};
