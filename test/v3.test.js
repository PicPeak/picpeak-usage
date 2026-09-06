const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const knex = require('knex');
const request = require('supertest');
const { createDatabase, migrate } = require('../server/database');
const { createApp } = require('../server/app');
const { history } = require('../server/history');
const p = require('../protocol/protocol.cjs');

async function fixture(t, engine) {
  let db;
  if (engine === 'pg') {
    const admin = createDatabase({ DATABASE_URL: process.env.TEST_DATABASE_URL });
    const schema = `v3_${crypto.randomUUID().replaceAll('-', '')}`;
    await admin.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: process.env.TEST_DATABASE_URL, searchPath: [schema] });
    t.after(async () => { await db.destroy(); await admin.schema.dropSchema(schema, true); await admin.destroy(); });
  } else { db = createDatabase({ DATABASE_PATH: ':memory:' }); t.after(() => db.destroy()); }
  await migrate(db);
  const clock = { now: Date.parse('2026-08-30T12:00:00.000Z') };
  const app = createApp({ db, now: () => clock.now, disableRateLimit: true, maintainerToken: 'v3-test-maintainer-secret-1234567890' });
  const c = app.locals.collector;
  const envelope = (id, action, payload, version = id.version, sequence = id.sequence + 1) =>
    p.signPacket(p.makePacket(id, action, sequence, payload, version), id, new Date(clock.now));
  async function send(id, action, payload, version = id.version) {
    const e = envelope(id, action, payload, version);
    const receipt = await c.receive(e); id.sequence = e.packet.sequence; return { e, receipt };
  }
  async function register(version = 'usage.v3') {
    const id = { ...p.generateIdentity(), version, sequence: -1 };
    await send(id, 'register', { consent_version: p.CONSENT_VERSIONS[version] });
    return id;
  }
  function payload(version = 'usage.v3', inventory = { galleries: 0, photos: 0 }) {
    const iso = new Date(clock.now).toISOString();
    return { picpeak_version: '3.124.1-beta.0', report_date: iso.slice(0, 10), generated_at: iso,
      features: p.emptyFeatures(version), gallery_layouts: ['grid'], ...(version === 'usage.v3' ? { inventory } : {}) };
  }
  return { app, c, db, clock, envelope, send, register, payload };
}

test('v1 and v2 wire schemas are unchanged, and v3 stays below the packet limit', () => {
  for (const [v, hash] of Object.entries({
    'usage.v1': 'cc8d0a865d21e36d2b24d23ca6aa8dd8d48000cb17aef83996786f70755bc922',
    'usage.v2': '159821cf45c1951016d33a4ed9ca55a0a7ee1b60dd715b803fcfed33e5c8a846',
  })) assert.equal(crypto.createHash('sha256').update(JSON.stringify(p.envelopeSchemas[v].properties)).digest('hex'), hash);
  assert.equal(p.featureKeysFor('usage.v3').length, 86);
  assert.equal(Object.values(p.CATALOGS['usage.v3'].features).filter(f => !f.used).length, 23);
  const id = p.generateIdentity(), date = new Date('2026-09-06T12:00:00.000Z');
  const e = p.signPacket(p.makePacket(id, 'report', 1, {
    picpeak_version: '3.124.1-beta.0', generated_at: date.toISOString(), report_date: '2026-09-06',
    gallery_layouts: p.LAYOUTS, features: p.emptyFeatures('usage.v3'), inventory: { galleries: 1000000000, photos: 1000000000 },
  }, 'usage.v3'), id, date);
  assert.ok(Buffer.byteLength(JSON.stringify(e)) < p.MAX_BYTES);
});

