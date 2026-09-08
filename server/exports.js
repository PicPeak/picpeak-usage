"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { readSnapshot } = require("./database");
const { contributionRows } = require("./maintainer");
const { ProtocolError } = require("../protocol/protocol.cjs");

// Per-process admission, with no waiting queue. Resolve sessions to their
// installation so rotating tokens cannot bypass the per-participant limit.
function createExportStreamer({
  directory = process.env.EXPORT_TEMP_PATH || path.join(process.cwd(), "storage"),
  maxConcurrent = 2,
  maxBytes = 512 * 1024 * 1024,
  timeoutMs = 30000,
} = {}) {
  const active = new Set();
  return async function streamExport(options) {
    const { res, collector, credential, installationId, maintainer } = options;
    const owner = maintainer ? "maintainer" : installationId || await collector.reader(credential);
    if (active.has(owner)) throw new ProtocolError("EXPORT_IN_PROGRESS", 409);
    if (active.size >= maxConcurrent) throw new ProtocolError("EXPORT_BUSY", 503);
    active.add(owner);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const disconnect = () => { if (!res.writableFinished) cancel(); };
    res.once("close", disconnect);
    if (res.destroyed) cancel();
    const timeout = setTimeout(() => { cancel(); res.destroy(); }, timeoutMs);
    timeout.unref();
    let file, filename;
    try {
      controller.signal.throwIfAborted();
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      filename = path.join(directory, `.usage-export-${crypto.randomUUID()}`);
      file = await fs.open(filename, "wx+", 0o600);
      // POSIX anonymous temporary file: no pathname remains for serving,
      // backups or crash leftovers. Closing the descriptor releases the data.
      await fs.unlink(filename);
      filename = undefined;
      let bytes = 0;
      const write = async value => {
        controller.signal.throwIfAborted();
        bytes += Buffer.byteLength(value);
        if (bytes > maxBytes) throw new ProtocolError("EXPORT_TOO_LARGE", 413);
        await file.writeFile(value);
      };
      const metadata = await prepareExport({ ...options, write });
      controller.signal.throwIfAborted();
      // The snapshot is closed before any bytes can reach a slow client.
      res.set({
        "X-Dataset-Revision": metadata.revision,
        "X-Exported-At": metadata.exportedAt,
        "X-Export-Receipt": metadata.receiptId,
      });
      res.type(metadata.type).attachment(metadata.filename);
      await pipeline(file.createReadStream({ start: 0, autoClose: false }), res, {
        signal: controller.signal,
      });
    } catch (error) {
      if (["ENOSPC", "EDQUOT"].includes(error.code))
        throw new ProtocolError("EXPORT_STORAGE_FULL", 503);
      throw error;
    } finally {
      clearTimeout(timeout);
      res.off("close", disconnect);
      try {
        await file?.close();
      } finally {
        active.delete(owner);
        if (filename) await fs.unlink(filename).catch(() => {});
      }
    }
  };
}

// Bounded pages are serialized into the private file in one consistent
// snapshot. Network backpressure never extends this transaction's lifetime.
async function prepareExport({
  write,
  db,
  collector,
  credential,
  installationId,
  maintainer = false,
}) {
  return readSnapshot(db, async (tx) => {
    if (installationId)
      await collector.requireInstallation(installationId, tx);
    else if (!maintainer) await collector.reader(credential, tx);
    const revision = await collector.revision(tx);
    const exportedAt = new Date(collector.now()).toISOString();
    const receiptId = crypto.randomUUID();
    let type = "application/x-ndjson", filename = "picpeak-usage-dataset.ndjson";
    let count = 0;
    if (maintainer) {
      filename = "picpeak-usage-maintainer.ndjson";
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
      type = "application/json";
      filename = "picpeak-usage-packets.json";
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
    return { revision, exportedAt, receiptId, type, filename };
  });
}
module.exports = { createExportStreamer };
