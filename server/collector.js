"use strict";
const crypto = require("node:crypto");
const {
  verifyReceivedEnvelope,
  digest,
  canonical,
  ProtocolError,
  MAX_AGE_MS,
  ALL_FEATURE_KEYS,
  CURRENT_SCHEMA_VERSION,
  schemaForConsent,
  schemaRank,
} = require("../protocol/protocol.cjs");
const SESSION_MS = 15 * 60 * 1000;
const { readSnapshot } = require("./database");
const { emptyInventory, addInventory } = require("./inventory");
const PAGE_SIZE = 200;

class Collector {
  constructor(db, options = {}) {
    this.db = db;
    this.now = options.now || (() => Date.now());
    this.maxInstallations = options.maxInstallations ?? 100000;
    this.dailyRegistrations = options.dailyRegistrations ?? 1000;
    this.dailyUnknownDeletions = options.dailyUnknownDeletions ?? 1000;
    this.sessionSecret =
      options.sessionSecret ||
      process.env.SESSION_SECRET ||
      process.env.MAINTAINER_TOKEN;
    this.summaryLoads = new Map();
  }
  bool(value) {
    return this.db.client.config.client === "pg"
      ? Boolean(value)
      : Number(Boolean(value));
  }

  async receive(envelope) {
    const now = this.now();
    const packet = verifyReceivedEnvelope(envelope, now);
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
          await this.pruneExpired(tx, now);
          if (packet.action === "delete") {
            // Possession proof is sufficient for deletion, including when a
            // restored backup has a stale sequence or a previous receipt was lost.
            const registered = await tx("installations").where({ id }).first();
            const revoked = await tx("revocations")
              .where({ identity_digest: digest(id) })
              .first();
            const contributed =
              registered &&
              ((await tx("reports")
                .where({ installation_id: id })
                .first("packet_id")) ||
                (await tx("snapshots")
                  .where({ installation_id: id })
                  .first("installation_id")));
            // A lost activation receipt must remain safely cancellable. Bound
            // NEW unknown identities, never deny a registered user's opt-out
            // or a retry for an existing tombstone because a quota is full.
            if (!registered && !revoked)
              await this.globalQuota(
                tx,
                "unknown_deletion",
                this.dailyUnknownDeletions,
                now,
              );
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
            if (contributed) await this.bumpRevision(tx);
            return {
              ...receipt,
              status: "deleted",
              deletion_receipt: {
                receipt_version: "deletion.v1",
                receipt_id: crypto.randomUUID(),
                confirmed_at: new Date(now).toISOString(),
                status: "deleted",
                scope: [
                  "reports",
                  "snapshots",
                  "feedback",
                  "votes",
                  "sessions",
                  "operations",
                  "registration",
                ],
                retained:
                  "one-way revocation digest; identity-free daily abuse counters",
              },
            };
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
            const priorReceipt = JSON.parse(previous.receipt);
            if (packet.action === "session")
              return this.sessionReceipt(tx, priorReceipt);
            return priorReceipt;
          }
          if (packet.action === "register") {
            if (installation) throw new ProtocolError("IDENTITY_CONFLICT", 409);
            if (packet.sequence !== 0)
              throw new ProtocolError("SEQUENCE_CONFLICT", 409);
            const [{ count }] = await tx("installations").count("* as count");
            if (Number(count) >= this.maxInstallations)
              throw new ProtocolError("REGISTRATION_LIMIT", 429);
            await this.globalQuota(
              tx,
              "registration",
              this.dailyRegistrations,
              now,
            );
            await tx("installations").insert({
              id,
              public_key: envelope.public_key,
              sequence: 0,
              consent_version: packet.payload.consent_version,
            });
            await this.bumpRevision(tx);
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
            if (schemaRank(packet.schema_version) > schemaRank(schemaForConsent(installation.consent_version)))
              throw new ProtocolError("CONSENT_REQUIRED", 409);
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
                  projection: JSON.stringify({ schema_version: packet.schema_version, ...packet.payload }),
                })
                .onConflict("installation_id")
                .merge();
            }
            await this.bumpRevision(tx);
          }
          if (packet.action === "consent") {
            if (schemaRank(packet.schema_version) <= schemaRank(schemaForConsent(installation.consent_version)))
              throw new ProtocolError("CONSENT_ALREADY_CURRENT", 409);
            await this.checkQuota(tx, id, "consent", 1, now);
            await tx("installations").where({ id }).update({
              consent_version: packet.payload.consent_version,
            });
            await this.bumpRevision(tx);
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
            receipt.expires_at = new Date(now + SESSION_MS).toISOString();
            const token = this.sessionToken(receipt);
            await tx("sessions").insert({
              token_hash: digest(token),
              installation_id: id,
              expires_at: now + SESSION_MS,
            });
          }
          await tx("operations").insert({
            packet_id: packet.packet_id,
            installation_id: id,
            action: packet.action,
            packet_digest: packetDigest,
            receipt: JSON.stringify(receipt),
            day: new Date(now).toISOString().slice(0, 10),
          });
          return packet.action === "session"
            ? this.sessionReceipt(tx, receipt)
            : receipt;
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

  // Idempotent session receipts without storing a recoverable bearer secret in
  // the database. All replicas use the same server-side key. Rotation makes a
  // retry require a new session; existing tokens still expire within 15 min.
  sessionToken(receipt) {
    if (
      typeof this.sessionSecret !== "string" ||
      this.sessionSecret.length < 32
    )
      throw new ProtocolError("SESSION_NOT_CONFIGURED", 503);
    return `ppus_${crypto
      .createHmac("sha256", this.sessionSecret)
      .update("picpeak-usage/session/v1\0")
      .update(
        canonical({
          packet_id: receipt.packet_id,
          installation_id: receipt.installation_id,
          expires_at: receipt.expires_at,
        }),
      )
      .digest("hex")}`;
  }

  async sessionReceipt(tx, receipt) {
    if (receipt.session_expired || Date.parse(receipt.expires_at) <= this.now())
      return { ...receipt, session_expired: true };
    const token = this.sessionToken(receipt);
    const live = await tx("sessions")
      .where({ token_hash: digest(token) })
      .where("expires_at", ">", this.now())
      .first();
    return live
      ? { ...receipt, session_token: token }
      : { ...receipt, session_expired: true };
  }

  async globalQuota(tx, kind, limit, now) {
    const day = new Date(now).toISOString().slice(0, 10);
    await tx("abuse_budgets")
      .insert({ kind, day, used: 0 })
      .onConflict(["kind", "day"])
      .ignore();
    const updated = await tx("abuse_budgets")
      .where({ kind, day })
      .where("used", "<", limit)
      .increment("used", 1);
    if (updated !== 1)
      throw new ProtocolError(
        kind === "registration"
          ? "REGISTRATION_LIMIT"
          : "DELETION_ADMISSION_LIMIT",
        429,
      );
  }

  async pruneExpired(db = this.db, now = this.now()) {
    await db("nonces").where("expires_at", "<=", now).delete();
    await db("sessions").where("expires_at", "<=", now).delete();
    await db("abuse_budgets")
      .where("day", "<", new Date(now - 86400000).toISOString().slice(0, 10))
      .delete();
  }

  async bumpRevision(tx) {
    await tx("collector_meta").where({ id: 1 }).increment("revision", 1);
  }
  async revision(db = this.db) {
    return String(
      (await db("collector_meta").where({ id: 1 }).first()).revision,
    );
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

  async requireInstallation(id, db = this.db) {
    if (
      typeof id !== "string" ||
      !/^[a-f0-9]{64}$/.test(id) ||
      !(await db("installations").where({ id }).first())
    )
      throw new ProtocolError("INSTALLATION_NOT_FOUND", 404);
  }

  rawPacket(row) {
    const envelope = JSON.parse(row.raw);
    return {
      // Some clients inspect packet.action directly when counting exported
      // reports. Preserve the full original envelope and expose its packet
      // alongside the receipt metadata as a backwards-compatible alias.
      packet: envelope.packet,
      envelope,
      received_at: row.received_at,
      signature_verified: true,
    };
  }

  async rawPage(id, after = "", db = this.db) {
    return db("reports")
      .where({ installation_id: id })
      .where("report_date", ">", after)
      .orderBy("report_date")
      .limit(PAGE_SIZE);
  }

  async packetPage(id, after = "", expectedRevision) {
    return readSnapshot(this.db, async (tx) => {
      await this.requireInstallation(id, tx);
      const revision = await this.revision(tx);
      if (after && expectedRevision !== revision)
        throw new ProtocolError("DATASET_CHANGED", 409);
      const rows = await this.rawPage(id, after, tx);
      return {
        installation_id: id,
        packets: rows.map((row) => this.rawPacket(row)),
        revision,
        next: rows.length === PAGE_SIZE ? rows.at(-1).report_date : null,
      };
    });
  }

  // Internal convenience for tests/small callers. HTTP exports use rawPage
  // under a read snapshot, never materialize an installation's whole history.
  async lookup(id) {
    await this.requireInstallation(id);
    const rows = await this.db("reports")
      .where({ installation_id: id })
      .orderBy("report_date", "asc");
    return {
      installation_id: id,
      packets: rows.map((row) => this.rawPacket(row)),
    };
  }

  // Read access to aggregate data: the private lookup hash of a registered
  // installation or a live voting session. Neither can vote, report or delete.
  async reader(credential, db = this.db) {
    if (/^[a-f0-9]{64}$/.test(credential || "")) {
      const installation = await db("installations")
        .where({ id: credential })
        .first();
      if (!installation)
        throw new ProtocolError("PARTICIPANT_AUTH_REQUIRED", 401);
      return installation.id;
    }
    return this.participant(credential, db);
  }

  async participant(token, db = this.db) {
    return (await this.participantSession(token, db)).installation_id;
  }

  async participantSession(token, db = this.db) {
    if (!/^ppus_[a-f0-9]{64}$/.test(token || ""))
      throw new ProtocolError("PARTICIPANT_AUTH_REQUIRED", 401);
    const session = await db("sessions")
      .where({ token_hash: digest(token) })
      .where("expires_at", ">", this.now())
      .first("installation_id", "expires_at");
    if (!session) throw new ProtocolError("PARTICIPANT_AUTH_REQUIRED", 401);
    return session;
  }

  async publicFeedback(
    kind = "feature_request",
    participantId = null,
    options = {},
  ) {
    const query = this.db("feedback")
      .where({
        kind,
        published: this.bool(true),
        allow_public: this.bool(true),
      })
      .orderBy("id")
      .where("id", ">", options.after || "")
      .limit(PAGE_SIZE);
    if (options.marketing) query.where({ allow_marketing: this.bool(true) });
    const rows = await query;
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const counts = await this.db("votes")
      .whereIn("feedback_id", ids)
      .select("feedback_id")
      .count("* as count")
      .groupBy("feedback_id");
    const own = participantId
      ? await this.db("votes")
          .where({ installation_id: participantId })
          .whereIn("feedback_id", ids)
          .pluck("feedback_id")
      : [];
    const votes = new Map(counts.map((r) => [r.feedback_id, Number(r.count)]));
    return rows.map(({ id, title, body, name, status, created_at }) => ({
      id,
      title,
      body,
      name,
      status,
      created_at,
      votes: votes.get(id) || 0,
      voted: own.includes(id),
    }));
  }

  async summary() {
    // Cheap shared revision check on EVERY read, including cache hits. A
    // committed deletion on any replica invalidates all other replicas too.
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = await this.revision();
      if (this.summaryCache?.revision === revision)
        return this.summaryCache.value;
      let pending = this.summaryLoads.get(revision);
      if (!pending) {
        pending = readSnapshot(this.db, async (tx) => ({
          revision: await this.revision(tx),
          value: await this.computeSummary(tx),
        }));
        this.summaryLoads.set(revision, pending);
      }
      let computed;
      try {
        computed = await pending;
      } finally {
        if (this.summaryLoads.get(revision) === pending)
          this.summaryLoads.delete(revision);
      }
      // Never repopulate the cache with an old in-flight computation after an
      // opt-out. Bound retries under sustained concurrent writes.
      if ((await this.revision()) !== computed.revision) continue;
      this.summaryCache = computed;
      return computed.value;
    }
    throw new ProtocolError("DATASET_BUSY", 503);
  }

  async computeSummary(db = this.db) {
    const inventory = emptyInventory();
    const versions = {};
    const layouts = {};
    const schemaVersions = {};
    const features = Object.fromEntries(
      ALL_FEATURE_KEYS.map((key) => [key, { configured: 0, used: 0, reported: 0, used_reported: 0 }]),
    );
    let after = "";
    let installations = 0;
    let versionsReported = 0, layoutsReported = 0;
    for (;;) {
      const rows = await db("snapshots")
        .select("installation_id", "projection")
        .where("installation_id", ">", after)
        .orderBy("installation_id")
        .limit(PAGE_SIZE);
      if (!rows.length) break;
      installations += rows.length;
      for (const row of rows) {
        const report = JSON.parse(row.projection);
        addInventory(inventory, report);
        const schemaVersion = report.schema_version || "usage.v1";
        schemaVersions[schemaVersion] = (schemaVersions[schemaVersion] || 0) + 1;
        if (typeof report.picpeak_version === "string") {
          versions[report.picpeak_version] = (versions[report.picpeak_version] || 0) + 1;
          versionsReported++;
        }
        for (const key of ALL_FEATURE_KEYS) {
          const signal = report.features?.[key];
          // An older schema did not ask this question. Absence is NOT false.
          if (typeof signal?.configured === "boolean") {
            features[key].configured += Number(signal.configured);
            features[key].reported++;
          }
          if (typeof signal?.used === "boolean") {
            features[key].used += Number(signal.used);
            features[key].used_reported++;
          }
        }
        if (Array.isArray(report.gallery_layouts)) layoutsReported++;
        for (const layout of report.gallery_layouts || [])
          layouts[layout] = (layouts[layout] || 0) + 1;
      }
      after = rows.at(-1).installation_id;
    }
    const history = await db("reports")
      .select("report_date")
      .count("* as reports")
      .groupBy("report_date")
      .orderBy("report_date", "asc");
    return {
      schema_version: CURRENT_SCHEMA_VERSION,
      inventory,
      schema_versions: schemaVersions,
      installations,
      features,
      versions,
      layouts,
      versions_reported: versionsReported,
      layouts_reported: layoutsReported,
      history: history.map((r) => ({
        date: r.report_date,
        reports: Number(r.reports),
      })),
    };
  }

  async dataset(offset = 0, limit = PAGE_SIZE, db = this.db) {
    const rows = await db("snapshots")
      .select("projection")
      .orderBy("installation_id")
      .offset(offset)
      .limit(limit + 1);
    return {
      records: rows.slice(0, limit).map((r) => ({ schema_version: "usage.v1", ...JSON.parse(r.projection) })),
      next: rows.length > limit ? offset + limit : null,
    };
  }

  async datasetPage(offset = 0, expectedRevision) {
    return readSnapshot(this.db, async (tx) => {
      const revision = await this.revision(tx);
      if (offset && expectedRevision !== revision)
        throw new ProtocolError("DATASET_CHANGED", 409);
      return { ...(await this.dataset(offset, PAGE_SIZE, tx)), revision };
    });
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
