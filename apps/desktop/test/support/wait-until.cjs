'use strict';
const {setTimeout: delay} = require('node:timers/promises');

// Poll on the driver side: the installed Playwright waitForFunction treats
// a Promise as truthy before its value resolves (including Promise<false>).
async function waitUntil(read, {timeout = 30000, label = 'condition'} = {}) {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
module.exports = {waitUntil};
