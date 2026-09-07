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

async function fixture(t, engine) {
  let db;
  if (engine === 'pg') {
    const admin = createDatabase({ DATABASE_URL: process.env.TEST_DATABASE_URL });
    const schema = `v4_${crypto.randomUUID().replaceAll('-', '')}`;
    await admin.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL, searchPath: [schema] });
    t.after(async () => { await db.destroy(); await admin.schema.dropSchema(schema, true); await admin.destroy(); });
  } else {
    db = createDatabase({ DATABASE_PATH: ':memory:' });
    t.after(() => db.destroy());
  }
  await migrate(db);
  const clock = { now: Date.parse('2026-09-06T12:00:00.000Z') };
  const app = createApp({ db, now: () => clock.now, disableRateLimit: true });
  const c = app.locals.collector;
  const envelope = (id, action, payload, version = id.version) =>
    signedEnvelope(p.makePacket(id, action, id.sequence + 1, payload, version), id, clock.now);
  async function send(id, action, payload, version = id.version) {
    const e = envelope(id, action, payload, version);
    const receipt = await c.receive(e);
    id.sequence = e.packet.sequence;
    return { e, receipt };
  }
  async function register(version) {
    const id = { ...p.generateIdentity(), version, sequence: -1 };
    await send(id, 'register', { consent_version: p.CONSENT_VERSIONS[version] });
    return id;
  }
  const report = (features) => ({ report_date: new Date(clock.now).toISOString().slice(0, 10),
    generated_at: new Date(clock.now).toISOString(), features });
  return { app, c, clock, envelope, send, register, report };
}

test('v1/v2/v3 ingress schemas remain immutable; v4 has a separate closed catalog within the size limit', () => {
  for (const [v, hash] of Object.entries({
    'usage.v1': 'c002229149d684a68550fabbc3c88586494559de46d4073b1cf40c955ecfbdf6',
    'usage.v2': '0e3e252db3b54ee531c0d3cc76118f2340f438af9a0ccdd147601bde4af77707',
    'usage.v3': 'ff45d1bef3da82f1eef7eb9b07ba231a1f077d914da4db0165bc063d945a79fb',
  })) assert.equal(crypto.createHash('sha256').update(JSON.stringify(p.ingressEnvelopeSchemas[v])).digest('hex'), hash);
  assert.equal(p.featureKeysFor("usage.v4").length, 86);
  assert.equal(p.ALL_FEATURE_KEYS.length, 94);
  assert.ok(!p.FEATURE_KEYS.includes('gallery_downloads'));
  assert.ok(p.ALL_FEATURE_KEYS.includes('gallery_downloads'));
  assert.equal(p.CATALOG.features.gallery_downloads_restricted.since, 'usage.v4');
  assert.equal(p.CATALOG.features.gallery_downloads_restricted.used, null);
  const id = p.generateIdentity(), date = new Date('2026-09-06T12:00:00.000Z');
  const packet = p.makePacket(id, 'report', 1, {
    picpeak_version: '3.126.2-beta.0', generated_at: date.toISOString(), report_date: '2026-09-06',
    gallery_layouts: p.LAYOUTS, features: p.emptyFeatures(),
    inventory: { galleries: p.MAX_INVENTORY_COUNT, photos: p.MAX_INVENTORY_COUNT },
  });
  const e = p.signPacket(packet, id, date);
  assert.ok(Buffer.byteLength(JSON.stringify(e)) < p.MAX_BYTES);
  assert.deepEqual(p.verifyEnvelope(e, date.getTime()), packet);
});

