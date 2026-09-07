const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const knex = require('knex');
const request = require('supertest');
const { createDatabase, migrate } = require('../server/database');
const { createApp } = require('../server/app');
const p = require('../protocol/protocol.cjs');

test('English source catalogs have complete German translations, including retired questions and inventory', () => {
  const de = require('../web/locales/catalog.de.json');
  const history = Object.assign({}, ...Object.values(p.CATALOGS).map(c => c.features));
  assert.deepEqual(Object.keys(de.features).sort(), Object.keys(history).sort());
  for (const catalog of Object.values(p.CATALOGS)) {
    for (const [key, definition] of Object.entries(catalog.features)) {
      for (const field of ['name', 'configured', 'used']) {
        if (!definition[field]) continue;
        assert.deepEqual(Object.keys(definition[field]), ['en'], `${key}.${field}: English source only`);
        assert.equal(typeof de.features[key][field], 'string', `${key}.${field}: German translation missing`);
        assert.ok(de.features[key][field].trim());
      }
    }
  }
  assert.deepEqual(Object.keys(de.inventory).sort(), Object.keys(p.CATALOG.inventory).sort());
  for (const [key, definition] of Object.entries(p.CATALOG.inventory)) {
    for (const field of ['name', 'description']) {
      assert.deepEqual(Object.keys(definition[field]), ['en']);
      assert.equal(typeof de.inventory[key][field], 'string');
      assert.ok(de.inventory[key][field].trim());
    }
  }
  assert.deepEqual(Object.keys(require('../web/locales/en.json')).sort(),
    Object.keys(require('../web/locales/de.json')).sort());
});

async function fixture(t, engine) {
  let db;
  if (engine === 'pg') {
    const admin = createDatabase({ DATABASE_URL: process.env.TEST_DATABASE_URL });
    const schema = 'coverage_' + crypto.randomUUID().replaceAll('-', '');
    await admin.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL, searchPath: [schema] });
    t.after(async () => { await db.destroy(); await admin.schema.dropSchema(schema, true); await admin.destroy(); });
  } else {
    db = createDatabase({ DATABASE_PATH: ':memory:' });
    t.after(() => db.destroy());
  }
  await migrate(db); await migrate(db);
  const now = Date.parse('2026-09-06T12:00:00.000Z');
  const app = createApp({ db, now: () => now, disableRateLimit: true, sessionSecret: 'coverage-test-only-session-secret-123456789' });
  const c = app.locals.collector;
  const envelope = (identity, action, sequence, payload = {}, version = 'usage.v2') => p.signPacket(p.makePacket(identity, action, sequence, payload, version), identity, new Date(now));
  const register = async (version) => {
    const identity = p.generateIdentity();
    await c.receive(envelope(identity, 'register', 0, { consent_version: version === 'usage.v1' ? 'usage-consent.v1' : 'usage-consent.v2' }, version));
    return identity;
  };
  const report = (version, overrides = {}) => ({
    picpeak_version: '3.124.1-beta.0', report_date: '2026-09-06', generated_at: new Date(now).toISOString(),
    features: { ...p.emptyFeatures(version), ...overrides }, gallery_layouts: ['grid']
  });
  return { db, app, c, now, envelope, register, report };
}

