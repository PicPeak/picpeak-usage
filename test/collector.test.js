const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");
const { createDatabase, migrate } = require("../server/database");
const { createApp } = require("../server/app");
const p = require("../protocol/protocol.cjs");
const ADMIN = "maintainer-test-key-only-not-a-real-secret-1234";

async function setup(t) {
  const db = createDatabase({ DATABASE_PATH: ":memory:" });
  await migrate(db);
  await migrate(db);
  t.after(() => db.destroy());
  const clock = { value: Date.parse("2026-09-05T12:00:00.000Z") };
  const app = createApp({
    db,
    now: () => clock.value,
    maintainerToken: ADMIN,
    disableRateLimit: true,
  });
  return { db, app, c: app.locals.collector, clock };
}
function report(now, features = {}) {
  const iso = new Date(now).toISOString();
  return {
    picpeak_version: "3.123.0-beta.0",
    report_date: iso.slice(0, 10),
    generated_at: iso,
    features: Object.fromEntries(
      p.FEATURE_KEYS.map((key) => [
        key,
        { ...p.emptyFeatures()[key], ...features[key] },
      ]),
    ),
    gallery_layouts: ["grid"],
  };
}
async function register(c, now) {
  const identity = p.generateIdentity();
  const packet = p.makePacket(identity, "register", 0, {
    consent_version: "usage-consent.v2",
  });
  const receipt = await c.receive(
    p.signPacket(packet, identity, new Date(now)),
  );
  return { identity, packet, receipt };
}
const send = (c, identity, action, sequence, payload, now) =>
  c.receive(
    p.signPacket(
      p.makePacket(identity, action, sequence, payload),
      identity,
      new Date(now),
    ),
  );
const rejects = (promise, code) =>
  assert.rejects(promise, (error) => error.code === code);

test("register, signed report, exact raw export, participant-only projections and idempotent re-signing", async (t) => {
  const { c, app, clock } = await setup(t);
  const { identity } = await register(c, clock.value);
  const packet = p.makePacket(
    identity,
    "report",
    1,
    report(clock.value, { crm: { configured: true, used: true } }),
  );
  const envelope = p.signPacket(packet, identity, new Date(clock.value));
  const receipt = await c.receive(envelope);
  assert.equal(receipt.packet_digest, p.digest(p.canonical(packet)));
  assert.deepEqual(
    await c.receive(p.signPacket(packet, identity, new Date(clock.value))),
    receipt,
  );
  await rejects(c.receive(envelope), "REPLAYED_NONCE");
  const raw = await c.lookup(identity.installation_id);
  assert.equal(raw.packets.length, 1);
  assert.deepEqual(raw.packets[0].envelope, envelope);
  assert.deepEqual(raw.packets[0].packet, envelope.packet);
  const summary = await c.summary();
  assert.equal(summary.installations, 1);
  assert.equal(summary.features.crm.used, 1);
  const publicData = await c.dataset();
  assert.equal(publicData.records.length, 1);
  assert.ok(!JSON.stringify(publicData).includes(identity.installation_id));
  assert.ok(!JSON.stringify(publicData).includes(identity.public_key));
  // Aggregates are never anonymous: no public route, 401 without proof.
  await request(app).get("/api/public/summary").expect(404);
  await request(app).get("/api/participant/summary").expect(401);
  await request(app)
    .get("/api/participant/summary")
    .set("Authorization", `Bearer ${"f".repeat(64)}`)
    .expect(401);
  const viaHash = await request(app)
    .get("/api/participant/summary")
    .set("Authorization", `Bearer ${identity.installation_id}`)
    .expect(200);
  assert.equal(viaHash.body.installations, 1);
  const ownExport = await request(app)
    .post("/api/participant/lookup")
    .send({ installation_id: identity.installation_id })
    .expect(200);
  assert.deepEqual(ownExport.body.packets[0].packet, envelope.packet);
  assert.deepEqual(ownExport.body.packets[0].envelope, envelope);
  const exported = await request(app)
    .get("/api/participant/export")
    .set("Authorization", `Bearer ${identity.installation_id}`)
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
  assert.equal(exported.body.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(exported.body.trim()), { schema_version: packet.schema_version, ...packet.payload });
});

