const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const knex = require('knex');
const request = require('supertest');
const { createDatabase, migrate } = require('../server/database');
const { createApp } = require('../server/app');
const { history } = require('../server/history');
const p = require('../protocol/protocol.cjs');
const signedEnvelope = require('./helpers/signedEnvelope.cjs');
const hashes = {
  'usage.v1': 'cc8d0a865d21e36d2b24d23ca6aa8dd8d48000cb17aef83996786f70755bc922',
  'usage.v2': '159821cf45c1951016d33a4ed9ca55a0a7ee1b60dd715b803fcfed33e5c8a846',
  'usage.v3': '93214702c79f47823f154544ebad6612dd313604f69e60b86de4c0e4c904571a',
};

async function fixture(t, engine) {
  let db;
  if (engine === 'pg') {
    const admin = createDatabase({ DATABASE_URL: process.env.TEST_DATABASE_URL });
    const schema = `compat_${crypto.randomUUID().replaceAll('-', '')}`;
    await admin.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL, searchPath: [schema] });
    t.after(async () => { await db.destroy(); await admin.schema.dropSchema(schema, true); await admin.destroy(); });
  } else { db = createDatabase({ DATABASE_PATH: ':memory:' }); t.after(() => db.destroy()); }
  await migrate(db);
  const clock = { now: Date.parse('2026-09-06T12:00:00.000Z') };
  const app = createApp({ db, now: () => clock.now, disableRateLimit: true, maintainerToken: 'compat-test-maintainer-secret-1234567890' });
  const envelope = (id, action, sequence, payload, version = id.version) =>
    signedEnvelope(p.makePacket(id, action, sequence, payload, version), id, clock.now);
  const register = async (version) => {
    const id = { ...p.generateIdentity(), version };
    await request(app).post('/api/envelopes').send(envelope(id, 'register', 0, { consent_version: p.CONSENT_VERSIONS[version] })).expect(200);
    return id;
  };
  const report = (fields = {}, iso = new Date(clock.now).toISOString()) => ({ report_date: iso.slice(0, 10), generated_at: iso, ...fields });
  return { db, app, c: app.locals.collector, clock, envelope, register, report };
}

test('all writer schemas remain immutable while ingress accepts missing measurements', () => {
  for (const [version, hash] of Object.entries(hashes)) {
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(p.envelopeSchemas[version].properties)).digest('hex'), hash);
    const id = p.generateIdentity(), now = Date.parse('2026-09-06T12:00:00.000Z');
    const packet = p.makePacket(id, 'report', 1, { report_date: '2026-09-06', generated_at: new Date(now).toISOString() }, version);
    assert.throws(() => p.signPacket(packet, id, new Date(now)), { code: 'INVALID_PACKET' });
    const e = signedEnvelope(packet, id, now);
    assert.throws(() => p.verifyEnvelope(e, now), { code: 'INVALID_PACKET' });
    assert.deepEqual(p.verifyReceivedEnvelope(e, now), packet);
  }
});

