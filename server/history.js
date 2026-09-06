"use strict";
const { FEATURE_KEYS, ProtocolError } = require("../protocol/protocol.cjs");
const { readSnapshot } = require("./database");
const { emptyInventory, addInventory } = require("./inventory");
const DAY = 86400000;

function period(date, interval) {
  if (interval === "month") return `${date.slice(0, 7)}-01`;
  if (interval === "day") return date;
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function nextPeriod(date, interval) {
  const d = new Date(`${date}T00:00:00.000Z`);
  if (interval === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + (interval === "week" ? 7 : 1));
  return d.toISOString().slice(0, 10);
}
function validDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}
function validateOptions(input, maintainer) {
  const keys = [
    "from",
    "to",
    "interval",
    "scope",
    ...(maintainer ? ["installation_id"] : []),
  ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    (input.from !== undefined &&
      input.from !== "all" &&
      !validDate(input.from)) ||
    (input.to !== undefined && !validDate(input.to)) ||
    (input.interval !== undefined &&
      !["day", "week", "month"].includes(input.interval)) ||
    (input.scope !== undefined &&
      !["all", ...(maintainer ? [] : ["own"])].includes(input.scope)) ||
    (input.installation_id !== undefined &&
      (typeof input.installation_id !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.installation_id)))
  )
    throw new ProtocolError("INVALID_HISTORY_FILTER");
}

function bucketSql(db, interval) {
  if (interval === "day") return db.raw("??", ["report_date"]);
  if (db.client.config.client === "pg")
    return db.raw("to_char(date_trunc(?, cast(?? as date)), 'YYYY-MM-DD')", [
      interval,
      "report_date",
    ]);
  return interval === "month"
    ? db.raw("strftime('%Y-%m-01', ??)", ["report_date"])
    : db.raw(
        "date(??, '-' || ((cast(strftime('%w', ??) as integer) + 6) % 7) || ' days')",
        ["report_date", "report_date"],
      );
}

// Read retained reports directly, so opting out removes past contributions too.
// Each reporter contributes its LAST report within each UTC period. Missing
// days/fields are unknown; neither forward-fill nor report-volume weighting.
async function history(
  collector,
  input,
  { credential, maintainer = false } = {},
) {
  validateOptions(input, maintainer);
  return readSnapshot(collector.db, async (tx) => {
    const own = maintainer ? null : await collector.reader(credential, tx);
    const id = maintainer
      ? input.installation_id
      : input.scope === "own"
        ? own
        : null;
    if (id) await collector.requireInstallation(id, tx);
    const base = () => {
      const query = tx("reports");
      if (id) query.where({ installation_id: id });
      return query;
    };
    const bounds = await base()
      .min("report_date as from")
      .max("report_date as to")
      .first();
    const today = new Date(collector.now()).toISOString().slice(0, 10);
    const to = input.to || today;
    const from =
      input.from === "all"
        ? bounds.from || to
        : input.from ||
          new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * DAY)
            .toISOString()
            .slice(0, 10);
    const interval = input.interval || "day";
    if (from > to) throw new ProtocolError("INVALID_HISTORY_RANGE");
    const points = new Map();
    for (
      let date = period(from, interval);
      date <= to;
      date = nextPeriod(date, interval)
    ) {
      if (points.size >= 366)
        throw new ProtocolError("HISTORY_RANGE_TOO_LARGE");
      const end = new Date(
        Date.parse(`${nextPeriod(date, interval)}T00:00:00.000Z`) - DAY,
      )
        .toISOString()
        .slice(0, 10);
      points.set(date, {
        date,
        from: date < from ? from : date,
        to: end > to ? to : end,
        reports: 0,
        reporters: 0,
        inventory: emptyInventory(),
        features: Object.fromEntries(
          FEATURE_KEYS.map((key) => [
            key,
            {
              configured: 0,
              used: 0,
              reported: 0,
              used_reported: 0,
            },
          ]),
        ),
        versions: {},
        layouts: {},
        versions_reported: 0,
        layouts_reported: 0,
        schema_versions: {},
      });
    }
    const range = () => base().whereBetween("report_date", [from, to]);
    const bucket = bucketSql(tx, interval);
    const totals = await range()
      .select({ date: bucket })
      .count("* as reports")
      .groupBy("date");
    for (const row of totals)
      points.get(row.date).reports = Number(row.reports);
    // Keyset pages within each period avoid repeatedly grouping the entire
    // history for every page. The existing (installation_id, report_date)
    // unique index resolves the "no newer report in this period" probe.
    for (const point of points.values()) {
      if (!point.reports) continue;
      let after = "";
      for (;;) {
        const query = tx("reports as r")
          .select("r.installation_id", "r.raw")
          .whereBetween("r.report_date", [point.from, point.to])
          .where("r.installation_id", ">", after)
          .orderBy("r.installation_id")
          .limit(200);
        if (id) query.where("r.installation_id", id);
        if (point.from !== point.to)
          query.whereNotExists(
            tx("reports as newer")
              .select("newer.packet_id")
              .whereColumn("newer.installation_id", "r.installation_id")
              .whereColumn("newer.report_date", ">", "r.report_date")
              .where("newer.report_date", "<=", point.to),
          );
        const rows = await query;
        if (!rows.length) break;
        for (const row of rows) {
          const { packet } = JSON.parse(row.raw);
          const report = packet.payload;
          addInventory(point.inventory, report);
          point.reporters++;
          for (const key of FEATURE_KEYS) {
            const signal = report.features?.[key];
            if (typeof signal?.configured === "boolean") {
              point.features[key].configured += Number(signal.configured);
              point.features[key].reported++;
            }
            if (typeof signal?.used === "boolean") {
              point.features[key].used += Number(signal.used);
              point.features[key].used_reported++;
            }
          }
          if (typeof report.picpeak_version === "string") point.versions_reported++;
          if (Array.isArray(report.gallery_layouts)) point.layouts_reported++;
          for (const [map, values] of [
            [point.versions, typeof report.picpeak_version === "string" ? [report.picpeak_version] : []],
            [point.layouts, report.gallery_layouts || []],
            [point.schema_versions, [packet.schema_version]],
          ])
            for (const value of values) map[value] = (map[value] || 0) + 1;
        }
        after = rows.at(-1).installation_id;
      }
    }
    return {
      revision: await collector.revision(tx),
      interval,
      from,
      to,
      scope: id ? "own" : "all",
      available: bounds,
      aggregation: "latest_report_per_reporter_in_period",
      points: [...points.values()],
    };
  });
}
module.exports = { history };