for (const engine of ['sqlite', ...(process.env.TEST_DATABASE_URL ? ['pg'] : [])]) {
  test(`${engine}: mixed schemas have honest per-field denominators and unchanged raw envelopes`, async (t) => {
    const { db, app, c, register, envelope, report } = await fixture(t, engine);
    const legacy = await register('usage.v1'), current = await register('usage.v2');
    const old = envelope(legacy, 'report', 1, report('usage.v1'), 'usage.v1');
    const newer = envelope(current, 'report', 1, report('usage.v2', { video_uploads: { configured: true, used: true }, gallery_guest_uploads: { configured: true } }));
    await c.receive(old); await c.receive(newer);
    // Simulate a retained pre-v2 normalized record with no version metadata.
    await db('snapshots').where({ installation_id: legacy.installation_id }).update({ projection: JSON.stringify(old.packet.payload) });
    const summary = await c.summary();
    assert.deepEqual(summary.features.video_uploads, { configured: 1, used: 1, reported: 1, used_reported: 1 });
    assert.deepEqual(summary.features.gallery_guest_uploads, { configured: 1, used: 0, reported: 1, used_reported: 0 });
    assert.deepEqual(summary.features.crm, { configured: 0, used: 0, reported: 2, used_reported: 2 });
    assert.deepEqual(summary.schema_versions, { 'usage.v1': 1, 'usage.v2': 1 });
    const data = await c.dataset();
    const oldProjection = data.records.find((r) => r.schema_version === 'usage.v1');
    assert.ok(!('video_uploads' in oldProjection.features));
    assert.deepEqual((await c.lookup(legacy.installation_id)).packets[0].envelope, old);
    assert.deepEqual((await c.lookup(current.installation_id)).packets[0].envelope, newer);
    assert.ok(!JSON.stringify(data).includes(legacy.installation_id));
    for (const version of ['usage.v1', 'usage.v2']) {
      const result = await request(app).get(`/schema/${version}.json`).expect(200);
      assert.deepEqual(result.body, p.envelopeSchemas[version]);
    }
    assert.deepEqual((await request(app).get('/schema/features.v2.json').expect(200)).body, p.CATALOGS["usage.v2"]);
    await c.receive(envelope(current, 'delete', 0));
    assert.equal((await c.summary()).features.video_uploads.reported, 0);
  });

  test(`${engine}: v2 collection requires signed consent; retries are idempotent and cannot resurrect deletion`, async (t) => {
    const { db, c, now, register, envelope, report } = await fixture(t, engine);
    const identity = await register('usage.v1');
    await assert.rejects(c.receive(envelope(identity, 'report', 1, report('usage.v2'))), { code: 'CONSENT_REQUIRED' });
    assert.equal(Number((await db('installations').where({ id: identity.installation_id }).first()).sequence), 0);
    assert.equal((await db('reports')).length, 0);
    const consent = envelope(identity, 'consent', 1, { consent_version: 'usage-consent.v2' });
    const receipt = await c.receive(consent);
    assert.deepEqual(await c.receive(p.signPacket(consent.packet, identity, new Date(now))), receipt);
    assert.equal((await db('installations').where({ id: identity.installation_id }).first()).consent_version, 'usage-consent.v2');
    await assert.rejects(c.receive(envelope(identity, 'consent', 2, { consent_version: 'usage-consent.v2' })), { code: 'CONSENT_ALREADY_CURRENT' });
    await c.receive(envelope(identity, 'report', 2, report('usage.v2')));
    await c.receive(envelope(identity, 'delete', 0));
    await assert.rejects(c.receive(p.signPacket(consent.packet, identity, new Date(now))), { code: 'IDENTITY_REVOKED' });
    assert.equal((await db('installations')).length, 0);
  });

  test(`${engine}: every v2 level stays closed, including configuration-only fields`, async (t) => {
    const { c, now, register, envelope, report } = await fixture(t, engine);
    const identity = await register('usage.v2');
    const baseline = envelope(identity, 'report', 1, report('usage.v2'));
    for (const mutate of [
      (e) => { e.packet.payload.features.gallery_downloads.used = true; },
      (e) => { e.packet.payload.features.user_email = { configured: true }; },
      (e) => { e.packet.payload.features.crm.count = 1; },
      (e) => { e.packet.payload.user = 'PRIVATE@example.test'; },
      (e) => { e.packet.payload.features.video_uploads.configured = 'true'; },
      (e) => { e.packet.payload.gallery_layouts = ['PRIVATE-gallery']; },
      (e) => { e.packet.schema_version = 'usage.v3'; },
      ...['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((version) => (e) => { e.packet.schema_version = version; }),
      (e) => { delete e.packet.payload.features.api_integration; },
    ]) {
      const invalid = structuredClone(baseline); mutate(invalid);
      assert.throws(() => p.verifyEnvelope(invalid, now), { code: 'INVALID_PACKET' });
    }
    assert.throws(() => p.verifyEnvelope(envelope(identity, 'consent', 1, { consent_version: 'usage-consent.v2' }, 'usage.v1'), now), { code: 'INVALID_PACKET' });
    assert.equal(Buffer.byteLength(JSON.stringify(baseline)) < p.MAX_BYTES, true);
    await c.receive(baseline);
  });
}
