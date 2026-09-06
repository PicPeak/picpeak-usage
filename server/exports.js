"use strict";
const crypto = require("node:crypto");
const { readSnapshot } = require("./database");
const { contributionRows } = require("./maintainer");

// One database snapshot per export, bounded pages and backpressure. A stalled
// browser must not hold a DB connection/SQLite read transaction indefinitely.
async function streamExport({
  res,
  db,
  collector,
  credential,
  installationId,
  maintainer = false,
}) {
  const timeout = setTimeout(() => res.destroy(), 30000);
  timeout.unref();
  const write = async (value) => {
    if (res.destroyed) throw new Error("Export closed");
    if (res.write(value)) return;
    await new Promise((resolve) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
    });
    if (res.destroyed) throw new Error("Export closed");
  };
  try {
    await readSnapshot(db, async (tx) => {
      if (installationId)
        await collector.requireInstallation(installationId, tx);
      else if (!maintainer) await collector.reader(credential, tx);
      const revision = await collector.revision(tx);
      const exportedAt = new Date(collector.now()).toISOString();
      const receiptId = crypto.randomUUID();
      res.set({
        "X-Dataset-Revision": revision,
        "X-Exported-At": exportedAt,
        "X-Export-Receipt": receiptId,
      });
      let count = 0;
      if (maintainer) {
        res.type("application/x-ndjson").attachment("picpeak-usage-maintainer.ndjson");
        const counts = {};
        await write(`${JSON.stringify({ type: "manifest", data: {
          format: "maintainer-export.v1", revision, exported_at: exportedAt,
          scope: installationId || "all_reporters",
        } })}\n`);
        for await (const record of contributionRows(tx, installationId)) {
          counts[record.type] = (counts[record.type] || 0) + 1;
          await write(`${JSON.stringify(record)}\n`);
        }
        await write(`${JSON.stringify({ type: "export_receipt", data: {
          receipt_version: "export.v1", receipt_id: receiptId, exported_at: exportedAt, revision, counts,
        } })}\n`);
      } else if (installationId) {
        res.type("application/json").attachment("picpeak-usage-packets.json");
        await write(
          `${JSON.stringify({ installation_id: installationId }).slice(0, -1)},"packets":[`,
        );
        let after = "";
        for (;;) {
          const rows = await collector.rawPage(installationId, after, tx);
          if (!rows.length) break;
          for (const row of rows) {
            await write(
              `${count++ ? "," : ""}${JSON.stringify(collector.rawPacket(row))}`,
            );
          }
          after = rows.at(-1).report_date;
        }
        // User-held audit receipt. No central export/access history is stored.
        await write(
          `],"export_receipt":${JSON.stringify({
            receipt_version: "export.v1",
            receipt_id: receiptId,
            exported_at: exportedAt,
            revision,
            scope: "unique accepted usage reports",
            packet_count: count,
            retries:
              "first accepted envelope retained; transport retries deduplicated",
          })}}`,
        );
      } else {
        res
          .type("application/x-ndjson")
          .attachment("picpeak-usage-dataset.ndjson");
        let offset = 0;
        do {
          const page = await collector.dataset(offset, 200, tx);
          for (const row of page.records) {
            await write(`${JSON.stringify(row)}\n`);
            count++;
          }
          offset = page.next;
        } while (offset !== null);
      }
    });
    res.end();
  } finally {
    clearTimeout(timeout);
  }
}
module.exports = { streamExport };