for (const engine of ['sqlite', ...(process.env.TEST_DATABASE_URL ? ['pg'] : [])]) {
  test(`${engine}: every inventory field is closed, bounded and gated by version`, async t => {
    const { app, register, envelope, payload } = await fixture(t, engine);
    const id = await register();
    for (const version of ['usage.v1', 'usage.v2', 'usage.v3'])
      assert.deepEqual((await request(app).get(`/schema/${version}.json`).expect(200)).body, p.envelopeSchemas[version]);
    assert.deepEqual((await request(app).get('/schema/features.v3.json').expect(200)).body, p.CATALOGS["usage.v3"]);
    const good = payload();
    for (const mutate of [
      r => { delete r.inventory; }, r => { delete r.inventory.photos; },
      r => { r.inventory.photos = -1; }, r => { r.inventory.photos = 1.1; },
      r => { r.inventory.photos = '12'; }, r => { r.inventory.photos = null; },
      r => { r.inventory.photos = p.MAX_INVENTORY_COUNT + 1; },
      r => { r.inventory.gallery_ids = [1]; }, r => { r.inventory.per_gallery = {}; },
      r => { r.features.gallery_folders.used = true; },
      r => { r.features.crm_invoice_import.amount = 10; },
      r => { r.features.face_recognition.names = ['PRIVATE']; },
    ]) {
      const bad = structuredClone(good); mutate(bad);
      assert.throws(() => envelope(id, 'report', bad), { code: 'INVALID_PACKET' });
    }
    for (const version of ['usage.v1', 'usage.v2'])
      assert.throws(() => envelope(id, 'report', { ...payload(version), inventory: good.inventory }, version), { code: 'INVALID_PACKET' });
  });

  test(`${engine}: signed v1/v2 upgrades are idempotent, cannot downgrade and preserve old reports`, async t => {
    const { c, db, clock, register, envelope, payload, send } = await fixture(t, engine);
    for (const version of ['usage.v1', 'usage.v2']) {
      const id = await register(version);
      const old = await send(id, 'report', payload(version));
      await assert.rejects(c.receive(envelope(id, 'report', payload(), 'usage.v3')), { code: 'CONSENT_REQUIRED' });
      const up = await send(id, 'consent', { consent_version: 'usage-consent.v3' }, 'usage.v3');
      assert.deepEqual(await c.receive(p.signPacket(up.e.packet, id, new Date(clock.now))), up.receipt);
      assert.equal((await db('installations').where({ id: id.installation_id }).first()).consent_version, 'usage-consent.v3');
      await assert.rejects(c.receive(envelope(id, 'consent', { consent_version: 'usage-consent.v2' }, 'usage.v2')), { code: 'CONSENT_ALREADY_CURRENT' });
      id.version = 'usage.v3'; clock.now += 86400000;
      await send(id, 'report', payload());
      assert.deepEqual((await c.lookup(id.installation_id)).packets[0].envelope, old.e);
      await send(id, 'delete', {});
      await assert.rejects(c.receive(p.signPacket(up.e.packet, id, new Date(clock.now))), { code: 'IDENTITY_REVOKED' });
    }
  });

  test(`${engine}: inventory sums use the last report per reporter and distinguish unknown from zero`, async t => {
    const { app, c, clock, register, payload, send } = await fixture(t, engine);
    const a = await register('usage.v1'), b = await register('usage.v2'), c3 = await register(), zero = await register();
    await send(a, 'report', payload('usage.v1')); await send(b, 'report', payload('usage.v2'));
    clock.now = Date.parse('2026-09-01T12:00:00.000Z');
    await send(c3, 'report', payload('usage.v3', { galleries: 10, photos: 100 }));
    await send(zero, 'report', payload());
    clock.now += 86400000;
    await send(c3, 'report', payload('usage.v3', { galleries: 12, photos: 125 }));
    const expected = { galleries: { total: 12, reported: 2 }, photos: { total: 125, reported: 2 } };
    assert.deepEqual((await c.summary()).inventory, expected);
    const input = { from: '2026-08-01', to: '2026-09-30', interval: 'month' };
    const series = await history(c, input, { credential: a.installation_id });
    assert.deepEqual(series.points[0].inventory.photos, { total: 0, reported: 0 });
    assert.deepEqual(series.points[1].inventory, expected);
    assert.equal(series.points[1].reports, 3);
    const own = await history(c, { ...input, scope: 'own' }, { credential: c3.installation_id });
    assert.deepEqual(own.points[1].inventory.photos, { total: 125, reported: 1 });
    const admin = await history(c, { ...input, installation_id: c3.installation_id }, { maintainer: true });
    assert.deepEqual(admin.points, own.points);
    await request(app).post('/api/participant/history').send(input).expect(401);
    const data = await c.dataset();
    assert.equal(data.records.filter(r => r.inventory).length, 2);
    assert.ok(!JSON.stringify(data).includes(c3.installation_id));
    await send(c3, 'delete', {});
    assert.deepEqual((await c.summary()).inventory.photos, { total: 0, reported: 1 });
    assert.deepEqual((await history(c, input, { credential: a.installation_id })).points[1].inventory.photos, { total: 0, reported: 1 });
  });
}
