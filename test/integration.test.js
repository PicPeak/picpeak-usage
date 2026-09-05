// Run against the independent PicPeak checkout in this workspace. Standalone
// collector users run npm test; the explicit integration command requires it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createDatabase, migrate } = require("../server/database");
const { createApp } = require("../server/app");
const root =
  process.env.PICPEAK_CHECKOUT || path.resolve(__dirname, "../../picpeak");
let UsageService;
try {
  ({ UsageService } = require(
    path.join(root, "backend/src/usage/UsageService"),
  ));
} catch (error) {
  if (process.env.REQUIRE_INTEGRATION) throw error;
}

async function setup(t) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "picpeak-usage-integration-"),
  );
  const db = createDatabase({ DATABASE_PATH: ":memory:" });
  const local = createDatabase({ DATABASE_PATH: ":memory:" });
  await migrate(db);
  await require(
    path.join(root, "backend/migrations/core/201_product_usage"),
  ).up(local);
  await local.schema.createTable("app_settings", (table) => {
    table.string("setting_key").primary();
    table.text("setting_value");
  });
  await local.schema.createTable("feature_flags", (table) => {
    table.string("key").primary();
    table.boolean("value");
  });
  await local.schema.createTable("email_configs", (table) => {
    table.increments("id");
    table.string("smtp_host");
  });
  await local.schema.createTable("events", (table) => {
    table.increments("id");
    table.text("color_theme");
    table.text("external_path");
  });
  await local.schema.createTable("mail_accounts", (table) => {
    table.increments("id");
    table.text("smtp_host");
  });
  await local.schema.createTable("whatsapp_configs", (table) => {
    table.increments("id");
    table.boolean("enabled");
    table.string("phone_number_id");
    table.string("access_token");
  });
  await local("feature_flags").insert({ key: "clients", value: 1 });
  await local("events").insert({
    color_theme: JSON.stringify({
      galleryLayout: "masonry",
      customCss: ".private-domain { color: red; }",
      eventName: "PRIVATE EVENT",
    }),
  });
  await local("email_configs").insert({
    smtp_host: "private-mail.example.test",
  });
  const clock = { value: Date.parse("2026-09-05T12:00:00.000Z") };
  const app = createApp({ db, now: () => clock.value, disableRateLimit: true });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const transport = { offline: false, loseReceipt: false, calls: 0 };
  const options = {
    version: "3.123.0-beta.0",
    secret: "integration-only-encryption-material-123456",
    endpoint: `http://127.0.0.1:${server.address().port}`,
    bindingPath: path.join(dir, "usage-instance.key"),
    now: () => clock.value,
    fetch: async (...args) => {
      transport.calls++;
      if (transport.offline) throw new Error("offline");
      const response = await fetch(...args);
      if (transport.afterResponse) await transport.afterResponse(response);
      if (transport.loseReceipt) {
        transport.loseReceipt = false;
        throw new Error("lost receipt");
      }
      return response;
    },
  };
  const service = new UsageService(local, options);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
    await local.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    service,
    options,
    local,
    db,
    c: app.locals.collector,
    clock,
    transport,
  };
}

test(
  "real PicPeak-to-collector consent, daily cadence, raw export, markers and delete/rejoin",
  { skip: !UsageService },
  async (t) => {
    const { service, local, transport, clock, c } = await setup(t);
    await service.tick();
    await service.markUsed(["crm", "photo_count"]);
    assert.equal(transport.calls, 0);
    assert.equal((await local("product_usage_markers")).length, 0);
    assert.equal((await service.status()).installation_id, null);
    await assert.rejects(service.enable("implicit"));
    await service.enable("usage-consent.v1");
    const id = (await service.status()).installation_id;
    assert.equal((await service.status()).status, "active");
    const publicState = JSON.stringify(await service.status());
    assert.ok(!publicState.includes("PRIVATE KEY"));
    assert.ok(!publicState.includes("private_key_encrypted"));
    await service.markUsed(["crm"]);
    await service.tick();
    await service.tick();
    const data = await service.export();
    assert.equal(data.packets.length, 1);
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes("PRIVATE EVENT"));
    assert.ok(!serialized.includes("private-mail"));
    assert.ok(!serialized.includes("private-domain"));
    assert.equal(
      data.packets[0].envelope.packet.payload.features.crm.used,
      true,
    );
    assert.deepEqual(data.packets[0].envelope.packet.payload.gallery_layouts, [
      "masonry",
    ]);
    clock.value += 86400000;
    await service.tick();
    assert.equal((await service.export()).packets.length, 2);
    await service.disable();
    const state = await local("product_usage_state").first();
    assert.equal(state.status, "disabled");
    assert.equal(state.private_key_encrypted, null);
    assert.equal(state.installation_id, null);
    await assert.rejects(c.lookup(id));
    await service.enable("usage-consent.v1");
    assert.notEqual((await service.status()).installation_id, id);
  },
);

