const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");
const knex = require("knex");
const { createDatabase, migrate } = require("../server/database");
const { createApp } = require("../server/app");
const p = require("../protocol/protocol.cjs");
const SECRET = "history-tests-only-maintainer-token-1234567890";

async function setup(t, engine) {
  let db;
  if (engine === "pg") {
    const admin = createDatabase({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const schema = `history_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.schema.createSchema(schema);
    db = knex({
      client: "pg",
      connection: process.env.TEST_DATABASE_URL,
      searchPath: [schema],
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
  const clock = { now: Date.parse("2026-08-30T12:00:00.000Z") };
  const app = createApp({
    db,
    maintainerToken: SECRET,
    now: () => clock.now,
    disableRateLimit: true,
  });
  const c = app.locals.collector;
  async function register(version = "usage.v2") {
    const identity = { ...p.generateIdentity(), version, sequence: 0 };
    await send(identity, "register", {
      consent_version:
        version === "usage.v1" ? "usage-consent.v1" : "usage-consent.v2",
    });
    return identity;
  }
  async function send(identity, action, payload = {}) {
    const packet = p.makePacket(
      identity,
      action,
      action === "delete" ? 0 : identity.sequence++,
      payload,
      identity.version,
    );
    const envelope = p.signPacket(packet, identity, new Date(clock.now));
    await c.receive(envelope);
    return envelope;
  }
  async function report(
    identity,
    date,
    configured,
    used,
    version = "3.1.0",
    layouts = ["grid"],
  ) {
    clock.now = Date.parse(`${date}T12:00:00.000Z`);
    return send(identity, "report", {
      picpeak_version: version,
      report_date: date,
      generated_at: new Date(clock.now).toISOString(),
      gallery_layouts: layouts,
      features: {
        ...p.emptyFeatures(identity.version),
        crm: { configured, used },
        ...(identity.version === "usage.v2"
          ? {
              video_uploads: { configured: true, used: true },
              gallery_guest_uploads: { configured: true },
            }
          : {}),
      },
    });
  }
  const history = (token, body, maintainer = false) =>
    request(app)
      .post(`/api/${maintainer ? "maintainer" : "participant"}/history`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  return { db, app, c, clock, register, send, report, history };
}
function parseText(res, done) {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    body += chunk;
  });
  res.on("end", () => done(null, body));
}

for (const engine of [
  "sqlite",
  ...(process.env.TEST_DATABASE_URL ? ["pg"] : []),
]) {
  test(`${engine}: all-reporter history deduplicates periods and preserves unknowns, gaps and UTC boundaries`, async (t) => {
    const { register, report, history } = await setup(t, engine);
    const a = await register(),
      b = await register("usage.v1");
    await report(a, "2026-08-30", true, true);
    await report(a, "2026-08-31", true, true);
    await report(b, "2026-08-31", false, false);
    await report(a, "2026-09-01", false, true, "3.2.0", ["masonry", "grid"]);
    const range = { from: "2026-08-30", to: "2026-09-03" };
    const daily = (await history(a.installation_id, range).expect(200)).body;
    assert.deepEqual(
      daily.points.map((v) => v.reporters),
      [1, 2, 1, 0, 0],
    );
    assert.deepEqual(daily.points[1].features.video_uploads, {
      configured: 1,
      used: 1,
      reported: 1,
      used_reported: 1,
    });
    assert.equal(
      daily.points[1].features.gallery_guest_uploads.used_reported,
      0,
    );
    assert.equal(daily.points[3].features.crm.reported, 0);
    const weekly = (
      await history(a.installation_id, { ...range, interval: "week" }).expect(
        200,
      )
    ).body;
    assert.deepEqual(
      weekly.points.map((v) => [v.date, v.reporters, v.reports]),
      [
        ["2026-08-24", 1, 1],
        ["2026-08-31", 2, 3],
      ],
    );
    assert.equal(weekly.points[0].from, "2026-08-30");
    assert.equal(weekly.points[1].to, "2026-09-03");
    assert.deepEqual(weekly.points[1].features.crm, {
      configured: 0,
      used: 1,
      reported: 2,
      used_reported: 2,
    });
    assert.deepEqual(weekly.points[1].versions, { "3.1.0": 1, "3.2.0": 1 });
    assert.deepEqual(weekly.points[1].layouts, { grid: 2, masonry: 1 });
    assert.deepEqual(weekly.points[1].schema_versions, {
      "usage.v1": 1,
      "usage.v2": 1,
    });
    const monthly = (
      await history(SECRET, { ...range, interval: "month" }, true).expect(200)
    ).body;
    assert.deepEqual(
      monthly.points.map((v) => [v.date, v.reporters, v.reports]),
      [
        ["2026-08-01", 2, 3],
        ["2026-09-01", 1, 1],
      ],
    );
    const own = (
      await history(b.installation_id, { ...range, scope: "own" }).expect(200)
    ).body;
    assert.deepEqual(
      own.points.map((v) => v.reporters),
      [0, 1, 0, 0, 0],
    );
    const selected = (
      await history(
        SECRET,
        { ...range, installation_id: b.installation_id },
        true,
      ).expect(200)
    ).body;
    assert.deepEqual(selected.points, own.points);
    for (const sensitive of [
      a.installation_id,
      b.installation_id,
      a.public_key,
      "signature",
      "packet_id",
    ])
      assert.ok(!JSON.stringify(daily).includes(sensitive), sensitive);
    const all = (
      await history(a.installation_id, {
        from: "all",
        interval: "month",
      }).expect(200)
    ).body;
    assert.equal(all.from, "2026-08-30");
    assert.equal(all.available.to, "2026-09-01");
  });

  test(`${engine}: maintainer data requires its own credential; participant scope cannot target another reporter`, async (t) => {
    const { app, register, history, send, clock } = await setup(t, engine);
    const identity = await register();
    for (const path of ["reporters", "history", "packets", "export"])
      for (const token of ["", identity.installation_id, "x".repeat(64)])
        await request(app)
          .post(`/api/maintainer/${path}`)
          .set("Authorization", `Bearer ${token}`)
          .send({})
          .expect(401);
    await request(app).get("/api/maintainer/summary").expect(401);
    await request(app)
      .get("/api/maintainer/summary")
      .set("Authorization", `Bearer ${SECRET}`)
      .expect(200);
    await history("", {}).expect(401);
    await history(SECRET, {}).expect(401);
    await history(identity.installation_id, {
      installation_id: "f".repeat(64),
    }).expect(400);
    for (const body of [
      { from: "2026-02-30" },
      { to: "nonsense" },
      { interval: "year" },
      { scope: "reporter" },
      { from: "2026-09-05", to: "2026-08-01" },
      { from: "2020-01-01", to: "2026-08-30" },
      { from: ["2026-08-01"] },
      [],
    ])
      await history(identity.installation_id, body).expect(400);
    // A live voting session is a participant reader too; expiry removes access.
    const envelope = await send(identity, "session");
    const receipt = await app.locals.collector.receive(
      p.signPacket(envelope.packet, identity, new Date(clock.now)),
    );
    await history(receipt.session_token, {}).expect(200);
    clock.now += 16 * 60000;
    await history(receipt.session_token, {}).expect(401);
  });

  test(`${engine}: maintainer can inspect/export every contribution and deletion removes history and access`, async (t) => {
    const { db, app, register, report, history, send } = await setup(t, engine);
    const a = await register(),
      b = await register();
    const original = await report(a, "2026-08-30", true, true);
    await report(b, "2026-08-30", false, false);
    const feedbackId = crypto.randomUUID();
    await send(a, "feedback", {
      feedback_id: feedbackId,
      kind: "feature_request",
      title: "Private title",
      body: "Private message",
      name: "Author",
      allow_public: false,
      allow_marketing: false,
    });
    // Stored votes and receipts are included independently of public visibility.
    await db("votes").insert({
      installation_id: b.installation_id,
      feedback_id: feedbackId,
    });
    const directory = (
      await request(app)
        .post("/api/maintainer/reporters")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({})
        .expect(200)
    ).body;
    assert.equal(directory.records.length, 2);
    assert.equal(
      directory.records.find((v) => v.id === a.installation_id).reports,
      1,
    );
    assert.equal(
      directory.records.find((v) => v.id === a.installation_id).public_key,
      a.public_key,
    );
    const packets = (
      await request(app)
        .post("/api/maintainer/packets")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ installation_id: a.installation_id })
        .expect(200)
    ).body;
    assert.deepEqual(packets.packets[0].envelope, original);
    const exported = await request(app)
      .post("/api/maintainer/export")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({})
      .buffer(true)
      .parse(parseText)
      .expect(200);
    assert.equal(exported.headers["cache-control"], "no-store");
    const records = exported.body.trim().split("\n").map(JSON.parse);
    for (const type of [
      "reporter",
      "snapshot",
      "report",
      "feedback",
      "vote",
      "operation",
    ])
      assert.ok(records.some((v) => v.type === type));
    assert.deepEqual(
      records.find(
        (v) =>
          v.type === "report" && v.data.installation_id === a.installation_id,
      ).data.envelope,
      original,
    );
    assert.equal(records.at(-1).data.counts.reporter, 2);
    assert.equal(
      records.find((v) => v.type === "feedback").data.body,
      "Private message",
    );
    assert.ok(!exported.body.includes("session_token"));
    assert.ok(!exported.body.includes(SECRET));
    const single = await request(app)
      .post("/api/maintainer/export")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({ installation_id: a.installation_id })
      .buffer(true)
      .parse(parseText)
      .expect(200);
    assert.ok(!single.body.includes(b.installation_id));
    await send(a, "delete");
    const remaining = (
      await history(b.installation_id, {
        from: "2026-08-30",
        to: "2026-08-30",
      }).expect(200)
    ).body;
    assert.equal(remaining.points[0].reporters, 1);
    assert.equal(remaining.points[0].features.crm.used, 0);
    await history(a.installation_id, {}).expect(401);
    await history(SECRET, { installation_id: a.installation_id }, true).expect(
      404,
    );
    await request(app)
      .post("/api/maintainer/packets")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({ installation_id: a.installation_id })
      .expect(404);
    const after = await request(app)
      .post("/api/maintainer/export")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({})
      .buffer(true)
      .parse(parseText)
      .expect(200);
    assert.ok(!after.body.includes(a.installation_id));
    assert.ok(!after.body.includes("Private message"));
  });

  test(`${engine}: directory, history and full export traverse more than 200 reporters without truncation`, async (t) => {
    const { db, c, app, register, report, history } = await setup(t, engine);
    const identity = await register();
    const original = await report(identity, "2026-08-30", true, true);
    // Synthetic retained rows exercise page boundaries without expensive signing.
    const ids = Array.from({ length: 205 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    await db.batchInsert(
      "installations",
      ids.map((id) => ({
        id,
        public_key: identity.public_key,
        consent_version: "usage-consent.v2",
      })),
      50,
    );
    await db.batchInsert(
      "reports",
      ids.map((id) => ({
        packet_id: crypto.randomUUID(),
        installation_id: id,
        report_date: "2026-08-30",
        received_at: "2026-08-30T12:00:00.000Z",
        raw: JSON.stringify(original),
      })),
      50,
    );
    await c.bumpRevision(db);
    const first = (
      await request(app)
        .post("/api/maintainer/reporters")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({})
        .expect(200)
    ).body;
    assert.equal(first.records.length, 200);
    const second = (
      await request(app)
        .post("/api/maintainer/reporters")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ after: first.next, revision: first.revision })
        .expect(200)
    ).body;
    assert.equal(second.records.length, 6);
    assert.equal(second.next, null);
    assert.equal(
      new Set([...first.records, ...second.records].map((v) => v.id)).size,
      206,
    );
    const daily = (
      await history(identity.installation_id, {
        from: "2026-08-30",
        to: "2026-08-30",
      }).expect(200)
    ).body;
    assert.equal(daily.points[0].reporters, 206);
    const exported = await request(app)
      .post("/api/maintainer/export")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({})
      .buffer(true)
      .parse(parseText)
      .expect(200);
    const rows = exported.body.trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter((v) => v.type === "reporter").length, 206);
    assert.equal(rows.filter((v) => v.type === "report").length, 206);
    await register();
    await request(app)
      .post("/api/maintainer/reporters")
      .set("Authorization", `Bearer ${SECRET}`)
      .send({ after: first.next, revision: first.revision })
      .expect(409);
  });
}
