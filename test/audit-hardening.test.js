const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const request = require("supertest");
const knex = require("knex");
const { createDatabase, migrate } = require("../server/database");
const { createApp } = require("../server/app");
const p = require("../protocol/protocol.cjs");
const SECRET = "audit-regression-fixture-only-1234567890";

async function setup(t, engine, exportOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "usage-exports-test-"));
  let admin, schema, db;
  if (engine === "pg") {
    admin = createDatabase({ DATABASE_URL: process.env.TEST_DATABASE_URL });
    schema = `audit_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.schema.createSchema(schema);
    db = knex({ client: "pg", connection: process.env.TEST_DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 10 } });
  } else db = createDatabase({ DATABASE_PATH: ":memory:" });
  t.after(async () => {
    await db.destroy();
    if (admin) { await admin.schema.dropSchema(schema, true); await admin.destroy(); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await migrate(db);
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const app = createApp({ db, now: () => now, maintainerToken: SECRET, exportOptions: { directory, ...exportOptions } });
  const envelope = (id, action, sequence, payload = {}) => p.signPacket(p.makePacket(id, action, sequence, payload), id, new Date(now));
  const send = (id, action, sequence, payload) => request(app).post("/api/envelopes").send(envelope(id, action, sequence, payload));
  const register = async () => {
    const id = p.generateIdentity();
    await send(id, "register", 0, { consent_version: p.CURRENT_CONSENT_VERSION }).expect(200);
    return id;
  };
  const report = (date = "2026-09-08") => ({
    report_date: date, generated_at: `${date}T12:00:00.000Z`, picpeak_version: "3.46.10",
    gallery_layouts: ["grid"], inventory: { galleries: 2, photos: 10 }, features: p.emptyFeatures(),
  });
  return { db, app, directory, register, report, envelope, send };
}

async function populatedService(db, report) {
  // Model a populated service with valid-sized projections, without relying on
  // packet-limit bypasses or the test machine's TCP buffer size.
  const projection = JSON.stringify({ schema_version: p.CURRENT_SCHEMA_VERSION, ...report() });
  for (let offset = 0; offset < 4500; offset += 100) {
    const identities = Array.from({ length: 100 }, () => p.generateIdentity());
    await db.transaction(async tx => {
      await tx("installations").insert(identities.map(id => ({ id: id.installation_id, public_key: id.public_key })));
      await tx("snapshots").insert(identities.map(id => ({ installation_id: id.installation_id, report_date: "2026-09-08", projection })));
    });
  }
}

async function listen(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function pauseDownload(t, base, token) {
  const response = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/participant/export`, { headers: { Authorization: `Bearer ${token}` } }, res => {
      res.pause();
      resolve(res);
    });
    req.once("error", reject);
    t.after(() => req.destroy());
  });
  assert.equal(response.statusCode, 200);
  t.after(() => response.destroy());
  return response;
}

async function released(db) {
  for (let i = 0; i < 100 && db.client.pool.numUsed(); i++) await delay(10);
  assert.equal(db.client.pool.numUsed(), 0);
}

