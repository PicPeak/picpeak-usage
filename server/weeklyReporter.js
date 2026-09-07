"use strict";
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");
const { weeklyData } = require("./weeklyData");
const { renderWeeklyEmail } = require("./weeklyEmail");
const { recipientId, WEEK } = require("./weeklyConfig");
const LEASE_MS = 15 * 60000;
const safeCode = error => ["EAUTH", "ECONNECTION", "ETIMEDOUT", "ESOCKET", "ETLS", "EENVELOPE", "EMESSAGE"].includes(error?.code) ? error.code : "DELIVERY_FAILED";

class WeeklyReporter {
  constructor({ db, config, now = () => Date.now(), transport, onError = () => {} }) {
    this.db = db; this.config = config; this.now = now; this.onError = onError;
    this.transport = transport || (config.enabled ? nodemailer.createTransport({ ...config.smtp, pool: true, maxConnections: 1, maxMessages: 20 }) : null);
    this.running = null; this.stopped = false; this.timer = null;
  }
  start() {
    if (!this.config.enabled || this.timer) return;
    const tick = () => this.tick().catch(() => this.onError("SCHEDULER_FAILED"));
    void tick();
    this.timer = setInterval(tick, 60000);
    this.timer.unref();
  }
  tick() {
    if (this.stopped || !this.config.enabled) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    // One bounded part per recipient per tick. Large inboxes continue on the
    // next tick; successful parts never wait for the next weekly schedule.
    for (const address of this.config.recipients) {
      if (this.stopped) break;
      const id = recipientId(address), now = this.now();
      const row = await this.db("weekly_recipients").where({ id }).first();
      if (!row || Date.parse(row.period_end) + this.config.scheduleOffset > now || Number(row.next_attempt_at) > now) continue;
      const lease = crypto.randomUUID();
      const claimed = await this.db("weekly_recipients").where({ id, period_end: row.period_end, part: row.part })
        .where("lease_until", "<=", now).where("next_attempt_at", "<=", now)
        .update({ lease_id: lease, lease_until: now + LEASE_MS });
      if (claimed !== 1) continue;
      const renew = setInterval(() => {
        this.db("weekly_recipients").where({ id, lease_id: lease }).update({ lease_until: this.now() + LEASE_MS })
          .catch(() => this.onError("LEASE_RENEWAL_FAILED"));
      }, 30000);
      renew.unref();
      try {
        const data = await weeklyData(this.db, row.period_end, id, this.now());
        const rendered = renderWeeklyEmail(data, this.config, row.part);
        const deliveryId = crypto.createHash("sha256").update(`${id}:${row.period_end}:${row.part}`).digest("hex");
        const result = await this.transport.sendMail({
          from: this.config.from, to: address, replyTo: this.config.replyTo,
          subject: rendered.subject, text: rendered.text, html: rendered.html,
          messageId: `<weekly-${deliveryId}@${new URL(this.config.baseUrl).hostname}>`,
          disableFileAccess: true, disableUrlAccess: true,
        });
        if (!result.accepted?.some(value => String(value).toLowerCase() === address.toLowerCase())) {
          const error = new Error("Recipient not accepted"); error.code = "EENVELOPE"; throw error;
        }
        await this.acknowledge(id, lease, row, rendered);
      } catch (error) {
        const failures = Math.min(Number(row.failures) + 1, 20), code = safeCode(error);
        await this.db("weekly_recipients").where({ id, lease_id: lease }).update({
          failures, last_error: code, lease_id: null, lease_until: 0,
          next_attempt_at: this.now() + Math.min(6 * 3600000, 5 * 60000 * 2 ** (failures - 1)),
        });
        this.onError(code);
      } finally {
        clearInterval(renew);
      }
    }
  }
  async acknowledge(id, lease, row, rendered) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(async tx => {
          const state = await tx("weekly_recipients").where({ id, lease_id: lease }).first();
          if (!state) throw new Error("Delivery lease lost");
          if (rendered.hasMore && rendered.feedbackIds.length) {
            // SELECT from live feedback: never recreate a receipt for an item
            // deleted while SMTP was in flight. Foreign keys cascade on opt-out.
            await tx("weekly_feedback_receipts").insert(
              tx("feedback").select(tx.raw("? as recipient_id", [id]), "id").whereIn("id", rendered.feedbackIds),
            ).onConflict(["recipient_id", "feedback_id"]).ignore();
          }
          if (!rendered.hasMore) await tx("weekly_feedback_receipts").where({ recipient_id: id }).delete();
          await tx("weekly_recipients").where({ id, lease_id: lease }).update({
            period_end: rendered.hasMore ? row.period_end : new Date(Date.parse(row.period_end) + WEEK).toISOString(),
            part: rendered.hasMore ? Number(row.part) + 1 : 1,
            lease_id: null, lease_until: 0, next_attempt_at: 0, failures: 0, last_error: null,
            last_sent_at: new Date(this.now()).toISOString(),
          });
        }, this.db.client.config.client === "pg" ? { isolationLevel: "serializable" } : undefined);
      } catch (error) {
        if (attempt >= 2 || !["40001", "40P01", "SQLITE_BUSY"].includes(error.code)) throw error;
      }
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
    this.transport?.close?.();
  }
}
module.exports = { WeeklyReporter, LEASE_MS };
