const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const p = require('../protocol/protocol.cjs');
const { createDatabase, migrate } = require('../server/database');
const { createApp } = require('../server/app');
const signedEnvelope = require('./helpers/signedEnvelope.cjs');

test('v6 is closed, size-bounded and leaves v5 validation byte-for-byte immutable', () => {
  // Pinned with the pre-v6 protocol: the v5 receiver schema must not move
  // when the catalog gains a version that changes only one description.
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(p.ingressEnvelopeSchemas['usage.v5'])).digest('hex'),
    '373ebe919a536e31529ba80e3a8709d801c3a9b6888d77bce1f1d516d2322587');
  assert.equal(p.CURRENT_SCHEMA_VERSION, 'usage.v6');
  assert.equal(p.CONSENT_VERSIONS['usage.v6'], 'usage-consent.v6');
  // Same keys as v5: the v6 change is the meaning of webhooks.used, not a key.
  assert.deepEqual(Object.keys(p.CATALOGS['usage.v6'].features), Object.keys(p.CATALOGS['usage.v5'].features));
  assert.equal(p.FEATURE_KEYS.length, 87); assert.equal(p.ALL_FEATURE_KEYS.length, 94);
  assert.notEqual(p.CATALOGS['usage.v6'].features.webhooks.used.en, p.CATALOGS['usage.v5'].features.webhooks.used.en);
  const id = p.generateIdentity(), now = new Date('2026-10-01T12:00:00.000Z');
  const payload = { features: p.emptyFeatures(), inventory: { galleries: p.MAX_INVENTORY_COUNT, photos: p.MAX_INVENTORY_COUNT },
    picpeak_version: '3.152.1-beta.0', report_date: '2026-10-01', generated_at: now.toISOString(), gallery_layouts: p.LAYOUTS };
  const signed = fields => p.signPacket(p.makePacket(id, 'report', 1, { ...payload, features: fields }), id, now);
  const e = signed(payload.features);
  assert.ok(Buffer.byteLength(JSON.stringify(e)) < p.MAX_BYTES);
  assert.deepEqual(p.verifyEnvelope(e, now.getTime()).payload, payload);
  for (const addition of [
    { webhooks: { configured: true, used: true, destination: 'https://PRIVATE.example.test/hook' } },
    { webhooks: { configured: true, used: true, event_type: 'event.published' } },
    { webhooks: { configured: true, used: 3 } },
    { webhooks: { configured: true, used: true, deliveries: 12 } },
  ]) assert.throws(() => p.verifyEnvelope(signed({ ...payload.features, ...addition }), now.getTime()));
});

test('v6 requires consent; a v5 participant keeps its scope until it explicitly upgrades', async t => {
  const db = createDatabase({ DATABASE_PATH: ':memory:' }); t.after(() => db.destroy()); await migrate(db);
  let now = Date.parse('2026-10-01T12:00:00.000Z');
  const c = createApp({ db, now: () => now, disableRateLimit: true }).locals.collector;
  const a = { ...p.generateIdentity(), sequence: -1 }, b = { ...p.generateIdentity(), sequence: -1 };
  const envelope = (id, action, payload, version) => signedEnvelope(p.makePacket(id, action, id.sequence + 1, payload, version), id, now);
  async function send(id, action, payload, version) {
    const e = envelope(id, action, payload, version), receipt = await c.receive(e); id.sequence++; return { e, receipt };
  }
  const report = features => ({ features, report_date: new Date(now).toISOString().slice(0, 10), generated_at: new Date(now).toISOString() });
  await send(a, 'register', { consent_version: 'usage-consent.v5' }, 'usage.v5');
  const old = await send(a, 'report', report({ webhooks: { configured: true, used: false } }), 'usage.v5');
  await assert.rejects(c.receive(envelope(a, 'report', report({ webhooks: { configured: true, used: true } }), 'usage.v6')), { code: 'CONSENT_REQUIRED' });
  await send(b, 'register', { consent_version: 'usage-consent.v6' }, 'usage.v6');
  await send(b, 'report', report({ webhooks: { configured: true, used: true } }), 'usage.v6');
  const summary = await c.summary();
  assert.deepEqual(summary.features.webhooks, { configured: 2, reported: 2, used: 1, used_reported: 2 });
  await send(a, 'consent', { consent_version: 'usage-consent.v6' }, 'usage.v6');
  // One report per installation and day: the upgraded report is tomorrow's.
  now += 24 * 60 * 60 * 1000;
  await send(a, 'report', report({ webhooks: { configured: true, used: true } }), 'usage.v6');
  assert.deepEqual((await c.summary()).features.webhooks, { configured: 2, reported: 2, used: 2, used_reported: 2 });
  // The accepted v5 packet retries unchanged after the upgrade.
  assert.deepEqual(await c.receive(signedEnvelope(old.e.packet, a, now)), old.receipt);
});
