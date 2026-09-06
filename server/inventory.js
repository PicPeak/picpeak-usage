"use strict";
const { INVENTORY_KEYS } = require("../protocol/schema.cjs");

const emptyInventory = () => Object.fromEntries(INVENTORY_KEYS.map(key => [key, { total: 0, reported: 0 }]));
function addInventory(totals, report) {
  for (const key of INVENTORY_KEYS) {
    const value = report.inventory?.[key];
    // Old reports did not ask for these totals. Unknown is distinct from zero.
    if (Number.isSafeInteger(value) && value >= 0) {
      const total = totals[key].total + value;
      if (!Number.isSafeInteger(total)) throw new Error("Inventory total exceeds safe integer range");
      totals[key].total = total;
      totals[key].reported++;
    }
  }
}
module.exports = { emptyInventory, addInventory };
