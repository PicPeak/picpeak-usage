"use strict";
const knex = require("knex");
const fs = require("node:fs");
const path = require("node:path");

function createDatabase(env = process.env) {
  if (env.DATABASE_URL)
    return knex({
      client: "pg",
      connection: env.DATABASE_URL,
      pool: { min: 0, max: 10 },
    });
  const filename =
    env.DATABASE_PATH || path.join(process.cwd(), "storage", "usage.sqlite");
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  return knex({
    client: "sqlite3",
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate(connection, done) {
        connection.run("PRAGMA foreign_keys = ON", (error) =>
          done(error, connection),
        );
      },
    },
  });
}

async function migrate(db) {
  if (!(await db.schema.hasTable("installations")))
    await db.schema.createTable("installations", (t) => {
      t.string("id", 64).primary();
      t.string("public_key", 59).notNullable();
      t.bigInteger("sequence").notNullable().defaultTo(0);
      t.timestamp("created_at").notNullable().defaultTo(db.fn.now());
    });
  // Old registrations keep their original consent. No migration silently
  // authorizes the larger v2 feature allowlist.
  if (!(await db.schema.hasColumn("installations", "consent_version")))
    await db.schema.alterTable("installations", (t) => {
      t.string("consent_version", 40).notNullable().defaultTo("usage-consent.v1");
    });
  if (!(await db.schema.hasTable("operations")))
    await db.schema.createTable("operations", (t) => {
      t.string("packet_id", 36).primary();
      t.string("installation_id", 64)
        .notNullable()
        .references("id")
        .inTable("installations")
        .onDelete("CASCADE");
      t.string("action", 20).notNullable();
      t.string("packet_digest", 64).notNullable();
      t.text("receipt").notNullable();
      t.string("day", 10).notNullable();
      t.index(["installation_id", "action", "day"]);
    });
  if (!(await db.schema.hasTable("nonces")))
    await db.schema.createTable("nonces", (t) => {
      t.string("nonce", 36).primary();
      t.string("installation_id", 64)
        .notNullable()
        .references("id")
        .inTable("installations")
        .onDelete("CASCADE");
      t.bigInteger("expires_at").notNullable().index();
    });
  if (!(await db.schema.hasTable("reports")))
    await db.schema.createTable("reports", (t) => {
      t.string("packet_id", 36).primary();
      t.string("installation_id", 64)
        .notNullable()
        .references("id")
        .inTable("installations")
        .onDelete("CASCADE");
      t.string("report_date", 10).notNullable();
      t.text("raw").notNullable();
      t.string("received_at", 24).notNullable();
      t.unique(["installation_id", "report_date"]);
      t.index("report_date");
    });
  if (!(await db.schema.hasTable("snapshots")))
    await db.schema.createTable("snapshots", (t) => {
      t.string("installation_id", 64)
        .primary()
        .references("id")
        .inTable("installations")
        .onDelete("CASCADE");
      t.string("report_date", 10).notNullable();
      t.text("projection").notNullable();
    });
  if (!(await db.schema.hasTable("feedback")))
    await db.schema.createTable("feedback", (t) => {
      t.string("id", 36).primary();
      t.string("installation_id", 64)
        .notNullable()
        .references("id")
        .inTable("installations")
        .onDelete("CASCADE");
      t.string("kind", 20).notNullable();
      t.string("title", 120).notNullable();
      t.text("body").notNullable();
      t.string("name", 80).notNullable().defaultTo("");
      t.boolean("allow_public").notNullable().defaultTo(false);
      t.boolean("allow_marketing").notNullable().defaultTo(false);
      t.boolean("published").notNullable().defaultTo(false);
      t.string("status", 20).notNullable().defaultTo("open");
      t.string("created_at", 24).notNullable();
    });
  if (!(await db.schema.hasTable("votes")))
    await db.schema.createTable("votes", (t) => {
      t.string("installation_id", 64)
        .notNullable()
        .references("id")
        .inTable("installations")
        .onDelete("CASCADE");
      t.string("feedback_id", 36)
        .notNullable()
        .references("id")
        .inTable("feedback")
        .onDelete("CASCADE");
      t.primary(["installation_id", "feedback_id"]);
    });
  if (!(await db.schema.hasTable("sessions")))
    await db.schema.createTable("sessions", (t) => {
      t.string("token_hash", 64).primary();
      t.string("installation_id", 64)
        .notNullable()
        .references("id")
        .inTable("installations")
        .onDelete("CASCADE");
      t.bigInteger("expires_at").notNullable().index();
    });
  if (!(await db.schema.hasTable("revocations")))
    await db.schema.createTable("revocations", (t) => {
      // A one-way digest only: prevents replayed registration resurrecting a
      // deleted identity. No public key, packet, feedback, or lookup access.
      t.string("identity_digest", 64).primary();
    });

  if (!(await db.schema.hasTable("abuse_budgets"))) {
    await db.schema.createTable("abuse_budgets", (t) => {
      // Global counters, deliberately unrelated to an installation or address.
      t.string("kind", 32).notNullable();
      t.string("day", 10).notNullable();
      t.integer("used").notNullable().defaultTo(0);
      t.primary(["kind", "day"]);
    });
    // Preserve the still-observable registration budget during an upgrade.
    const previousDay = new Date(Date.now() - 86400000)
      .toISOString()
      .slice(0, 10);
    const days = await db("operations")
      .where({ action: "register" })
      .where("day", ">=", previousDay)
      .select("day")
      .count("* as used")
      .groupBy("day");
    for (const row of days)
      await db("abuse_budgets")
        .insert({ kind: "registration", day: row.day, used: Number(row.used) })
        .onConflict(["kind", "day"])
        .ignore();
  }
  if (!(await db.schema.hasTable("collector_meta")))
    await db.schema.createTable("collector_meta", (t) => {
      t.integer("id").primary();
      t.bigInteger("revision").notNullable().defaultTo(0);
      t.integer("hardening_version").notNullable().defaultTo(0);
    });
  await db("collector_meta").insert({ id: 1 }).onConflict("id").ignore();
  const meta = await db("collector_meta").where({ id: 1 }).first();
  if (meta.hardening_version < 1) {
    await db.transaction(async (tx) => {
      // Old releases duplicated plaintext session tokens into operations.
      // Revoke old sessions once and scrub receipts; never reissue old tokens.
      await tx("sessions").delete();
      let after = "";
      for (;;) {
        const rows = await tx("operations")
          .where({ action: "session" })
          .where("packet_id", ">", after)
          .orderBy("packet_id")
          .limit(200);
        if (!rows.length) break;
        for (const row of rows) {
          const receipt = JSON.parse(row.receipt);
          delete receipt.session_token;
          receipt.session_expired = true;
          await tx("operations")
            .where({ packet_id: row.packet_id })
            .update({ receipt: JSON.stringify(receipt) });
        }
        after = rows.at(-1).packet_id;
      }
      await tx("collector_meta")
        .where({ id: 1 })
        .update({ hardening_version: 1 });
    });
  }
  if (meta.hardening_version < 2) {
    await db.transaction(async (tx) => {
      await tx.schema.alterTable("votes", (t) =>
        t.index("feedback_id", "votes_feedback_lookup"),
      );
      await tx.schema.alterTable("feedback", (t) => {
        t.index(
          ["kind", "published", "allow_public", "id"],
          "feedback_public_page",
        );
        t.index(
          ["kind", "published", "allow_public", "allow_marketing", "id"],
          "feedback_marketing_page",
        );
      });
      await tx("collector_meta")
        .where({ id: 1 })
        .update({ hardening_version: 2 });
    });
  }
  if (!(await db.schema.hasTable("weekly_report_meta")))
    await db.schema.createTable("weekly_report_meta", (t) => {
      t.integer("id").primary();
      t.string("tracking_since", 24).nullable();
      t.integer("schema_version").notNullable().defaultTo(0);
    });
  await db("weekly_report_meta").insert({ id: 1 }).onConflict("id").ignore();
  if (!(await db.schema.hasTable("weekly_activity")))
    await db.schema.createTable("weekly_activity", (t) => {
      // Aggregate operational counts only; never an installation identifier.
      t.string("day", 10).primary();
      t.integer("joined").notNullable().defaultTo(0);
      t.integer("removed").notNullable().defaultTo(0);
    });
  if (!(await db.schema.hasTable("weekly_recipients")))
    await db.schema.createTable("weekly_recipients", (t) => {
      t.string("id", 64).primary(); // SHA256 of a configured maintainer address
      t.string("period_end", 24).notNullable();
      t.integer("part").notNullable().defaultTo(1);
      t.string("lease_id", 36).nullable();
      t.bigInteger("lease_until").notNullable().defaultTo(0);
      t.bigInteger("next_attempt_at").notNullable().defaultTo(0);
      t.integer("failures").notNullable().defaultTo(0);
      t.string("last_error", 32).nullable();
      t.string("last_sent_at", 24).nullable();
    });
  if (!(await db.schema.hasTable("weekly_feedback_receipts")))
    await db.schema.createTable("weekly_feedback_receipts", (t) => {
      t.string("recipient_id", 64).notNullable()
        .references("id").inTable("weekly_recipients").onDelete("CASCADE");
      t.string("feedback_id", 36).notNullable()
        .references("id").inTable("feedback").onDelete("CASCADE");
      t.primary(["recipient_id", "feedback_id"]);
      t.index("feedback_id");
    });
  const weeklyMeta = await db("weekly_report_meta").where({ id: 1 }).first();
  if (weeklyMeta.schema_version < 1) {
    await db.transaction(async tx => {
      await tx.schema.alterTable("reports", t => t.index(["received_at", "installation_id", "report_date"], "reports_weekly_receipts"));
      await tx.schema.alterTable("feedback", t => t.index(["created_at", "id"], "feedback_weekly_received"));
      await tx("weekly_report_meta").where({ id: 1 }).update({ schema_version: 1 });
    });
  }
}

function readSnapshot(db, work) {
  return db.transaction(
    work,
    db.client.config.client === "pg"
      ? { isolationLevel: "repeatable read", readOnly: true }
      : undefined,
  );
}
module.exports = { createDatabase, migrate, readSnapshot };
