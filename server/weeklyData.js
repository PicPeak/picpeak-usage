"use strict";
const { readSnapshot } = require("./database");
const { emptyInventory, addInventory } = require("./inventory");
const { features } = require("../protocol/features.v5.json");
const { DAY, WEEK } = require("./weeklyConfig");
const { RETENTION_DAYS } = require("./weeklyActivity");

async function receivedSummary(tx, from, to) {
  const range = query => query.where("received_at", ">=", from).where("received_at", "<", to);
  const count = await range(tx("reports")).count("* as total").first();
  const summary = {
    reports: Number(count.total), reporters: 0, inventory: emptyInventory(), versions: {},
    features: Object.fromEntries(Object.keys(features).map(key => [key, { used: 0, used_reported: 0, configured: 0, reported: 0 }])),
  };
  let after = "";
  for (;;) {
    // Among reports received in this window, choose the newest report date per
    // installation. A late, older packet must not replace its newer data.
    const rows = await tx("reports as r").select("r.installation_id", "r.raw")
      .where("r.received_at", ">=", from).where("r.received_at", "<", to)
      .where("r.installation_id", ">", after).orderBy("r.installation_id").limit(200)
      .whereNotExists(tx("reports as newer").select("newer.packet_id")
        .whereColumn("newer.installation_id", "r.installation_id")
        .whereColumn("newer.report_date", ">", "r.report_date")
        .where("newer.received_at", ">=", from).where("newer.received_at", "<", to));
    if (!rows.length) break;
    for (const row of rows) {
      const report = JSON.parse(row.raw).packet.payload;
      summary.reporters++;
      addInventory(summary.inventory, report);
      if (report.picpeak_version) summary.versions[report.picpeak_version] = (summary.versions[report.picpeak_version] || 0) + 1;
      for (const key of Object.keys(features)) {
        const value = report.features?.[key], total = summary.features[key];
        if (typeof value?.configured === "boolean") { total.configured += Number(value.configured); total.reported++; }
        if (typeof value?.used === "boolean") { total.used += Number(value.used); total.used_reported++; }
      }
    }
    after = rows.at(-1).installation_id;
  }
  return summary;
}

function insights(current, previous) {
  const top = [], changes = [], newCoverage = [];
  for (const [key, value] of Object.entries(current.features)) {
    const before = previous.features[key];
    if (features[key].used && value.used_reported) {
      const share = value.used / value.used_reported * 100;
      if (value.used) top.push({ key, ...value, share });
      if (before.used_reported) {
        const previousShare = before.used / before.used_reported * 100;
        if (Math.abs(share - previousShare) >= 0.05) changes.push({ key, ...value, share, previousShare, delta: share - previousShare });
      }
    }
    if ((value.reported && !before.reported) || (value.used_reported && !before.used_reported)) newCoverage.push(key);
  }
  return {
    top: top.sort((a, b) => b.share - a.share || b.used_reported - a.used_reported || a.key.localeCompare(b.key)).slice(0, 5),
    changes: changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key)).slice(0, 5),
    newCoverage,
    newVersions: Object.keys(current.versions).filter(version => !previous.versions[version]).sort(),
  };
}

async function weeklyData(db, periodEnd, recipient, now = Date.now()) {
  const end = Date.parse(periodEnd), start = end - WEEK;
  const from = new Date(start).toISOString(), previousFrom = new Date(start - WEEK).toISOString();
  return readSnapshot(db, async tx => {
    const current = await receivedSummary(tx, from, periodEnd);
    const previous = await receivedSummary(tx, previousFrom, from);
    const registered = await tx("installations").count("* as total").first();
    const activity = await tx("weekly_activity").where("day", ">=", from.slice(0, 10))
      .where("day", "<", periodEnd.slice(0, 10)).sum("joined as joined").sum("removed as removed").first();
    const meta = await tx("weekly_report_meta").where({ id: 1 }).first();
    const availableFrom = Math.max(Date.parse(meta.tracking_since) || Infinity, Date.parse(new Date(now - RETENTION_DAYS * DAY).toISOString().slice(0, 10)));
    const feedbackRange = () => tx("feedback").where("created_at", ">=", from).where("created_at", "<", periodEnd);
    const feedbackCount = await feedbackRange().count("* as total").first();
    const feedback = await feedbackRange().select("id", "kind", "title", "body", "name", "status", "created_at", "allow_public", "allow_marketing", "published")
      .whereNotExists(tx("weekly_feedback_receipts").select("feedback_id")
        .where({ recipient_id: recipient }).whereColumn("feedback_id", "feedback.id"))
      .orderBy("id").limit(21);
    return {
      from, to: periodEnd, registered: Number(registered.total),
      joined: availableFrom < end ? Number(activity.joined || 0) : null,
      removed: availableFrom < end ? Number(activity.removed || 0) : null,
      partialActivity: availableFrom > start,
      current, previous, ...insights(current, previous), feedback,
      feedbackCount: Number(feedbackCount.total),
    };
  });
}
module.exports = { weeklyData, receivedSummary, insights };
