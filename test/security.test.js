const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");
const knex = require("knex");
const { createDatabase, migrate } = require("../server/database");
const { Collector } = require("../server/collector");
const { createApp } = require("../server/app");
const p = require("../protocol/protocol.cjs");
const SECRET = "security-tests-only-session-secret-1234567890";

async function fixture(t, engine, options = {}) {
  let db;
  if (engine === "pg") {
    const admin = createDatabase({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const schema = `security_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.schema.createSchema(schema);
    db = knex({
      client: "pg",
      connection: process.env.TEST_DATABASE_URL,
      searchPath: [schema],
      pool: { min: 0, max: 10 },
    });
    t.after(async () => {
      await db.destroy();
      await admin.schema.dropSchema(schema, true);
      await admin.destroy();
    });
  } else {
    db = createDatabase({ DATABASE_PATH: ":memory:" });
    t.after(() => db.destroy());
  }
  await migrate(db);
  const clock = { now: Date.parse("2026-09-05T12:00:00.000Z") };
  const config = { now: () => clock.now, sessionSecret: SECRET, ...options };
  const app = createApp({
    db,
    maintainerToken: SECRET,
    disableRateLimit: true,
    ...config,
  });
  const c = app.locals.collector;
  const sign = (identity, packet) =>
    p.signPacket(packet, identity, new Date(clock.now));
  const send = (identity, action, sequence, payload = {}) =>
    c.receive(
      sign(identity, p.makePacket(identity, action, sequence, payload)),
    );
  const register = async () => {
    const identity = p.generateIdentity();
    await send(identity, "register", 0, {
      consent_version: "usage-consent.v2",
    });
    return identity;
  };
  const report = (version = "1.0.0") => ({
    picpeak_version: version,
    report_date: new Date(clock.now).toISOString().slice(0, 10),
    generated_at: new Date(clock.now).toISOString(),
    gallery_layouts: ["grid"],
    features: Object.fromEntries(
      Object.entries(p.emptyFeatures()),
    ),
  });
  return { db, c, app, clock, config, sign, send, register, report };
}

for (const engine of [
  "sqlite",
  ...(process.env.TEST_DATABASE_URL ? ["pg"] : []),
]) {
  test(`${engine}: S02 global registrations survive opt-out; unknown deletion growth is bounded`, async (t) => {
    const { db, c, clock, register, send } = await fixture(t, engine, {
      dailyRegistrations: 2,
      dailyUnknownDeletions: 2,
    });
    const first = await register();
    await send(first, "delete", 0);
    const second = await register();
    await assert.rejects(register(), { code: "REGISTRATION_LIMIT" });
    for (let i = 0; i < 2; i++) await send(p.generateIdentity(), "delete", 0);
    await assert.rejects(send(p.generateIdentity(), "delete", 0), {
      code: "DELETION_ADMISSION_LIMIT",
    });
    await send(second, "delete", 0); // Genuine opt-out still works at full admission budget.
    await send(first, "delete", 0); // Lost-receipt retry never consumes another admission.
    assert.equal((await db("revocations")).length, 4);
    assert.equal(
      Number(
        (await db("abuse_budgets").where({ kind: "registration" }).first())
          .used,
      ),
      2,
    );
    assert.equal((await db("operations")).length, 0);
    clock.now += 2 * 86400000;
    await register();
    assert.equal((await db("abuse_budgets")).length, 1);
    assert.equal(Number((await db("abuse_budgets").first()).used), 1);
    assert.ok(c);
  });

  test(`${engine}: S04 invalid envelopes cannot evict cache; concurrent reads share work`, async (t) => {
    const { db, c, config, register, send, report } = await fixture(t, engine);
    const identity = await register();
    await send(identity, "report", 1, report());
    let scans = 0;
    const original = c.computeSummary.bind(c);
    c.computeSummary = async (tx) => {
      scans++;
      return original(tx);
    };
    await Promise.all(Array.from({ length: 12 }, () => c.summary()));
    assert.equal(scans, 1);
    const revision = await c.revision();
    await assert.rejects(c.receive({ invalid: true }));
    await c.summary();
    assert.equal(scans, 1);
    assert.equal(await c.revision(), revision);
    const other = new Collector(db, config);
    assert.equal((await other.summary()).installations, 1);
    await send(identity, "delete", 0);
    assert.equal(
      (await other.summary()).installations,
      0,
      "S05: no 20-second stale replica window",
    );
    assert.equal((await c.summary()).installations, 0);
  });

  test(`${engine}: S06 no plaintext bearer in receipts; idempotent cross-replica retry and expiry`, async (t) => {
    const { db, c, config, sign, register, clock } = await fixture(t, engine);
    const identity = await register();
    const packet = p.makePacket(identity, "session", 1, {});
    const receipt = await c.receive(sign(identity, packet));
    assert.match(receipt.session_token, /^ppus_[a-f0-9]{64}$/);
    const stored = await db("operations")
      .where({ packet_id: packet.packet_id })
      .first();
    assert.equal(JSON.parse(stored.receipt).session_token, undefined);
    assert.ok(
      !JSON.stringify(await db("sessions")).includes(receipt.session_token),
    );
    const other = new Collector(db, config);
    assert.deepEqual(await other.receive(sign(identity, packet)), receipt);
    const rotated = new Collector(db, {
      ...config,
      sessionSecret: "rotated-" + SECRET,
    });
    assert.equal(
      (await rotated.receive(sign(identity, packet))).session_token,
      undefined,
    );
    clock.now += 16 * 60000;
    const expired = await c.receive(sign(identity, packet));
    assert.equal(expired.session_expired, true);
    assert.equal(expired.session_token, undefined);
    assert.equal((await db("sessions")).length, 0);
    assert.ok(
      !JSON.stringify(await db("operations")).includes(receipt.session_token),
    );
    await assert.rejects(c.participant(receipt.session_token));
  });

  test(`${engine}: migration scrubs legacy session receipts and retains registration budget`, async (t) => {
    const { db, c, register, send } = await fixture(t, engine);
    const identity = await register();
    const receipt = await send(identity, "session", 1);
    await db("operations")
      .where({ packet_id: receipt.packet_id })
      .update({ receipt: JSON.stringify(receipt) });
    await db("collector_meta")
      .where({ id: 1 })
      .update({ hardening_version: 0 });
    await db.schema.alterTable("votes", (t) =>
      t.dropIndex("feedback_id", "votes_feedback_lookup"),
    );
    await db.schema.alterTable("feedback", (t) => {
      t.dropIndex(
        ["kind", "published", "allow_public", "id"],
        "feedback_public_page",
      );
      t.dropIndex(
        ["kind", "published", "allow_public", "allow_marketing", "id"],
        "feedback_marketing_page",
      );
    });
    await db.schema.dropTable("abuse_budgets");
    // Registration backfill uses actual UTC days at upgrade.
    await db("operations")
      .where({ action: "register" })
      .update({ day: new Date().toISOString().slice(0, 10) });
    await migrate(db);
    await migrate(db);
    assert.equal((await db("sessions")).length, 0);
    assert.ok(
      !JSON.stringify(await db("operations")).includes(receipt.session_token),
    );
    assert.equal(
      Number(
        (await db("abuse_budgets").where({ kind: "registration" }).first())
          .used,
      ),
      1,
    );
    await assert.rejects(c.participant(receipt.session_token));
  });

  test(`${engine}: T05 marketing feed requires both consents and maintainer publication`, async (t) => {
    const { c, app, register, send } = await fixture(t, engine);
    const identity = await register();
    const ids = [];
    let sequence = 0;
    for (const [allowPublic, allowMarketing, publish] of [
      [true, false, true],
      [true, true, true],
      [true, true, false],
      [false, false, false],
    ]) {
      const id = crypto.randomUUID();
      ids.push(id);
      await send(identity, "feedback", ++sequence, {
        feedback_id: id,
        kind: "testimonial",
        title: "Synthetic",
        body: "Consent matrix",
        name: "",
        allow_public: allowPublic,
        allow_marketing: allowMarketing,
      });
      if (publish) await c.moderate(id, { published: true, status: "open" });
    }
    assert.equal(
      (await request(app).get("/api/public/testimonials").expect(200)).body
        .length,
      2,
    );
    const feed = (
      await request(app).get("/api/public/marketing-testimonials").expect(200)
    ).body;
    assert.deepEqual(
      feed.map((row) => row.id),
      [ids[1]],
    );
    assert.ok(
      feed.every(
        (row) => !("allow_marketing" in row) && !("installation_id" in row),
      ),
    );
  });

  test(`${engine}: T01 paginated reads detect revisions; full exports include every row`, async (t) => {
    const { db, c, app, register, report, send } = await fixture(t, engine);
    const reader = await register();
    const identities = Array.from({ length: 250 }, () =>
      p.generateIdentity(),
    ).sort((a, b) => a.installation_id.localeCompare(b.installation_id));
    await db.batchInsert(
      "installations",
      identities.map((i) => ({
        id: i.installation_id,
        public_key: i.public_key,
        sequence: 0,
      })),
      100,
    );
    await db.batchInsert(
      "snapshots",
      identities.map((i, n) => ({
        installation_id: i.installation_id,
        report_date: "2026-09-05",
        projection: JSON.stringify(report(`1.0.${n}`)),
      })),
      100,
    );
    await c.bumpRevision(db);
    const first = await c.datasetPage();
    assert.equal(first.records.length, 200);
    const original = c.dataset.bind(c);
    if (engine === "pg")
      c.dataset = async (offset, limit, tx) => {
        const page = await original(offset, limit, tx);
        if (!offset) await send(identities[0], "delete", 0);
        return page;
      };
    const response = await request(app)
      .get("/api/participant/export")
      .set("Authorization", `Bearer ${reader.installation_id}`)
      .buffer(true)
      .parse((res, done) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => done(null, body));
      })
      .expect(200);
    const lines = response.body.trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 250);
    assert.equal(new Set(lines.map((row) => row.picpeak_version)).size, 250);
    assert.ok(response.headers["x-dataset-revision"]);
    c.dataset = original;
    if (engine !== "pg") await send(identities[0], "delete", 0);
    await assert.rejects(c.datasetPage(first.next, first.revision), {
      code: "DATASET_CHANGED",
    });
    await request(app)
      .get(`/api/participant/dataset?offset=200&revision=${first.revision}`)
      .set("Authorization", `Bearer ${reader.installation_id}`)
      .expect(409);
  });

  test(`${engine}: raw exports stream all pages with receipt; preview and feedback are bounded`, async (t) => {
    const { db, c, app, register, report } = await fixture(t, engine);
    const identity = await register();
    const rows = Array.from({ length: 205 }, (_, n) => {
      const date = new Date(Date.UTC(2025, 0, n + 1)).toISOString();
      return {
        packet_id: crypto.randomUUID(),
        installation_id: identity.installation_id,
        report_date: date.slice(0, 10),
        raw: JSON.stringify({ packet: { payload: report() }, fixture: n }),
        received_at: date,
      };
    });
    await db.batchInsert("reports", rows, 100);
    const preview = await request(app)
      .post("/api/participant/packets")
      .send({ installation_id: identity.installation_id })
      .expect(200);
    assert.equal(preview.body.packets.length, 200);
    assert.ok(preview.body.next);
    const second = await request(app)
      .post("/api/participant/packets")
      .send({
        installation_id: identity.installation_id,
        after: preview.body.next,
        revision: preview.body.revision,
      })
      .expect(200);
    assert.equal(second.body.packets.length, 5);
    const exported = await request(app)
      .post("/api/participant/lookup")
      .send({ installation_id: identity.installation_id })
      .expect(200);
    assert.equal(exported.body.packets.length, 205);
    assert.equal(exported.body.export_receipt.packet_count, 205);
    assert.equal(
      exported.body.export_receipt.scope,
      "unique accepted usage reports",
    );
    const feedback = Array.from({ length: 205 }, () => ({
      id: crypto.randomUUID(),
      installation_id: identity.installation_id,
      kind: "feature_request",
      title: "Synthetic",
      body: "Pagination",
      name: "",
      allow_public: c.bool(true),
      allow_marketing: c.bool(false),
      published: c.bool(true),
      status: "open",
      created_at: new Date().toISOString(),
    }));
    await db.batchInsert("feedback", feedback, 50);
    const page = await request(app).get("/api/public/requests").expect(200);
    assert.equal(page.body.length, 200);
    const next = await request(app)
      .get(`/api/public/requests?after=${page.headers["x-next-cursor"]}`)
      .expect(200);
    assert.equal(next.body.length, 5);
    assert.equal(
      new Set([...page.body, ...next.body].map((row) => row.id)).size,
      205,
    );
    const inbox = await request(app)
      .get("/api/maintainer/feedback")
      .set("Authorization", `Bearer ${SECRET}`)
      .expect(200);
    assert.equal(inbox.body.length, 200);
    assert.ok(inbox.headers["x-next-cursor"]);
  });
}

test("S03: IPv6 clients share their /56 budget; mapped IPv4 addresses are normalized", async (t) => {
  const { db } = await fixture(t, "sqlite");
  const previous = process.env.TRUST_PROXY_HOPS;
  process.env.TRUST_PROXY_HOPS = "1";
  try {
    const app = createApp({ db });
    for (let n = 0; n < 120; n++)
      await request(app)
        .post("/api/envelopes")
        .set("X-Forwarded-For", "2001:db8:1234:5600::1")
        .send({ invalid: true })
        .expect(400);
    for (const ip of ["2001:db8:1234:5600::2", "2001:db8:1234:56ff::10"])
      await request(app)
        .post("/api/envelopes")
        .set("X-Forwarded-For", ip)
        .send({ invalid: true })
        .expect(429);
    await request(app)
      .post("/api/envelopes")
      .set("X-Forwarded-For", "2001:db8:1234:5700::1")
      .send({ invalid: true })
      .expect(400);
    const { ipKeyGenerator } = require("express-rate-limit");
    assert.equal(
      ipKeyGenerator("::ffff:192.0.2.4", 56),
      ipKeyGenerator("192.0.2.4", 56),
    );
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = previous;
  }
});

test(
  "PG S05: a late pre-deletion calculation cannot repopulate the cache",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { db, c, config, register, report, send } = await fixture(t, "pg");
    const identity = await register();
    await send(identity, "report", 1, report());
    const other = new Collector(db, config);
    let release, reached;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const ready = new Promise((resolve) => {
      reached = resolve;
    });
    const original = other.computeSummary.bind(other);
    let first = true;
    other.computeSummary = async (tx) => {
      const result = await original(tx);
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return result;
    };
    const pending = other.summary();
    await ready;
    await send(identity, "delete", 0);
    release();
    assert.equal((await pending).installations, 0);
    assert.equal((await other.summary()).installations, 0);
  },
);
