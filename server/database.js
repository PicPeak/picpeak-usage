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
}
module.exports = { createDatabase, migrate };