for (const engine of ['sqlite', ...(process.env.TEST_DATABASE_URL ? ['pg'] : [])]) {
  test(`${engine}: v4 requires new consent and keeps old report retries valid without changing their payload`, async t => {
    const { app, c, clock, register, envelope, report, send } = await fixture(t, engine);
    assert.deepEqual((await request(app).get('/api/health').expect(200)).body.supported_schemas,
      ['usage.v1', 'usage.v2', 'usage.v3', 'usage.v4', 'usage.v5']);
    assert.deepEqual((await request(app).get('/schema/features.v4.json').expect(200)).body, p.CATALOGS['usage.v4']);
    for (const version of ['usage.v1', 'usage.v2', 'usage.v3']) {
      const id = await register(version);
      const old = await send(id, 'report', report(version === 'usage.v1' ? null : { gallery_downloads: { configured: true } }));
      const current = report({ gallery_downloads_restricted: { configured: true } });
      await assert.rejects(c.receive(envelope(id, 'report', current, 'usage.v4')), { code: 'CONSENT_REQUIRED' });
      const consent = await send(id, 'consent', { consent_version: 'usage-consent.v4' }, 'usage.v4');
      assert.deepEqual(await c.receive(signedEnvelope(consent.e.packet, id, clock.now)), consent.receipt);
      assert.deepEqual(await c.receive(signedEnvelope(old.e.packet, id, clock.now)), old.receipt);
      await assert.rejects(c.receive(envelope(id, 'consent', { consent_version: 'usage-consent.v3' }, 'usage.v3')), { code: 'CONSENT_ALREADY_CURRENT' });
      id.version = 'usage.v4'; clock.now += 86400000;
      await send(id, 'report', report({ gallery_downloads_restricted: { configured: true } }));
      // Old binaries may keep submitting under the historical consent after upgrade.
      clock.now += 86400000;
      await send(id, 'report', report({ crm: { used: true } }), version);
      assert.deepEqual((await c.lookup(id.installation_id)).packets[0].envelope, old.e);
      await send(id, 'delete', {});
      await assert.rejects(c.receive(signedEnvelope(consent.e.packet, id, clock.now)), { code: 'IDENTITY_REVOKED' });
    }
  });

  test(`${engine}: download questions remain separate in summaries and all/own/maintainer history`, async t => {
    const { c, register, report, send } = await fixture(t, engine);
    const old = await register('usage.v3'), newer = await register('usage.v4'), missing = await register('usage.v4');
    await send(old, 'report', report({ gallery_downloads: { configured: true } }));
    await send(newer, 'report', { ...report({ gallery_downloads_restricted: { configured: true } }), inventory: { galleries: 0, photos: null } });
    await send(missing, 'report', report({ gallery_downloads_restricted: { configured: null } }));
    const positive = { configured: 1, used: 0, reported: 1, used_reported: 0 };
    const unknown = { configured: 0, used: 0, reported: 0, used_reported: 0 };
    const summary = await c.summary();
    assert.deepEqual(summary.features.gallery_downloads, positive);
    assert.deepEqual(summary.features.gallery_downloads_restricted, positive);
    assert.deepEqual(summary.inventory, { galleries: { total: 0, reported: 1 }, photos: { total: 0, reported: 0 } });
    const range = { from: '2026-09-06', to: '2026-09-06' };
    const all = await history(c, range, { credential: old.installation_id });
    assert.deepEqual(all.points[0].features, summary.features);
    const own = await history(c, { ...range, scope: 'own' }, { credential: old.installation_id });
    assert.deepEqual(own.points[0].features.gallery_downloads, positive);
    assert.deepEqual(own.points[0].features.gallery_downloads_restricted, unknown);
    const admin = await history(c, { ...range, installation_id: old.installation_id }, { maintainer: true });
    assert.deepEqual(admin.points, own.points);
    await send(newer, 'delete', {});
    assert.deepEqual((await c.summary()).features.gallery_downloads_restricted, unknown);
    assert.deepEqual((await history(c, range, { credential: old.installation_id })).points[0].features.gallery_downloads, positive);
  });

  test(`${engine}: v4 tolerates missing measurements while enforcing version and privacy boundaries`, async t => {
    const { app, register, envelope, report } = await fixture(t, engine);
    const id = await register('usage.v4');
    for (const [version, fields] of [
      ['usage.v3', { features: { gallery_downloads_restricted: { configured: true } } }],
      ['usage.v4', { features: { gallery_downloads: { configured: true } } }],
      ['usage.v4', { features: { gallery_downloads_restricted: { configured: true, used: false } } }],
      ['usage.v4', { features: { gallery_downloads_restricted: { configured: 'true' } } }],
      ['usage.v4', { features: { gallery_downloads_restricted: { gallery_ids: [1] } } }],
      ['usage.v4', { features: { face_recognition: { embeddings: [1] } } }],
      ['usage.v4', { inventory: { galleries: -1 } }],
      ['usage.v4', { inventory: { photos: 1.5 } }],
      ['usage.v4', { inventory: { per_gallery: {} } }],
    ]) await request(app).post('/api/envelopes').send(envelope(id, 'report', { ...report(), ...fields }, version)).expect(400);
    await request(app).post('/api/envelopes').send(envelope(id, 'report', { ...report(null), inventory: null })).expect(200);
    assert.deepEqual((await request(app).get('/schema/ingress/usage.v4.json').expect(200)).body, p.ingressEnvelopeSchemas['usage.v4']);
  });
}