test("reject tampering, unknown fields, forged ownership, stale signatures and duplicate identities", async (t) => {
  const { c, clock } = await setup(t);
  const { identity } = await register(c, clock.value);
  const packet = p.makePacket(identity, "report", 1, report(clock.value));
  const bad = p.signPacket(packet, identity, new Date(clock.value));
  bad.packet.payload.features.crm.used = true;
  await rejects(c.receive(bad), "INVALID_SIGNATURE");
  const unknown = p.signPacket(
    p.makePacket(identity, "report", 1, report(clock.value)),
    identity,
    new Date(clock.value),
  );
  unknown.packet.payload.photo_count = 10;
  await rejects(c.receive(unknown), "INVALID_PACKET");
  const stranger = p.generateIdentity();
  const forged = p.signPacket(
    p.makePacket(stranger, "delete", 0, {}),
    stranger,
    new Date(clock.value),
  );
  forged.packet.installation_id = identity.installation_id;
  await rejects(c.receive(forged), "IDENTITY_MISMATCH");
  await rejects(
    c.receive(p.signPacket(packet, identity, new Date(clock.value - 3600000))),
    "EXPIRED_SIGNATURE",
  );
  await rejects(
    send(
      c,
      identity,
      "register",
      0,
      { consent_version: "usage-consent.v2" },
      clock.value,
    ),
    "IDENTITY_CONFLICT",
  );
  assert.equal((await c.lookup(identity.installation_id)).packets.length, 0);
});

test("sequences detect diverged copies; same-day uniqueness and received-day quotas bound reports", async (t) => {
  const { c, clock } = await setup(t);
  const { identity } = await register(c, clock.value);
  await send(c, identity, "report", 1, report(clock.value), clock.value);
  await rejects(
    send(c, identity, "report", 1, report(clock.value), clock.value),
    "SEQUENCE_CONFLICT",
  );
  await rejects(
    send(c, identity, "report", 2, report(clock.value), clock.value),
    "DAILY_REPORT_LIMIT",
  );
  await send(
    c,
    identity,
    "report",
    2,
    report(clock.value - 86400000),
    clock.value,
  );
  await rejects(
    send(
      c,
      identity,
      "report",
      3,
      report(clock.value - 172800000),
      clock.value,
    ),
    "DAILY_ACTION_LIMIT",
  );
});

test("private feedback, explicit publication, maintainer-only moderation and participant-only voting", async (t) => {
  const { c, app, clock, db } = await setup(t);
  const { identity } = await register(c, clock.value);
  const privateId = crypto.randomUUID();
  const publicId = crypto.randomUUID();
  const feedback = {
    kind: "feature_request",
    title: "Better exports",
    body: "Please improve the export workflow.",
    name: "",
    allow_public: false,
    allow_marketing: false,
  };
  await send(
    c,
    identity,
    "feedback",
    1,
    { ...feedback, feedback_id: privateId },
    clock.value,
  );
  await send(
    c,
    identity,
    "feedback",
    2,
    { ...feedback, feedback_id: publicId, allow_public: true },
    clock.value,
  );
  assert.equal((await c.publicFeedback()).length, 0);
  await request(app).get("/api/maintainer/feedback").expect(401);
  await request(app)
    .get("/api/maintainer/feedback")
    .set("Authorization", `Bearer ${identity.installation_id}`)
    .expect(401);
  await rejects(
    c.moderate(privateId, { published: true, status: "planned" }),
    "PUBLICATION_NOT_AUTHORIZED",
  );
  await request(app)
    .patch(`/api/maintainer/feedback/${publicId}`)
    .set("Authorization", `Bearer ${ADMIN}`)
    .send({ published: true, status: "planned" })
    .expect(200);
  assert.equal((await c.publicFeedback()).length, 1);
  await request(app)
    .put(`/api/participant/votes/${publicId}`)
    .set("Authorization", `Bearer ${identity.installation_id}`)
    .send({ voted: true })
    .expect(401);
  const session = await send(c, identity, "session", 3, {}, clock.value);
  for (let i = 0; i < 2; i++)
    await request(app)
      .put(`/api/participant/votes/${publicId}`)
      .set("Authorization", `Bearer ${session.session_token}`)
      .send({ voted: true })
      .expect(200);
  assert.equal((await c.publicFeedback())[0].votes, 1);
  assert.equal((await db("votes")).length, 1);
  await request(app)
    .put(`/api/participant/votes/${privateId}`)
    .set("Authorization", `Bearer ${session.session_token}`)
    .send({ voted: true })
    .expect(404);
  clock.value += 16 * 60000;
  await request(app)
    .get("/api/participant/session")
    .set("Authorization", `Bearer ${session.session_token}`)
    .expect(401);
});