for (const engine of ["sqlite", ...(process.env.TEST_DATABASE_URL ? ["pg"] : [])]) {
  test(`${engine}: old report timestamps cannot poison another participant's all-time history`, async t => {
    const { db, app, register, report, envelope, send } = await setup(t, engine);
    const reader = await register(), sender = await register();
    await send(reader, "report", 1, report()).expect(200);
    for (const date of ["1970-01-01", "0000-01-01", "2019-12-31"]) {
      const rejected = await send(sender, "report", 1, report(date)).expect(400);
      assert.equal(rejected.body.error, "INVALID_REPORT_DATE");
    }
    assert.equal(Number((await db("installations").where({ id: sender.installation_id }).first()).sequence), 0);
    assert.equal((await db("nonces").where({ installation_id: sender.installation_id })).length, 1);
    assert.equal((await db("operations").where({ installation_id: sender.installation_id })).length, 1);
    // The fixed floor preserves delayed reports; it is not a rolling expiry.
    await send(sender, "report", 1, report("2020-01-01")).expect(200);
    const old = envelope(sender, "report", 2, report("1970-01-01"));
    await db("reports").insert({ packet_id: old.packet.packet_id, installation_id: sender.installation_id, report_date: "1970-01-01", raw: JSON.stringify(old), received_at: "2026-09-08T12:00:00.000Z" });
    const yearZero = envelope(sender, "report", 3, report("0000-01-01"));
    await db("reports").insert({ packet_id: yearZero.packet.packet_id, installation_id: sender.installation_id, report_date: "0000-01-01", raw: JSON.stringify(yearZero), received_at: "2026-09-08T12:00:00.000Z" });
    for (const [role, token] of [["participant", reader.installation_id], ["maintainer", SECRET]]) {
      const result = await request(app).post(`/api/${role}/history`).set("Authorization", `Bearer ${token}`)
        .send({ from: "all", interval: "month" }).expect(200);
      assert.equal(result.body.from, "2020-01-01");
      assert.equal(result.body.available.from, "2020-01-01");
      assert.equal(result.body.points.reduce((total, point) => total + point.reports, 0), 2);
    }
    await request(app).post("/api/participant/history").set("Authorization", `Bearer ${reader.installation_id}`)
      .send({ from: "0000-01-01", interval: "week" }).expect(400);
    // Historical evidence remains byte-for-byte available to its owner.
    const raw = await request(app).post("/api/participant/lookup").send({ installation_id: sender.installation_id }).expect(200);
    assert.deepEqual(raw.body.packets.find(row => row.packet.packet_id === old.packet.packet_id).envelope, old);
    assert.equal(raw.body.packets.length, 3);
  });

  test(`${engine}: paused exports release database connections and preserve reads and opt-out`, { timeout: 30000 }, async t => {
    const { db, app, directory, register, report, send } = await setup(t, engine);
    const a = await register(), b = await register(), victim = await register(), extra = await register();
    await populatedService(db, report);
    const base = await listen(t, app);
    const first = await pauseDownload(t, base, a.installation_id);
    await request(base).get("/api/health").timeout(3000).expect(200);
    await request(base).get("/api/participant/summary").set("Authorization", `Bearer ${b.installation_id}`).timeout(3000).expect(200);
    await send(victim, "delete", 0).timeout(3000).expect(200);
    await request(base).get("/api/participant/summary").set("Authorization", `Bearer ${victim.installation_id}`).timeout(3000).expect(401);
    await released(db);
    assert.equal(first.complete, false, "the download must still exceed client/network buffers");
    assert.deepEqual(await fs.readdir(directory), [], "private export data must have no pathname");
    const second = await pauseDownload(t, base, b.installation_id);
    const busy = await request(base).get("/api/participant/export").set("Authorization", `Bearer ${extra.installation_id}`).timeout(3000).expect(503);
    assert.equal(busy.body.error, "EXPORT_BUSY");
    const duplicate = await request(base).get("/api/participant/raw-export").set("Authorization", `Bearer ${a.installation_id}`).timeout(3000).expect(409);
    assert.equal(duplicate.body.error, "EXPORT_IN_PROGRESS");
    const session = await send(a, "session", 1).expect(200);
    await request(base).get("/api/participant/export").set("Authorization", `Bearer ${session.body.session_token}`).timeout(3000).expect(409);
    first.destroy(); second.destroy();
    // Closing a client releases admission as well as the anonymous file.
    for (let i = 0; ; i++) {
      const retry = await request(base).get("/api/participant/raw-export").set("Authorization", `Bearer ${a.installation_id}`).timeout(3000);
      if (retry.status === 200) break;
      assert.ok(i < 100 && [409, 503].includes(retry.status));
      await delay(10);
    }
    await released(db);
    assert.deepEqual(await fs.readdir(directory), []);
  });

  test(`${engine}: an oversized export fails atomically and releases its file, slot and snapshot`, async t => {
    const { db, app, directory, register, report, send } = await setup(t, engine, { maxBytes: 1024 });
    const id = await register();
    await send(id, "report", 1, report()).expect(200);
    const response = await request(app).get("/api/participant/export").set("Authorization", `Bearer ${id.installation_id}`).expect(413);
    assert.equal(response.body.error, "EXPORT_TOO_LARGE");
    assert.equal(response.headers["content-disposition"], undefined);
    await released(db);
    await db("snapshots").delete();
    await request(app).get("/api/participant/export").set("Authorization", `Bearer ${id.installation_id}`).expect(200);
    assert.deepEqual(await fs.readdir(directory), []);
  });
}

test("a timed-out download frees export admission and anonymous files", { timeout: 15000 }, async t => {
  const { db, app, directory, register, report } = await setup(t, "sqlite", { timeoutMs: 3000, maxConcurrent: 1 });
  const id = await register();
  await populatedService(db, report);
  const base = await listen(t, app);
  const response = await pauseDownload(t, base, id.installation_id);
  await request(base).get("/api/health").timeout(1000).expect(200);
  for (let i = 0; ; i++) {
    const result = await request(base).get("/api/participant/raw-export").set("Authorization", `Bearer ${id.installation_id}`).timeout(1000);
    if (result.status === 200) break;
    assert.equal(result.status, 409);
    assert.ok(i < 60, "the deadline must release admission");
    await delay(100);
  }
  assert.equal(response.complete, false);
  assert.deepEqual(await fs.readdir(directory), []);
  await released(db);
});
