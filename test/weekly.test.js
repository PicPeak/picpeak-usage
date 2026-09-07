"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");
const knex = require("knex");
const { createDatabase, migrate } = require("../server/database");
const { createApp } = require("../server/app");
const { readWeeklyConfig, weekStart, firstPeriodEnd, recipientId, DAY, WEEK } = require("../server/weeklyConfig");
const { prepareWeeklyReporting } = require("../server/weeklyActivity");
const { weeklyData } = require("../server/weeklyData");
const { renderWeeklyEmail } = require("../server/weeklyEmail");
const { WeeklyReporter, LEASE_MS } = require("../server/weeklyReporter");
const p = require("../protocol/protocol.cjs");
const signedEnvelope = require("./helpers/signedEnvelope.cjs");
const SECRET = "weekly-fixture-only-maintainer-access-1234567890";
const END = "2026-09-07T00:00:00.000Z";
const DUE = Date.parse("2026-09-07T08:00:00.000Z");
const env = extras => ({
  WEEKLY_REPORT_ENABLED: "true", MAINTAINER_TOKEN: SECRET,
  SMTP_HOST: "127.0.0.1", SMTP_PORT: "2525", SMTP_FROM: "usage@example.test",
  WEEKLY_REPORT_TO: "first@example.test", ...extras,
});

test("weekly config: opt-in only, strict SMTP/TLS settings and no credentials in link origin", () => {
  assert.deepEqual(readWeeklyConfig({ SMTP_HOST: "invalid" }), { enabled: false });
  const config = readWeeklyConfig(env({ SMTP_USER: "sender", SMTP_PASSWORD: "test-password", WEEKLY_REPORT_TO: "first@example.test, SECOND@example.test, first@example.test" }));
  assert.equal(config.smtp.requireTLS, true);
  assert.equal(config.smtp.tls.rejectUnauthorized, true);
  assert.equal(config.smtp.disableFileAccess, true);
  assert.equal(config.smtp.disableUrlAccess, true);
  assert.deepEqual(config.recipients, ["first@example.test", "SECOND@example.test"]);
  assert.deepEqual(config.smtp.auth, { user: "sender", pass: "test-password" });
  assert.equal(readWeeklyConfig(env({ SMTP_TLS_MODE: "tls", SMTP_PORT: "" })).smtp.port, 465);
  assert.equal(readWeeklyConfig(env({ SMTP_TLS_MODE: "none" })).smtp.ignoreTLS, true);
  assert.equal(readWeeklyConfig(env()).smtp.auth, undefined);
  for (const [key, value] of [
    ["WEEKLY_REPORT_ENABLED", "yes"], ["SMTP_PORT", "587oops"], ["SMTP_TLS_MODE", "insecure"],
    ["SMTP_TIMEOUT_MS", "0"], ["SMTP_HOST", "mail\r\ninjected"], ["SMTP_FROM", "Sender <foo@example.test>"],
    ["SMTP_FROM_NAME", "name\r\nBcc: somebody@example.test"], ["SMTP_USER", "missing-password"],
    ["SMTP_REPLY_TO", "x@example.test,another@example.test"], ["SMTP_AUTH_METHOD", "anything"],
    ["WEEKLY_REPORT_TO", ""], ["WEEKLY_REPORT_TO", "one@example.test\r\nBcc: two@example.test"],
    ["WEEKLY_REPORT_BASE_URL", "javascript:alert(1)"], ["WEEKLY_REPORT_BASE_URL", "https://secret@usage.example.test/"],
    ["WEEKLY_REPORT_BASE_URL", "http://public.example.test/"], ["WEEKLY_REPORT_BASE_URL", "https://usage.example.test/?token=secret"],
    ["WEEKLY_REPORT_LANGUAGE", "fr"], ["WEEKLY_REPORT_DAY", "maybe"], ["WEEKLY_REPORT_TIME", "24:00"],
  ]) assert.throws(() => readWeeklyConfig(env({ [key]: value })), { code: "WEEKLY_CONFIG" });
  assert.throws(() => readWeeklyConfig(env({ SMTP_PASSWORD: "private-secret-never-in-errors" })), error =>
    error.code === "WEEKLY_CONFIG" && !error.message.includes("private-secret-never-in-errors"));
});