test("opt-out deletes raw and normalized data, private/public feedback, votes, and sessions; cannot resurrect", async (t) => {
  const { c, app, clock, db } = await setup(t);
  const { identity, packet: registration } = await register(c, clock.value);
  await send(c, identity, "report", 1, report(clock.value), clock.value);
  const id = crypto.randomUUID();
  await send(
    c,
    identity,
    "feedback",
    2,
    {
      feedback_id: id,
      kind: "testimonial",
      title: "Useful app",
      body: "This helps our events.",
      name: "Pat",
      allow_public: true,
      allow_marketing: true,
    },
    clock.value,
  );
  await c.moderate(id, { published: true, status: "open" });
  const session = await send(c, identity, "session", 3, {}, clock.value);
  const deletion = await send(c, identity, "delete", 0, {}, clock.value);
  assert.equal(deletion.status, "deleted");
  for (const table of [
    "installations",
    "reports",
    "snapshots",
    "operations",
    "nonces",
    "sessions",
    "feedback",
    "votes",
  ])
    assert.equal((await db(table)).length, 0, table);
  assert.equal((await db("revocations")).length, 1);
  await rejects(c.lookup(identity.installation_id), "INSTALLATION_NOT_FOUND");
  assert.equal((await c.summary()).installations, 0);
  await request(app)
    .get("/api/participant/session")
    .set("Authorization", `Bearer ${session.session_token}`)
    .expect(401);
  assert.equal(
    (await send(c, identity, "delete", 0, {}, clock.value)).status,
    "deleted",
    "lost deletion receipt is recoverable",
  );
  await rejects(
    c.receive(p.signPacket(registration, identity, new Date(clock.value))),
    "IDENTITY_REVOKED",
  );
  const next = await register(c, clock.value);
  assert.notEqual(next.identity.installation_id, identity.installation_id);
});

test("HTTP rejects oversize/invalid payloads and never echoes private input", async (t) => {
  const { app } = await setup(t);
  const response = await request(app)
    .post("/api/envelopes")
    .send({ email: "sensitive@example.test" })
    .expect(400);
  assert.ok(!JSON.stringify(response.body).includes("sensitive"));
  await request(app)
    .post("/api/envelopes")
    .send({ data: "x".repeat(18000) })
    .expect(413);
  await request(app).get("/schema/usage.v1.json").expect(200);
  await request(app).get("/api/health").expect(200);
});

test("stale participant requests cannot recreate votes after opt-out", async (t) => {
  const { c, app, clock, db } = await setup(t);
  const { identity: author } = await register(c, clock.value);
  const { identity: voter } = await register(c, clock.value);
  const id = crypto.randomUUID();
  await send(
    c,
    author,
    "feedback",
    1,
    {
      feedback_id: id,
      kind: "feature_request",
      title: "A public request",
      body: "Test deletion against another participant's request.",
      name: "",
      allow_public: true,
      allow_marketing: false,
    },
    clock.value,
  );
  await c.moderate(id, { published: true, status: "open" });
  const session = await send(c, voter, "session", 1, {}, clock.value);
  const staleId = await c.participant(session.session_token);
  await send(c, voter, "delete", 0, {}, clock.value);
  await request(app)
    .put(`/api/participant/votes/${id}`)
    .set("Authorization", `Bearer ${session.session_token}`)
    .send({ voted: true })
    .expect(401);
  await assert.rejects(
    db.transaction((tx) => c.setVote(tx, staleId, id, true)),
  );
  assert.equal((await db("votes")).length, 0);
  assert.equal((await c.publicFeedback())[0].votes, 0);
});

module.exports = { report };
