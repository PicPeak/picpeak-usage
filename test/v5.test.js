const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const p = require('../protocol/protocol.cjs');
const { createDatabase, migrate } = require('../server/database');
const { createApp } = require('../server/app');
const { history } = require('../server/history');
const signedEnvelope = require('./helpers/signedEnvelope.cjs');

test('v5 is closed, size-bounded and leaves v4 validation byte-for-byte immutable', () => {
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(p.ingressEnvelopeSchemas['usage.v4'])).digest('hex'),
    '65e57ed81c3d686815028729411567d896b371b948001c17df3f2874198613fd');
  const id = p.generateIdentity(), now = new Date('2026-09-07T12:00:00.000Z');
  const payload = { features: p.emptyFeatures(), inventory: { galleries: p.MAX_INVENTORY_COUNT, photos: p.MAX_INVENTORY_COUNT },
    picpeak_version: '3.127.1-beta.0', report_date: '2026-09-07', generated_at: now.toISOString(), gallery_layouts: p.LAYOUTS };
  const signed = fields => p.signPacket(p.makePacket(id, 'report', 1, { ...payload, features: fields }), id, now);
  const e = signed(payload.features);
  assert.ok(Buffer.byteLength(JSON.stringify(e)) < p.MAX_BYTES);
  assert.deepEqual(p.verifyEnvelope(e, now.getTime()).payload, payload);
  assert.equal(p.FEATURE_KEYS.length, 87); assert.equal(p.ALL_FEATURE_KEYS.length, 94);
  for (const addition of [
    { email_template_delivery: { configured: true, used: true, recipient: 'PRIVATE@example.test' } },
    { cms_content_editing: { configured: true, used: true, content: 'PRIVATE' } },
    { cms_content_editing: { configured: true, used: 3 } },
    { cms: { configured: true, used: true } },
  ]) assert.throws(() => p.verifyEnvelope(signed({ ...payload.features, ...addition }), now.getTime()));
});

test('v5 requires consent, preserves broad old answers, and never fills missing precise evidence with false', async t => {
  const db = createDatabase({ DATABASE_PATH: ':memory:' }); t.after(() => db.destroy()); await migrate(db);
  let now = Date.parse('2026-09-07T12:00:00.000Z');
  const c = createApp({ db, now: () => now, disableRateLimit: true }).locals.collector;
  const a = { ...p.generateIdentity(), sequence: -1 }, b = { ...p.generateIdentity(), sequence: -1 };
  const envelope = (id, action, payload, version) => signedEnvelope(p.makePacket(id, action, id.sequence + 1, payload, version), id, now);
  async function send(id, action, payload, version) {
    const e = envelope(id, action, payload, version), receipt = await c.receive(e); id.sequence++; return { e, receipt };
  }
  const report = features => ({ features, report_date: new Date(now).toISOString().slice(0, 10), generated_at: new Date(now).toISOString() });
  await send(a, 'register', { consent_version: 'usage-consent.v4' }, 'usage.v4');
  const old = await send(a, 'report', report({ email_templates: { configured: true, used: true } }), 'usage.v4');
  await assert.rejects(c.receive(envelope(a, 'report', report({ email_template_editing: { used: true } }), 'usage.v5')), { code: 'CONSENT_REQUIRED' });
  await send(b, 'register', { consent_version: 'usage-consent.v5' }, 'usage.v5');
  await send(b, 'report', report({ email_template_editing: { used: false }, email_template_delivery: { used: true } }), 'usage.v5');
  const summary = await c.summary();
  assert.deepEqual(summary.features.email_templates, { configured: 1, reported: 1, used: 1, used_reported: 1 });
  assert.deepEqual(summary.features.email_template_editing, { configured: 0, reported: 0, used: 0, used_reported: 1 });
  assert.deepEqual(summary.features.email_template_delivery, { configured: 0, reported: 0, used: 1, used_reported: 1 });
  assert.deepEqual((await history(c, { from: '2026-09-07', to: '2026-09-07' }, { credential: a.installation_id })).points[0].features, summary.features);
  await send(a, 'consent', { consent_version: 'usage-consent.v5' }, 'usage.v5');
  assert.deepEqual(await c.receive(signedEnvelope(old.e.packet, a, now)), old.receipt);
  assert.deepEqual((await c.lookup(a.installation_id)).packets[0].envelope.packet, old.e.packet);
});