test("weekly schedule uses closed Monday–Sunday UTC windows, including year and leap-day boundaries", () => {
  const config = readWeeklyConfig(env());
  assert.equal(new Date(weekStart(Date.parse("2027-01-01T23:59:59Z"))).toISOString(), "2026-12-28T00:00:00.000Z");
  assert.equal(new Date(weekStart(Date.parse("2028-02-29T12:00:00Z"))).toISOString(), "2028-02-28T00:00:00.000Z");
  assert.equal(firstPeriodEnd(DUE - 1, config), Date.parse(END));
  assert.equal(firstPeriodEnd(DUE, config), Date.parse(END));
  assert.equal(firstPeriodEnd(DUE + 1, config), Date.parse(END) + WEEK);
  const sunday = readWeeklyConfig(env({ WEEKLY_REPORT_DAY: "sunday", WEEKLY_REPORT_TIME: "23:15" }));
  assert.equal(sunday.scheduleOffset, 6 * DAY + (23 * 60 + 15) * 60000);
});

async function fixture(t, engine, extras = {}) {
  let db;
  if (engine === "pg") {
    const admin = createDatabase({ DATABASE_URL: process.env.TEST_DATABASE_URL });
    const schema = `weekly_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.schema.createSchema(schema);
    db = knex({ client: "pg", connection: process.env.TEST_DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 10 } });
    t.after(async () => { await db.destroy(); await admin.schema.dropSchema(schema, true); await admin.destroy(); });
  } else { db = createDatabase({ DATABASE_PATH: ":memory:" }); t.after(() => db.destroy()); }
  await migrate(db); await migrate(db);
  const clock = { now: Date.parse("2026-08-24T00:00:00.000Z") };
  const config = readWeeklyConfig(env(extras));
  await prepareWeeklyReporting(db, config, clock.now);
  // The collection fixture contains two weeks; schedule initialization itself
  // is covered separately above. Deliver the second week's digest here.
  await db("weekly_recipients").update({ period_end: END });
  const app = createApp({ db, now: () => clock.now, maintainerToken: SECRET, disableRateLimit: true });
  const c = app.locals.collector;
  const send = (identity, action, sequence, payload = {}, schema = "usage.v5") => c.receive(signedEnvelope(p.makePacket(identity, action, sequence, payload, schema), identity, new Date(clock.now)));
  const register = async (schema = "usage.v5") => {
    const identity = p.generateIdentity();
    await send(identity, "register", 0, { consent_version: schema.replace("usage.", "usage-consent.") }, schema);
    return identity;
  };
  const report = (overrides = {}) => ({ report_date: new Date(clock.now).toISOString().slice(0, 10), generated_at: new Date(clock.now).toISOString(), features: p.emptyFeatures(), inventory: { galleries: 2, photos: 10 }, picpeak_version: "3.1.0", gallery_layouts: ["grid"], ...overrides });
  const feedback = async (identity, count = 1, overrides = {}) => {
    const rows = Array.from({ length: count }, (_, index) => ({
      id: crypto.randomUUID(), installation_id: identity.installation_id,
      kind: ["feature_request", "feedback", "testimonial"][index % 3], title: `Message ${index}`,
      body: `Complete synthetic body ${index}`, name: "", status: "open", created_at: new Date(clock.now).toISOString(),
      allow_public: c.bool(false), allow_marketing: c.bool(false), published: c.bool(false), ...overrides,
    }));
    for (let offset = 0; offset < rows.length; offset += 40) await db("feedback").insert(rows.slice(offset, offset + 40));
    return rows;
  };
  const messages = [], errors = [];
  const reporter = transport => new WeeklyReporter({ db, config, now: () => clock.now, onError: code => errors.push(code), transport: transport || { async sendMail(mail) { messages.push(mail); return { accepted: [mail.to] }; } } });
  return { db, config, clock, app, c, send, register, report, feedback, messages, errors, reporter };
}

for (const engine of ["sqlite", ...(process.env.TEST_DATABASE_URL ? ["pg"] : [])]) {
  test(`${engine}: weekly joins and removals count committed transitions once, including empty installations`, async t => {
    const f = await fixture(t, engine);
    f.clock.now = Date.parse("2026-08-31T10:00:00Z");
    const identity = p.generateIdentity();
    const registration = p.makePacket(identity, "register", 0, { consent_version: p.CURRENT_CONSENT_VERSION });
    await f.c.receive(signedEnvelope(registration, identity, new Date(f.clock.now)));
    await f.c.receive(signedEnvelope(registration, identity, new Date(f.clock.now)));
    await f.send(identity, "delete", 0); await f.send(identity, "delete", 0);
    await f.send(p.generateIdentity(), "delete", 0);
    const remaining = await f.register();
    const activity = await f.db("weekly_activity").first();
    assert.deepEqual(activity, { day: "2026-08-31", joined: 2, removed: 1 });
    assert.equal(JSON.stringify(activity).includes(identity.installation_id), false);
    const data = await weeklyData(f.db, END, recipientId(f.config.recipients[0]), DUE);
    assert.equal(data.joined, 2); assert.equal(data.removed, 1); assert.equal(data.registered, 1);
    assert.equal(data.partialActivity, false);
    assert.equal(data.current.inventory.photos.reported, 0);
    await f.send(remaining, "delete", 0);
    f.clock.now += 98 * DAY;
    await f.c.pruneExpired();
    assert.equal((await f.db("weekly_activity")).length, 0);
    const old = await weeklyData(f.db, END, recipientId(f.config.recipients[0]), f.clock.now);
    assert.equal(old.partialActivity, true); assert.equal(old.joined, null);
  });

  test(`${engine}: weekly summaries compare received reports with honest coverage, late arrivals and opt-out`, async t => {
    const f = await fixture(t, engine);
    const id = await f.register(), sparse = await f.register("usage.v1");
    f.clock.now = Date.parse("2026-08-25T12:00:00Z");
    await f.send(id, "report", 1, f.report({ features: { crm: { configured: true, used: false } } }));
    f.clock.now = Date.parse("2026-09-02T12:00:00Z");
    await f.send(id, "report", 2, f.report({ features: { crm: { configured: true, used: true }, cms_content_editing: { configured: true, used: true } }, inventory: { galleries: 3, photos: 20 }, picpeak_version: "3.2.0" }));
    // The last arrival is older than the report above and must not replace it.
    f.clock.now = Date.parse("2026-09-03T12:00:00Z");
    await f.send(id, "report", 3, f.report({ report_date: "2026-09-01", generated_at: "2026-09-01T12:00:00.000Z", features: { crm: { configured: false, used: false } }, inventory: { galleries: 1, photos: 1 } }));
    await f.send(sparse, "report", 1, { report_date: "2026-08-30", generated_at: "2026-08-30T12:00:00.000Z", features: {} }, "usage.v1");
    let data = await weeklyData(f.db, END, "preview", DUE);
    assert.equal(data.current.reports, 3); assert.equal(data.current.reporters, 2);
    assert.equal(data.current.inventory.photos.total, 20); assert.equal(data.current.inventory.photos.reported, 1);
    assert.equal(data.current.features.crm.used_reported, 1);
    assert.equal(data.current.features.crm.used, 1);
    assert.equal(data.changes.find(row => row.key === "crm").delta, 100);
    assert.ok(data.newCoverage.includes("cms_content_editing"));
    assert.deepEqual(data.newVersions, ["3.2.0"]);
    assert.equal(data.previous.reporters, 1);
    await f.send(id, "delete", 0);
    data = await weeklyData(f.db, END, "preview", DUE);
    assert.equal(data.current.reporters, 1); assert.equal(data.current.inventory.photos.reported, 0);
    assert.equal(data.previous.reporters, 0); assert.equal(data.changes.length, 0);
    assert.equal(data.removed, 1);
  });

  test(`${engine}: weekly feedback includes every item beyond 200, with bounded complete parts and no regular duplicates`, async t => {
    const f = await fixture(t, engine);
    f.clock.now = Date.parse("2026-09-01T12:00:00Z");
    const id = await f.register();
    const rows = await f.feedback(id, 205);
    f.clock.now = DUE;
    let worker = f.reporter();
    for (let i = 0; i < 30; i++) {
      await worker.tick();
      if ((await f.db("weekly_recipients").first()).period_end !== END) break;
      worker = f.reporter(); // a restart between each part
    }
    assert.equal(f.errors.length, 0);
    assert.equal(f.messages.length, 21);
    for (const row of rows) {
      const matches = f.messages.filter(mail => mail.text.includes(`?feedback=${row.id}#feedback-${row.id}`));
      assert.equal(matches.length, 1, row.id);
      assert.ok(matches[0].text.includes(row.body));
    }
    assert.equal((await f.db("weekly_feedback_receipts")).length, 0);
    assert.equal((await f.db("weekly_recipients").first()).period_end, new Date(Date.parse(END) + WEEK).toISOString());
    await worker.tick(); assert.equal(f.messages.length, 21);
    assert.ok(f.messages.every(mail => !mail.html.includes(id.installation_id) && !mail.html.includes(SECRET)));
    assert.ok(f.messages.every(mail => Buffer.byteLength(mail.html) < 100000));
  });

  test(`${engine}: weekly delivery retries separately per recipient and recovers a crashed lease`, async t => {
    const f = await fixture(t, engine, { WEEKLY_REPORT_TO: "first@example.test,second@example.test" });
    f.clock.now = DUE - 1;
    let failed = true;
    const attempts = [];
    const transport = { async sendMail(mail) {
      attempts.push(mail);
      if (mail.to === "second@example.test" && failed) { const error = new Error("secret SMTP response"); error.code = "EAUTH"; throw error; }
      return { accepted: [mail.to] };
    } };
    await f.reporter(transport).tick(); assert.equal(attempts.length, 0);
    f.clock.now = DUE;
    await f.reporter(transport).tick();
    assert.equal(attempts.length, 2); assert.deepEqual(f.errors, ["EAUTH"]);
    const second = await f.db("weekly_recipients").where({ id: recipientId("second@example.test") }).first();
    assert.equal(second.period_end, END); assert.equal(second.last_error, "EAUTH");
    await f.reporter(transport).tick(); assert.equal(attempts.length, 2);
    failed = false; f.clock.now += 5 * 60000;
    await f.db("weekly_recipients").where({ id: second.id }).update({ lease_id: crypto.randomUUID(), lease_until: f.clock.now + LEASE_MS });
    await f.reporter(transport).tick(); assert.equal(attempts.length, 2);
    f.clock.now += LEASE_MS;
    await f.reporter(transport).tick(); assert.equal(attempts.length, 3);
    assert.equal(attempts[1].messageId, attempts[2].messageId);
    assert.equal(attempts.filter(mail => mail.to === "first@example.test").length, 1);
    assert.equal(attempts[0].to.includes(","), false);
  });

  test(`${engine}: two scheduler replicas cannot send the same part concurrently; disabled mode clears state`, async t => {
    const f = await fixture(t, engine);
    f.clock.now = DUE;
    let release, reached;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { reached = resolve; });
    const transport = { async sendMail(mail) { f.messages.push(mail); reached(); await gate; return { accepted: [mail.to] }; } };
    const first = f.reporter(transport), second = f.reporter(transport);
    const running = first.tick(); await ready;
    await second.tick(); assert.equal(f.messages.length, 1);
    release(); await running;
    await prepareWeeklyReporting(f.db, { enabled: false }, f.clock.now);
    for (const table of ["weekly_recipients", "weekly_activity", "weekly_feedback_receipts"]) assert.equal((await f.db(table)).length, 0);
    assert.equal((await f.db("weekly_report_meta").first()).tracking_since, null);
    const disabled = new WeeklyReporter({ db: f.db, config: { enabled: false }, transport });
    await disabled.tick(); assert.equal(f.messages.length, 1);
    await f.register(); assert.equal((await f.db("weekly_activity")).length, 0);
  });

  test(`${engine}: opting out removes pending feedback and part receipts, without retaining email content`, async t => {
    const f = await fixture(t, engine);
    f.clock.now = Date.parse("2026-09-01T12:00:00Z");
    const id = await f.register();
    await f.feedback(id, 22, { body: "Private synthetic message to remove" });
    f.clock.now = DUE;
    await f.reporter().tick();
    assert.equal(f.messages.length, 1); assert.equal((await f.db("weekly_feedback_receipts")).length, 10);
    await f.send(id, "delete", 0);
    assert.equal((await f.db("weekly_feedback_receipts")).length, 0);
    await f.reporter().tick();
    assert.equal(f.messages.length, 2);
    assert.equal(f.messages[1].text.includes("Private synthetic message to remove"), false);
    for (const table of ["weekly_recipients", "weekly_activity", "weekly_report_meta"]) {
      const stored = JSON.stringify(await f.db(table));
      assert.equal(stored.includes(id.installation_id), false);
      assert.equal(stored.includes("Private synthetic message"), false);
    }
  });

  test(`${engine}: protected message links resolve unpublished items outside the first page and hide deleted items`, async t => {
    const f = await fixture(t, engine);
    f.clock.now = Date.parse("2026-09-01T12:00:00Z");
    const id = await f.register();
    const rows = await f.feedback(id, 205);
    const target = rows.sort((a, b) => a.id.localeCompare(b.id)).at(-1);
    const path = `/api/maintainer/feedback/${target.id}`;
    await request(f.app).get(path).expect(401);
    await request(f.app).get(path).set("Authorization", `Bearer ${id.installation_id}`).expect(401);
    const response = await request(f.app).get(path).set("Authorization", `Bearer ${SECRET}`).expect(200);
    assert.equal(response.body.id, target.id); assert.equal(response.body.body, target.body);
    assert.equal(response.body.published, false); assert.equal(response.body.installation_id, undefined);
    await f.send(id, "delete", 0);
    await request(f.app).get(path).set("Authorization", `Bearer ${SECRET}`).expect(404);
    await request(f.app).get("/api/maintainer/feedback/invalid").set("Authorization", `Bearer ${SECRET}`).expect(400);
  });
}

