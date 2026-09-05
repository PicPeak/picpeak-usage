const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase, migrate } = require("../server/database");
const { Collector } = require("../server/collector");
const p = require("../protocol/protocol.cjs");

test(
  "PostgreSQL: migration guards, concurrent packets, boolean projections, and complete deletion",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = createDatabase({ DATABASE_URL: process.env.TEST_DATABASE_URL });
    t.after(() => db.destroy());
    await migrate(db);
    await migrate(db);
    const now = Date.now();
    const c = new Collector(db, { now: () => now });
    const identity = p.generateIdentity();
    const send = (packet) =>
      c.receive(p.signPacket(packet, identity, new Date(now)));
    await send(
      p.makePacket(identity, "register", 0, {
        consent_version: "usage-consent.v2",
      }),
    );
    const iso = new Date(now).toISOString();
    const payload = {
      picpeak_version: "3.123.0-beta.0",
      report_date: iso.slice(0, 10),
      generated_at: iso,
      features: Object.fromEntries(
        p.FEATURE_KEYS.map((k) => [
          k,
          { configured: k === "crm", ...(p.observesUse(k) ? { used: k === "crm" } : {}) },
        ]),
      ),
      gallery_layouts: ["grid"],
    };
    const packets = [
      p.makePacket(identity, "report", 1, payload),
      p.makePacket(identity, "report", 1, payload),
    ];
    const results = await Promise.allSettled(packets.map(send));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await c.lookup(identity.installation_id)).packets.length, 1);
    const id = require("node:crypto").randomUUID();
    await send(
      p.makePacket(identity, "feedback", 2, {
        feedback_id: id,
        kind: "feature_request",
        title: "A request",
        body: "PostgreSQL publication test",
        name: "",
        allow_public: true,
        allow_marketing: false,
      }),
    );
    await c.moderate(id, { published: true, status: "planned" });
    assert.ok((await c.publicFeedback()).some((r) => r.id === id));
    await send(p.makePacket(identity, "delete", 0, {}));
    for (const table of [
      "reports",
      "snapshots",
      "operations",
      "nonces",
      "sessions",
      "feedback",
      "votes",
    ])
      assert.equal(
        (await db(table).where({ installation_id: identity.installation_id }))
          .length,
        0,
        table,
      );
    await assert.rejects(c.lookup(identity.installation_id));
  },
);
