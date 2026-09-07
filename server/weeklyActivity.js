"use strict";
const { DAY, firstPeriodEnd, recipientId } = require("./weeklyConfig");
const RETENTION_DAYS = 90;

async function prepareWeeklyReporting(db, config, now = Date.now()) {
  await db.transaction(async tx => {
    if (!config.enabled) {
      await tx("weekly_recipients").delete();
      await tx("weekly_activity").delete();
      await tx("weekly_report_meta").where({ id: 1 }).update({ tracking_since: null });
      return;
    }
    await tx("weekly_report_meta").where({ id: 1 }).whereNull("tracking_since")
      .update({ tracking_since: new Date(now).toISOString() });
    const ids = config.recipients.map(recipientId);
    await tx("weekly_recipients").whereNotIn("id", ids).delete();
    for (const id of ids) await tx("weekly_recipients").insert({
      id, period_end: new Date(firstPeriodEnd(now, config)).toISOString(),
    }).onConflict("id").ignore();
  });
}
async function recordParticipation(tx, kind, now) {
  const meta = await tx("weekly_report_meta").where({ id: 1 }).first();
  if (!meta?.tracking_since) return false;
  if (!["joined", "removed"].includes(kind)) throw new Error("Invalid participation counter");
  const day = new Date(now).toISOString().slice(0, 10);
  await tx("weekly_activity").insert({ day }).onConflict("day").ignore();
  await tx("weekly_activity").where({ day }).increment(kind, 1);
  return true;
}
async function pruneWeeklyActivity(db, now) {
  await db("weekly_activity").where("day", "<", new Date(now - RETENTION_DAYS * DAY).toISOString().slice(0, 10)).delete();
}
module.exports = { prepareWeeklyReporting, recordParticipation, pruneWeeklyActivity, RETENTION_DAYS };
