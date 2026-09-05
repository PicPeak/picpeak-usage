"use strict";
const crypto = require("node:crypto");
const {
  verifyEnvelope,
  digest,
  canonical,
  ProtocolError,
  MAX_AGE_MS,
  FEATURE_KEYS,
} = require("../protocol/protocol.cjs");
const SESSION_MS = 15 * 60 * 1000;

class Collector {
  constructor(db, options = {}) {
    this.db = db;
    this.now = options.now || (() => Date.now());
    this.maxInstallations = options.maxInstallations || 100000;
    this.dailyRegistrations = options.dailyRegistrations || 1000;
  }
  bool(value) {
    return this.db.client.config.client === "pg"
      ? Boolean(value)
      : Number(Boolean(value));
  }

  async receive(envelope) {
    const now = this.now();
    const packet = verifyEnvelope(envelope, now);
    const id = packet.installation_id;
    const packetDigest = digest(canonical(packet));
    const receipt = {
      packet_id: packet.packet_id,
      installation_id: id,
      packet_digest: packetDigest,
      action: packet.action,
      sequence: packet.sequence,
      status: "accepted",
    };
    try {
      return await this.db.transaction(
        async (tx) => {
          await tx("nonces").where("expires_at", "<", now).delete();
          await tx("sessions").where("expires_at", "<", now).delete();
          if (packet.action === "delete") {
            // Possession proof is sufficient for deletion, including when a
            // restored backup has a stale sequence or a previous receipt was lost.
            await tx("revocations")
              .insert({ identity_digest: digest(id) })
              .onConflict("identity_digest")
              .ignore();
            const ownFeedback = tx("feedback")
              .select("id")
              .where({ installation_id: id });
            await tx("votes")
              .where({ installation_id: id })
              .orWhereIn("feedback_id", ownFeedback)
              .delete();
            for (const table of [
              "sessions",
              "feedback",
              "snapshots",
              "reports",
              "operations",
              "nonces",
            ]) {
              await tx(table).where({ installation_id: id }).delete();
            }
            await tx("installations").where({ id }).delete();
            return { ...receipt, status: "deleted" };
          }
          if (
            await tx("revocations")
              .where({ identity_digest: digest(id) })
              .first()
          )
            throw new ProtocolError("IDENTITY_REVOKED", 409);
          const installation = await tx("installations").where({ id }).first();
          const previous = await tx("operations")
            .where({ packet_id: packet.packet_id })
            .first();
          if (
            previous &&
            (previous.installation_id !== id ||
              previous.packet_digest !== packetDigest)
          )
            throw new ProtocolError("PACKET_CONFLICT", 409);
          if (installation && installation.public_key !== envelope.public_key)
            throw new ProtocolError("IDENTITY_CONFLICT", 409);
          if (!installation && packet.action !== "register")
            throw new ProtocolError("NOT_REGISTERED", 409);
          if (await tx("nonces").where({ nonce: envelope.nonce }).first())
            throw new ProtocolError("REPLAYED_NONCE", 409);
          if (previous) {
            await tx("nonces").insert({
              nonce: envelope.nonce,
              installation_id: id,
              expires_at: now + MAX_AGE_MS * 2,
            });
            return JSON.parse(previous.receipt);
          }
          if (packet.action === "register") {
            if (installation) throw new ProtocolError("IDENTITY_CONFLICT", 409);
            if (packet.sequence !== 0)
              throw new ProtocolError("SEQUENCE_CONFLICT", 409);
            const [{ count }] = await tx("installations").count("* as count");
            const [{ count: today }] = await tx("operations")
              .where({
                action: "register",
                day: new Date(now).toISOString().slice(0, 10),
              })
              .count("* as count");
            if (
              Number(count) >= this.maxInstallations ||
              Number(today) >= this.dailyRegistrations
            )
              throw new ProtocolError("REGISTRATION_LIMIT", 429);
            await tx("installations").insert({
              id,
              public_key: envelope.public_key,
              sequence: 0,
            });
          } else {
            const updated = await tx("installations")
              .where({ id, sequence: packet.sequence - 1 })
              .update({ sequence: packet.sequence });
            if (updated !== 1)
              throw new ProtocolError("SEQUENCE_CONFLICT", 409);
          }
          await tx("nonces").insert({
            nonce: envelope.nonce,
            installation_id: id,
            expires_at: now + MAX_AGE_MS * 2,
          });
          if (packet.action === "report") {
            // One current daily report plus one delayed report per receiving day.
            await this.checkQuota(tx, id, "report", 2, now);
            if (
              await tx("reports")
                .where({
                  installation_id: id,
                  report_date: packet.payload.report_date,
                })
                .first()
            )
              throw new ProtocolError("DAILY_REPORT_LIMIT", 429);
            await tx("reports").insert({
              packet_id: packet.packet_id,
              installation_id: id,
              report_date: packet.payload.report_date,
              raw: JSON.stringify(envelope),
              received_at: new Date(now).toISOString(),
            });
            const snapshot = await tx("snapshots")
              .where({ installation_id: id })
              .first();
            if (
              !snapshot ||
              snapshot.report_date < packet.payload.report_date
            ) {
              await tx("snapshots")
                .insert({
                  installation_id: id,
                  report_date: packet.payload.report_date,
                  projection: JSON.stringify(packet.payload),
                })
                .onConflict("installation_id")
                .merge();
            }
          }
          if (packet.action === "feedback") {
            await this.checkQuota(tx, id, "feedback", 10, now);
            await this.addFeedback(tx, id, packet.payload, now);
            receipt.feedback_id = packet.payload.feedback_id;
          }
          if (packet.action === "vote") {
            await this.checkQuota(tx, id, "vote", 100, now);
            await this.setVote(
              tx,
              id,
              packet.payload.feedback_id,
              packet.payload.voted,
            );
          }
          if (packet.action === "session") {
            await this.checkQuota(tx, id, "session", 50, now);
            const token = `ppus_${crypto.randomBytes(32).toString("hex")}`;
            await tx("sessions").insert({
              token_hash: digest(token),
              installation_id: id,
              expires_at: now + SESSION_MS,
            });
            receipt.session_token = token;
            receipt.expires_at = new Date(now + SESSION_MS).toISOString();
          }
          await tx("operations").insert({
            packet_id: packet.packet_id,
            installation_id: id,
            action: packet.action,
            packet_digest: packetDigest,
            receipt: JSON.stringify(receipt),
            day: new Date(now).toISOString().slice(0, 10),
          });
          return receipt;
        },
        this.db.client.config.client === "pg"
          ? { isolationLevel: "serializable" }
          : undefined,
      );
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if (["SQLITE_CONSTRAINT", "23505", "40001", "40P01"].includes(error.code))
        throw new ProtocolError("CONCURRENT_CONFLICT", 409);
      throw error;
    }
  }