for (const engine of ['sqlite', ...(process.env.TEST_DATABASE_URL ? ['pg'] : [])]) {
  test(`${engine}: partial v1/v2/v3 reports retain independent known values and original signed exports`, async t => {
    const { app, c, register, report, envelope } = await fixture(t, engine);
    const ids = [];
    for (const version of Object.keys(hashes)) {
      const id = await register(version); ids.push(id);
      const payload = report({ picpeak_version: '1.0.0', features: { crm: { configured: true }, face_recognition: { used: false }, backup: null },
        ...(version === 'usage.v3' ? { inventory: { galleries: 0, photos: null } } : {}) });
      const e = envelope(id, 'report', 1, payload);
      const before = JSON.stringify(e);
      const response = await request(app).post('/api/envelopes').send(e).expect(200);
      assert.equal(response.body.packet_digest, p.digest(p.canonical(e.packet)));
      assert.equal(JSON.stringify(e), before);
      assert.deepEqual((await c.lookup(id.installation_id)).packets[0].envelope, e);
      assert.deepEqual((await request(app).get(`/schema/ingress/${version}.json`).expect(200)).body, p.ingressEnvelopeSchemas[version]);
      assert.deepEqual((await request(app).get(`/schema/${version}.json`).expect(200)).body, p.envelopeSchemas[version]);
    }
    // A reporter without measurements is neither false nor zero.
    const missing = await register('usage.v1');
    await request(app).post('/api/envelopes').send(envelope(missing, 'report', 1, report())).expect(200);
    const nulls = await register('usage.v3');
    await request(app).post('/api/envelopes').send(envelope(nulls, 'report', 1,
      report({ picpeak_version: null, features: null, gallery_layouts: null, inventory: null }))).expect(200);
    const summary = await c.summary();
    assert.equal(summary.installations, 5);
    assert.deepEqual(summary.features.crm, { configured: 3, used: 0, reported: 3, used_reported: 0 });
    assert.deepEqual(summary.features.face_recognition, { configured: 0, used: 0, reported: 0, used_reported: 3 });
    assert.deepEqual(summary.inventory, { galleries: { total: 0, reported: 1 }, photos: { total: 0, reported: 0 } });
    assert.equal(summary.versions_reported, 3);
    assert.equal(summary.layouts_reported, 0);
    assert.deepEqual(summary.versions, { '1.0.0': 3 });
    assert.deepEqual(summary.layouts, {});
    const series = await history(c, { from: '2026-09-06', to: '2026-09-06' }, { credential: ids[0].installation_id });
    assert.deepEqual(series.points[0].features, summary.features);
    assert.deepEqual(series.points[0].inventory, summary.inventory);
    assert.equal(series.points[0].versions_reported, 3);
    assert.equal(series.points[0].layouts_reported, 0);
    const records = (await c.dataset()).records;
    assert.equal(records.filter(r => !Object.hasOwn(r, 'features')).length, 1);
    assert.equal(records.filter(r => r.features === null).length, 1);
    await request(app).post('/api/envelopes').send(envelope(ids[2], 'delete', 0, {})).expect(200);
    assert.equal((await c.summary()).inventory.galleries.reported, 0);
    assert.equal((await history(c, { from: '2026-09-06', to: '2026-09-06' }, { credential: ids[0].installation_id })).points[0].features.crm.reported, 2);
  });

  test(`${engine}: old delayed reports and freshly signed retries work without regressing the latest snapshot`, async t => {
    const { app, c, clock, register, report, envelope } = await fixture(t, engine);
    const id = await register('usage.v3');
    await request(app).post('/api/envelopes').send(envelope(id, 'report', 1,
      report({ features: { crm: { configured: true, used: true } }, inventory: { photos: 42 } }))).expect(200);
    const packet = envelope(id, 'report', 2, report({ picpeak_version: '1.0.0', features: { crm: { configured: false } } }, '2020-01-02T12:00:00.000Z'), 'usage.v1').packet;
    await request(app).post('/api/envelopes').send(signedEnvelope(packet, id, clock.now - p.MAX_AGE_MS - 1)).expect(401);
    const accepted = await request(app).post('/api/envelopes').send(signedEnvelope(packet, id, clock.now)).expect(200);
    const retry = await request(app).post('/api/envelopes').send(signedEnvelope(packet, id, clock.now)).expect(200);
    assert.deepEqual(retry.body, accepted.body);
    assert.equal((await c.summary()).inventory.photos.total, 42);
    const old = await history(c, { from: '2020-01-02', to: '2020-01-02' }, { credential: id.installation_id });
    assert.deepEqual(old.points[0].features.crm, { configured: 0, used: 0, reported: 1, used_reported: 0 });
    // A later, partial old-version report replaces the whole snapshot. Do not
    // silently forward-fill its missing fields with previously known values.
    clock.now += 86400000;
    await request(app).post('/api/envelopes').send(envelope(id, 'report', 3, report({ gallery_layouts: [] }), 'usage.v2')).expect(200);
    const summary = await c.summary();
    assert.equal(summary.inventory.photos.reported, 0);
    assert.equal(summary.features.crm.reported, 0);
    assert.equal(summary.layouts_reported, 1);
    assert.equal(summary.versions_reported, 0);
    const month = await history(c, { from: '2026-09-01', to: '2026-09-30', interval: 'month' }, { credential: id.installation_id });
    assert.equal(month.points[0].features.crm.reported, 0);
    assert.equal(month.points[0].reports, 2);
  });

  test(`${engine}: incomplete reports cannot bypass signatures, consent, schemas or privacy boundaries`, async t => {
    const { app, c, clock, register, report, envelope } = await fixture(t, engine);
    const id = await register('usage.v1');
    await request(app).post('/api/envelopes').send(envelope(id, 'report', 1, report(), 'usage.v3')).expect(409);
    for (const [version, mutate] of [
      ['usage.v1', r => { r.inventory = {}; }],
      ['usage.v1', r => { r.features = { video_uploads: { configured: true } }; }],
      ['usage.v3', r => { r.features = { gallery_folders: { used: null } }; }],
      ['usage.v3', r => { r.features = { crm: { configured: 'true' } }; }],
      ['usage.v3', r => { r.features = { crm: { count: 1 } }; }],
      ['usage.v3', r => { r.features = { face_recognition: { names: ['PRIVATE'] } }; }],
      ['usage.v3', r => { r.features = []; }],
      ['usage.v3', r => { r.gallery_layouts = ['PRIVATE']; }],
      ['usage.v3', r => { r.inventory = { photos: -1 }; }],
      ['usage.v3', r => { r.inventory = { photos: '12' }; }],
      ['usage.v3', r => { r.inventory = { photos: p.MAX_INVENTORY_COUNT + 1 }; }],
      ['usage.v3', r => { r.inventory = { per_gallery: {} }; }],
      ['usage.v3', r => { r.email = 'PRIVATE@example.test'; }],
      ['usage.v3', r => { delete r.report_date; }],
      ['usage.v3', r => { delete r.generated_at; }],
      ['usage.v3', r => { r.generated_at = '2026-09-07T12:00:00.000Z'; }],
      ['usage.v3', r => { r.picpeak_version = 'PRIVATE'; }],
    ]) {
      const payload = report(); mutate(payload);
      await request(app).post('/api/envelopes').send(envelope(id, 'report', 1, payload, version)).expect(400);
    }
    for (const version of ['usage.v0', 'usage.v4', '__proto__', 'constructor'])
      await request(app).post('/api/envelopes').send(envelope(id, 'report', 1, report(), version)).expect(400);
    const tampered = envelope(id, 'report', 1, report({ features: { crm: { used: true } } }));
    tampered.packet.payload.features.crm.used = false;
    await request(app).post('/api/envelopes').send(tampered).expect(401);
    const good = envelope(id, 'report', 1, report());
    await request(app).post('/api/envelopes').send(good).expect(200);
    await request(app).post('/api/envelopes').send(good).expect(409);
    for (const action of ['register', 'consent', 'feedback', 'vote'])
      assert.throws(() => p.verifyReceivedEnvelope(envelope(id, action, 2, {}, 'usage.v3'), clock.now), { code: 'INVALID_PACKET' });
    await request(app).post('/api/envelopes').send(envelope(id, 'delete', 0, {})).expect(200);
    await request(app).post('/api/envelopes').send(signedEnvelope(good.packet, id, clock.now)).expect(409);
    assert.equal((await c.summary()).installations, 0);
  });
}