test(
  "lost report receipts retry idempotently and pending deletion retains credentials only until confirmation",
  { skip: !UsageService },
  async (t) => {
    const { service, local, transport, c } = await setup(t);
    await service.enable("usage-consent.v1");
    transport.loseReceipt = true;
    await service.tick();
    assert.equal((await service.status()).pending_action, "report");
    await service.tick();
    assert.equal((await service.export()).packets.length, 1);
    transport.offline = true;
    await service.disable();
    const pending = await local("product_usage_state").first();
    assert.equal(pending.status, "deletion_pending");
    assert.ok(pending.private_key_encrypted);
    await service.markUsed(["crm"]);
    assert.equal((await local("product_usage_markers")).length, 0);
    assert.equal((await c.lookup(pending.installation_id)).packets.length, 1);
    transport.offline = false;
    transport.loseReceipt = true;
    await service.tick();
    assert.equal((await service.status()).status, "deletion_pending");
    await assert.rejects(c.lookup(pending.installation_id));
    await service.tick();
    assert.equal((await service.status()).status, "disabled");
    assert.equal(
      (await local("product_usage_state").first()).private_key_encrypted,
      null,
    );
  },
);

test(
  "backend sequence leases avoid concurrent reports and a restored copy without its local binding is stopped",
  { skip: !UsageService },
  async (t) => {
    const { service, local, options, c } = await setup(t);
    await service.enable("usage-consent.v1");
    const other = new UsageService(local, options);
    await Promise.allSettled([service.tick(), other.tick(), service.tick()]);
    assert.equal((await service.export()).packets.length, 1);
    await fs.unlink(options.bindingPath);
    await local("product_usage_state")
      .where({ id: 1 })
      .update({ last_report_date: null });
    await service.tick();
    assert.equal((await service.status()).status, "identity_conflict");
    assert.equal(
      (await c.lookup((await service.status()).installation_id)).packets.length,
      1,
    );
  },
);

test(
  "opt-out during an in-flight report keeps collection stopped and clears the late receipt",
  { skip: !UsageService },
  async (t) => {
    const { service, local, transport, c } = await setup(t);
    await service.enable("usage-consent.v1");
    const id = (await service.status()).installation_id;
    let received;
    let release;
    const accepted = new Promise((resolve) => {
      received = resolve;
    });
    const paused = new Promise((resolve) => {
      release = resolve;
    });
    transport.afterResponse = async () => {
      received();
      await paused;
    };
    const sending = service.tick();
    await accepted;
    try {
      assert.equal((await service.disable()).status, "deletion_pending");
      await service.markUsed(["crm"]);
      assert.equal((await local("product_usage_markers")).length, 0);
    } finally {
      transport.afterResponse = null;
      release();
      await sending;
    }
    const state = await local("product_usage_state").first();
    assert.equal(state.status, "deletion_pending");
    assert.equal(state.last_packet, null);
    assert.equal(state.last_receipt, null);
    assert.equal(state.last_report_date, null);
    await service.tick();
    assert.equal((await service.status()).status, "disabled");
    await assert.rejects(c.lookup(id));
  },
);

test(
  "a rejected vote does not strand the queue or advance the signing sequence",
  { skip: !UsageService },
  async (t) => {
    const { service } = await setup(t);
    await service.enable("usage-consent.v1");
    const result = await service.command("vote", {
      feedback_id: require("node:crypto").randomUUID(),
      voted: true,
    });
    assert.equal(result.delivered, false);
    assert.equal(result.queued, false);
    assert.equal(result.state.last_error, "REQUEST_REJECTED");
    await service.tick();
    assert.equal((await service.status()).status, "active");
    assert.equal((await service.export()).packets.length, 1);
  },
);

test(
  "in-app feedback is separate from reports and a short-lived portal session permits votes",
  { skip: !UsageService },
  async (t) => {
    const { service, c, db } = await setup(t);
    await service.enable("usage-consent.v1");
    const feedbackId = require("node:crypto").randomUUID();
    const result = await service.command("feedback", {
      feedback_id: feedbackId,
      kind: "feature_request",
      title: "Better selections",
      body: "Please improve the selection workflow.",
      name: "",
      allow_public: true,
      allow_marketing: false,
    });
    assert.equal(result.delivered, true);
    assert.equal((await db("reports")).length, 0);
    assert.equal((await c.publicFeedback()).length, 0);
    await c.moderate(feedbackId, { published: true, status: "open" });
    const session = await service.command("session", {});
    assert.ok(session.receipt.session_token);
    assert.equal(
      await c.participant(session.receipt.session_token),
      (await service.status()).installation_id,
    );
    await service.command("vote", { feedback_id: feedbackId, voted: true });
    assert.equal((await c.publicFeedback())[0].votes, 1);
    await service.disable();
    assert.equal((await db("feedback")).length, 0);
    assert.equal((await db("votes")).length, 0);
  },
);

test(
  "protocol files are byte-identical in both repositories",
  { skip: !UsageService },
  async () => {
    for (const file of ["schema.cjs", "protocol.cjs"])
      assert.equal(
        await fs.readFile(path.join(root, "backend/src/usage", file), "utf8"),
        await fs.readFile(path.join(__dirname, "../protocol", file), "utf8"),
      );
  },
);
