const crypto = require('node:crypto');
const { canonical } = require('../../protocol/protocol.cjs');

// Simulate a historical/partial sender independently of today's strict writer.
module.exports = function signedEnvelope(packet, identity, now) {
  const signed = { packet, public_key: identity.public_key, issued_at: new Date(now).toISOString(), nonce: crypto.randomUUID() };
  return { ...signed, signature: crypto.sign(null, Buffer.from(canonical(signed)), identity.private_key).toString('base64url') };
};