  async checkQuota(tx, id, action, maximum, now) {
    const [{ count }] = await tx("operations")
      .where({
        installation_id: id,
        action,
        day: new Date(now).toISOString().slice(0, 10),
      })
      .count("* as count");
    if (Number(count) >= maximum)
      throw new ProtocolError("DAILY_ACTION_LIMIT", 429);
  }

  async addFeedback(tx, id, value, now) {
    const existing = await tx("feedback")
      .where({ id: value.feedback_id })
      .first();
    if (existing) throw new ProtocolError("FEEDBACK_CONFLICT", 409);
    await tx("feedback").insert({
      id: value.feedback_id,
      installation_id: id,
      kind: value.kind,
      title: value.title.trim(),
      body: value.body.trim(),
      name: value.name.trim(),
      allow_public: this.bool(value.allow_public),
      allow_marketing: this.bool(value.allow_marketing),
      published: this.bool(false),
      status: "open",
      created_at: new Date(now).toISOString(),
    });
  }

  async setVote(tx, id, feedbackId, voted) {
    const target = await tx("feedback")
      .where({
        id: feedbackId,
        kind: "feature_request",
        published: this.bool(true),
        allow_public: this.bool(true),
      })
      .first();
    if (!target) throw new ProtocolError("REQUEST_NOT_FOUND", 404);
    if (voted)
      await tx("votes")
        .insert({ installation_id: id, feedback_id: feedbackId })
        .onConflict(["installation_id", "feedback_id"])
        .ignore();
    else
      await tx("votes")
        .where({ installation_id: id, feedback_id: feedbackId })
        .delete();
  }