test("weekly email: bilingual portal styling, complete escaped text, bounded size and credential-free object links", async t => {
  const f = await fixture(t, "sqlite");
  f.clock.now = Date.parse("2026-09-01T12:00:00Z");
  const id = await f.register();
  const body = '<img src="https://evil.example.test/tracker" onerror="alert(1)">\n' + "&".repeat(3900);
  await f.feedback(id, 21, { title: 'Private <script>alert(1)</script>', body, name: 'A < B & "C"' });
  const data = await weeklyData(f.db, END, "preview", DUE);
  for (const language of ["en", "de"]) {
    const email = renderWeeklyEmail(data, { ...f.config, language });
    assert.ok(email.feedbackIds.length < 10);
    assert.ok(Buffer.byteLength(email.html) < 100000);
    assert.ok(email.text.includes(body));
    assert.ok(email.html.includes("&lt;script&gt;"));
    assert.equal(email.html.includes("<script>"), false); assert.equal(email.html.includes("<img"), false);
    assert.equal(email.html.includes("@font-face"), false); assert.equal(email.html.includes("<style"), false);
    assert.ok(email.html.includes('role="presentation"')); assert.ok(email.html.includes('background:#f2f8f5'));
    assert.ok(email.html.includes(`<html lang="${language}">`));
    assert.equal(email.html.includes(SECRET), false); assert.equal(email.html.includes(id.installation_id), false);
    assert.ok([...email.html.matchAll(/href="([^"]+)"/g)].every(match => match[1].startsWith("https://usage.picpeak.app/maintainer")));
    assert.ok(email.text.includes(language === "de" ? "Nachrichten werden nicht gekürzt" : "Messages are not truncated"));
  }
});
