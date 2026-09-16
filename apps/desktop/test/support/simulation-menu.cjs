'use strict';
// Follow the same manual menu entry a user can discover; never click hidden DOM.
async function simulationMenu(page, id) {
  if (!await page.locator('#simulationMenu').isVisible()) await page.locator('#simulationMenuButton').click();
  await page.locator('#'+id).click();
}
module.exports = {simulationMenu};