  async lookup(id) {
    if (
      typeof id !== "string" ||
      !/^[a-f0-9]{64}$/.test(id) ||
      !(await this.db("installations").where({ id }).first())
    )
      throw new ProtocolError("INSTALLATION_NOT_FOUND", 404);
    const rows = await this.db("reports")
      .where({ installation_id: id })
      .orderBy("report_date", "asc");
    return {
      installation_id: id,
      packets: rows.map((row) => ({
        envelope: JSON.parse(row.raw),
        received_at: row.received_at,
        signature_verified: true,
      })),
    };
  }

  async participant(token, db = this.db) {
    if (!/^ppus_[a-f0-9]{64}$/.test(token || ""))
      throw new ProtocolError("PARTICIPANT_AUTH_REQUIRED", 401);
    const session = await db("sessions")
      .where({ token_hash: digest(token) })
      .where("expires_at", ">", this.now())
      .first();
    if (!session) throw new ProtocolError("PARTICIPANT_AUTH_REQUIRED", 401);
    return session.installation_id;
  }

  async publicFeedback(kind = "feature_request", participantId = null) {
    const rows = await this.db("feedback")
      .where({
        kind,
        published: this.bool(true),
        allow_public: this.bool(true),
      })
      .orderBy("created_at", "desc");
    const counts = await this.db("votes")
      .select("feedback_id")
      .count("* as count")
      .groupBy("feedback_id");
    const own = participantId
      ? await this.db("votes")
          .where({ installation_id: participantId })
          .pluck("feedback_id")
      : [];
    const votes = new Map(counts.map((r) => [r.feedback_id, Number(r.count)]));
    return rows.map(
      ({ id, title, body, name, status, created_at, allow_marketing }) => ({
        id,
        title,
        body,
        name,
        status,
        created_at,
        allow_marketing: Boolean(allow_marketing),
        votes: votes.get(id) || 0,
        voted: own.includes(id),
      }),
    );
  }

  async summary() {
    const snapshots = await this.db("snapshots").select("projection");
    const data = snapshots.map((row) => JSON.parse(row.projection));
    const versions = {};
    const layouts = {};
    const features = Object.fromEntries(
      FEATURE_KEYS.map((key) => [key, { configured: 0, used: 0 }]),
    );
    for (const report of data) {
      versions[report.picpeak_version] =
        (versions[report.picpeak_version] || 0) + 1;
      for (const key of FEATURE_KEYS) {
        features[key].configured += Number(report.features[key].configured);
        features[key].used += Number(report.features[key].used);
      }
      for (const layout of report.gallery_layouts)
        layouts[layout] = (layouts[layout] || 0) + 1;
    }
    const history = await this.db("reports")
      .select("report_date")
      .count("* as reports")
      .groupBy("report_date")
      .orderBy("report_date", "asc");
    return {
      schema_version: "usage.v1",
      installations: data.length,
      features,
      versions,
      layouts,
      history: history.map((r) => ({
        date: r.report_date,
        reports: Number(r.reports),
      })),
    };
  }

  async dataset(offset = 0, limit = 200) {
    const rows = await this.db("snapshots")
      .select("projection")
      .orderBy("installation_id")
      .offset(offset)
      .limit(limit + 1);
    return {
      records: rows.slice(0, limit).map((r) => JSON.parse(r.projection)),
      next: rows.length > limit ? offset + limit : null,
    };
  }

  async moderate(id, changes) {
    if (
      !changes ||
      Object.keys(changes).some((k) => !["published", "status"].includes(k)) ||
      typeof changes.published !== "boolean" ||
      !["open", "planned", "in_progress", "completed", "declined"].includes(
        changes.status,
      )
    )
      throw new ProtocolError("INVALID_MODERATION");
    const row = await this.db("feedback").where({ id }).first();
    if (!row) throw new ProtocolError("FEEDBACK_NOT_FOUND", 404);
    if (changes.published && (!row.allow_public || row.kind === "feedback"))
      throw new ProtocolError("PUBLICATION_NOT_AUTHORIZED", 403);
    await this.db("feedback")
      .where({ id })
      .update({
        published: this.bool(changes.published),
        status: changes.status,
      });
    return { ok: true };
  }
}
module.exports = { Collector };
