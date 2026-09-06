"use strict";
const { ProtocolError } = require("../protocol/protocol.cjs");
const { readSnapshot } = require("./database");

function pageOptions(body = {}, packets = false) {
  const keys = packets
    ? ["installation_id", "after", "revision"]
    : ["after", "revision"];
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key)) ||
    (body.after !== undefined &&
      (typeof body.after !== "string" ||
        !(packets ? /^\d{4}-\d{2}-\d{2}$/ : /^[a-f0-9]{64}$/).test(
          body.after,
        ))) ||
    (body.revision !== undefined &&
      (typeof body.revision !== "string" || !/^\d{1,20}$/.test(body.revision)))
  )
    throw new ProtocolError("INVALID_PAGE");
  return body;
}

async function reporters(collector, body) {
  const { after, revision: expected } = pageOptions(body);
  return readSnapshot(collector.db, async (tx) => {
    const revision = await collector.revision(tx);
    if (after && expected !== revision)
      throw new ProtocolError("DATASET_CHANGED", 409);
    const rows = await tx("installations")
      .where("id", ">", after || "")
      .orderBy("id")
      .limit(201);
    const records = rows.slice(0, 200);
    const ids = records.map((row) => row.id);
    const counts = await tx("reports")
      .whereIn("installation_id", ids)
      .select("installation_id")
      .count("* as reports")
      .min("report_date as first_report")
      .max("report_date as last_report")
      .groupBy("installation_id");
    const snapshots = await tx("snapshots").whereIn("installation_id", ids);
    return {
      revision,
      next: rows.length > 200 ? records.at(-1).id : null,
      records: records.map((row) => {
        const count = counts.find((value) => value.installation_id === row.id);
        const snapshot = snapshots.find(
          (value) => value.installation_id === row.id,
        );
        return {
          ...row,
          sequence: Number(row.sequence),
          reports: Number(count?.reports || 0),
          first_report: count?.first_report || null,
          last_report: count?.last_report || null,
          latest: snapshot ? JSON.parse(snapshot.projection) : null,
        };
      }),
    };
  });
}

// Complete retained contribution data. Authentication state (sessions, nonces,
// revocation digests and deployment secrets) is not part of a usage dataset.
async function* contributionRows(tx, installationId) {
  const sources = [
    ["installations", "reporter", ["id"], "id"],
    ["snapshots", "snapshot", ["installation_id"], "installation_id"],
    ["reports", "report", ["packet_id"], "installation_id"],
    ["feedback", "feedback", ["id"], "installation_id"],
    ["votes", "vote", ["installation_id", "feedback_id"], "installation_id"],
    ["operations", "operation", ["packet_id"], "installation_id"],
  ];
  for (const [table, type, keys, owner] of sources) {
    let after;
    for (;;) {
      const query = tx(table).orderBy(keys).limit(200);
      if (installationId) query.where(owner, installationId);
      if (after)
        query.where(function () {
          this.where(keys[0], ">", after[keys[0]]);
          if (keys[1])
            this.orWhere(function () {
              this.where(keys[0], after[keys[0]]).where(
                keys[1],
                ">",
                after[keys[1]],
              );
            });
        });
      const rows = await query;
      if (!rows.length) break;
      for (const row of rows) {
        const data = { ...row };
        if (type === "report") {
          data.envelope = JSON.parse(data.raw);
          delete data.raw;
        }
        if (type === "snapshot") data.projection = JSON.parse(data.projection);
        if (type === "operation") {
          data.receipt = JSON.parse(data.receipt);
          delete data.receipt.session_token;
        }
        if (type === "reporter") data.sequence = Number(data.sequence);
        if (type === "feedback")
          for (const key of ["allow_public", "allow_marketing", "published"])
            data[key] = Boolean(data[key]);
        yield { type, data };
      }
      after = rows.at(-1);
    }
  }
}
module.exports = { reporters, pageOptions, contributionRows };
