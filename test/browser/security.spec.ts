import { test as base, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
const { createDatabase, migrate } = require("../../server/database");
const { createApp } = require("../../server/app");
const p = require("../../protocol/protocol.cjs");
const crypto = require("node:crypto");
const signedEnvelope = require("../helpers/signedEnvelope.cjs");
const SECRET = "browser-security-fixture-only-123456789012345";
const html = '<img src=x onerror="window.__injected=true">';

const test = base.extend<{ collector: any }>({
  collector: async ({}, use) => {
    const db = createDatabase({ DATABASE_PATH: ":memory:" });
    await migrate(db);
    const clock = { offset: 0 };
    const now = () => Date.now() + clock.offset;
    const app = createApp({
      db,
      now,
      maintainerToken: SECRET,
      disableRateLimit: true,
    });
    const c = app.locals.collector;
    const identity = p.generateIdentity();
    const send = (action: string, sequence: number, payload: unknown = {}) =>
      c.receive(
        p.signPacket(
          p.makePacket(identity, action, sequence, payload),
          identity,
          new Date(now()),
        ),
      );
    await send("register", 0, { consent_version: p.CURRENT_CONSENT_VERSION });
    const iso = new Date().toISOString();
    await send("report", 1, {
      picpeak_version: "1.2.3",
      report_date: iso.slice(0, 10),
      generated_at: iso,
      inventory: { galleries: 0, photos: 0 },
      gallery_layouts: ["grid"],
      features: Object.fromEntries(
        p.FEATURE_KEYS.map((key: string) => [
          key,
          p.emptyFeatures()[key],
        ]),
      ),
    });
    const feedbackId = crypto.randomUUID();
    await send("feedback", 2, {
      feedback_id: feedbackId,
      kind: "feature_request",
      title: "Synthetic request",
      body: html,
      name: "",
      allow_public: true,
      allow_marketing: false,
    });
    await c.moderate(feedbackId, { published: true, status: "open" });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      await use({
        url: `http://127.0.0.1:${server.address().port}`,
        db,
        c,
        identity,
        send,
        clock,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(resolve));
      await db.destroy();
    }
  },
});

async function unlock(page: Page, collector: any) {
  await page.goto(collector.url);
  await page
    .getByLabel("Installation lookup hash")
    .fill(collector.identity.installation_id);
  await page
    .getByRole("button", { name: "Open the dashboard", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What’s being used" }),
  ).toBeVisible();
}

test('all v4 definitions are public in EN/DE and config-only use is never shown as zero adoption', async ({ page, collector }) => {
  await page.goto(`${collector.url}/transparency`);
  const catalog = page.locator('#feature-catalog');
  await expect(catalog.locator('details')).toHaveCount(86);
  await catalog.getByLabel('Language / Sprache').selectOption('de');
  await expect(catalog.getByRole('heading', { level: 2 })).toHaveText('Alle 86 Funktionssignale');
  await expect(catalog).toContainText('Aktuelle Anzahl der Fotoeinträge ohne Videos');
  await expect(catalog).toContainText('Betreuer können');
  await catalog.getByRole('searchbox').fill('eingeschränkt');
  await expect(catalog.locator('details')).toHaveCount(1);
  await catalog.locator('summary').click();
  await expect(catalog.locator('details')).toContainText('Galerie-Downloads eingeschränkt');
  await expect(catalog.locator('details')).toContainText('Mindestens eine Galerie hat Downloads abgeschaltet');
  await catalog.getByLabel('Language / Sprache').selectOption('en');
  await expect(catalog.locator('details')).toHaveCount(0);
  await expect(catalog).toContainText('No matching capabilities.');
  await catalog.getByRole('searchbox').fill('restricted');
  await expect(catalog.locator('details')).toHaveCount(1);
  await expect(catalog.locator('details')).toContainText('Gallery downloads restricted');
  await catalog.getByLabel('Language / Sprache').selectOption('de');
  await catalog.getByRole('searchbox').fill('gallery_feedback_likes');
  await expect(catalog.locator('details')).toHaveCount(1);
  await catalog.locator('summary').click();
  await expect(catalog).toContainText('tatsächliche Nutzung wird nicht erfasst');
  await unlock(page, collector);
  await page.getByPlaceholder('Search features…').fill('gallery_guest_uploads');
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await expect(page.locator('.feature-row')).toContainText('Not collected');
  await expect(page.getByRole('meter')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('configured');
  await expect(page.locator('.feature-row')).toContainText('0 / 1 reported');
  await expect(page.getByRole('meter')).toHaveCount(1);
  await page.getByPlaceholder('Search features…').fill('OAuth');
  await expect(page.getByRole('meter')).toHaveCount(1);
});
test('partial legacy reports do not dilute percentages or turn missing totals into zero', async ({ page, collector }) => {
  const id = p.generateIdentity();
  const now = new Date();
  for (const [action, sequence, payload] of [
    ['register', 0, { consent_version: 'usage-consent.v1' }],
    ['report', 1, { report_date: now.toISOString().slice(0, 10), generated_at: now.toISOString(), features: { crm: { used: true } } }],
  ] as const) {
    await collector.c.receive(signedEnvelope(p.makePacket(id, action, sequence, payload, 'usage.v1'), id, now));
  }
  await unlock(page, collector);
  const history = page.locator('.usage-history');
  await history.getByRole('combobox', { name: 'Metric', exact: true }).selectOption('layouts');
  await history.getByRole('combobox', { name: 'Display', exact: true }).selectOption('percent');
  await history.getByText('Show values as a table', { exact: true }).click();
  await expect(history.locator('tbody tr').last()).toContainText('100% (1/1)');
  await history.getByRole('combobox', { name: 'Metric', exact: true }).selectOption('versions');
  await expect(history.locator('tbody tr').last()).toContainText('100% (1/1)');
  await history.getByRole('combobox', { name: 'Reporters', exact: true }).selectOption('own');
  // Log in as the sparse reporter to exercise the real missing-field response.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await collector.send('delete', 0);
  await unlock(page, { ...collector, identity: id });
  for (const title of ['PicPeak versions', 'Layouts in use']) {
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(panel).toContainText('Not reported');
    await expect(panel).not.toContainText('Waiting for the first report.');
  }
  const ownHistory = page.locator('.usage-history');
  await ownHistory.getByRole('combobox', { name: 'Reporters', exact: true }).selectOption('own');
  await ownHistory.getByRole('combobox', { name: 'Metric', exact: true }).selectOption('photos');
  await ownHistory.getByText('Show values as a table', { exact: true }).click();
  await expect(ownHistory.locator('tbody tr').last()).toContainText('Not reported');
  await ownHistory.getByLabel('Language / Sprache').selectOption('de');
  await expect(ownHistory.locator('tbody tr').last()).toContainText('Nicht gemeldet');
});

test('old allowed-downloads and v4 restrictions stay separately selectable with honest history denominators', async ({ page, collector }) => {
  const legacy = p.generateIdentity(), now = new Date();
  for (const [action, sequence, payload] of [
    ['register', 0, { consent_version: 'usage-consent.v3' }],
    ['report', 1, { report_date: now.toISOString().slice(0, 10), generated_at: now.toISOString(), features: { gallery_downloads: { configured: true } } }],
  ] as const) await collector.c.receive(signedEnvelope(p.makePacket(legacy, action, sequence, payload, 'usage.v3'), legacy, now));
  await page.goto(`${collector.url}/transparency`);
  const catalog = page.locator('#feature-catalog');
  await catalog.getByRole('searchbox').fill('gallery_downloads');
  await expect(catalog.locator('details')).toHaveCount(1);
  await expect(catalog).toContainText('Gallery downloads restricted');
  await unlock(page, collector);
  await page.getByPlaceholder('Search features…').fill('gallery_downloads');
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('configured');
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expect(page.locator('.feature-row').filter({ hasText: 'Gallery downloads restricted' })).toContainText('0 / 1 reported');
  const chart = page.locator('.usage-history');
  await chart.getByRole('combobox', { name: 'Metric', exact: true }).selectOption('configured');
  const feature = chart.getByRole('combobox', { name: 'Capability', exact: true });
  await expect(feature.locator('option')).toHaveCount(87);
  await chart.getByRole('combobox', { name: 'Display', exact: true }).selectOption('percent');
  await chart.getByText('Show values as a table', { exact: true }).click();
  await feature.selectOption('gallery_downloads');
  await expect(chart.locator('tbody tr').last()).toContainText('100% (1/1)');
  await feature.selectOption('gallery_downloads_restricted');
  await expect(chart.locator('tbody tr').last()).toContainText('0% (0/1)');
  await expect(chart).toContainText('Older values are never inverted or converted');
  await chart.getByLabel('Language / Sprache').selectOption('de');
  await expect(chart).toContainText('Galerie-Downloads eingeschränkt');
  await expect(chart.getByRole('heading', { name: 'Konfigurierte Funktion · Galerie-Downloads eingeschränkt', exact: true })).toBeVisible();
  const germanFeature = chart.getByRole('combobox', { name: 'Funktion', exact: true });
  await expect(germanFeature.locator('option')).toHaveCount(87);
  await germanFeature.selectOption('gallery_downloads');
  await expect(chart.getByRole('heading', { name: 'Konfigurierte Funktion · Galerie-Downloads erlaubt', exact: true })).toBeVisible();
  await expect(chart.locator('tbody tr').last()).toContainText('100% (1/1)');
});

async function holdResponse(page: Page, pattern: string) {
  let release!: () => void, ready!: () => void, done!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    ready();
    await gate;
    try {
      await route.fulfill({ response });
    } catch {
      /* cancellation is expected after logout */
    } finally {
      done();
    }
  });
  return {
    reached,
    release: async () => {
      release();
      await finished;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    },
  };
}

test("S01: a late raw-packet response cannot restore data or the hash after sign-out", async ({
  page,
  collector,
}) => {
  await unlock(page, collector);
  const held = await holdResponse(page, "**/api/participant/packets");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Your packets" })
    .click();
  await held.reached;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Installation lookup hash")).toBeVisible();
  await held.release();
  await expect(
    page.getByRole("button", { name: "Download all as JSON" }),
  ).toHaveCount(0);
  await expect(page.locator("pre")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    collector.identity.installation_id,
  );
});

test("S01: signing out also cancels a pending authenticated file save", async ({
  page,
  collector,
}) => {
  await unlock(page, collector);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Your packets" })
    .click();
  await expect(
    page.getByRole("heading", { name: "1 report shown" }),
  ).toBeVisible();
  const held = await holdResponse(page, "**/api/participant/raw-export");
  const downloads: unknown[] = [];
  page.on("download", (value) => downloads.push(value));
  await page.getByRole("button", { name: "Download all as JSON" }).click();
  await held.reached;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await held.release();
  expect(downloads).toHaveLength(0);
  await expect(page.locator("pre")).toHaveCount(0);
});

test("S01: a late maintainer reload cannot restore private inbox state after logout", async ({
  page,
  collector,
}) => {
  await page.goto(`${collector.url}/maintainer`);
  await page.getByLabel("Maintainer access token").fill(SECRET);
  await page.getByRole("button", { name: "Open maintainer workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Synthetic request", exact: true }),
  ).toBeVisible();
  const held = await holdResponse(page, "**/api/maintainer/feedback");
  await page.getByRole("button", { name: "Save review" }).click();
  await held.reached;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await held.release();
  await expect(page.getByLabel("Maintainer access token")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Synthetic request", exact: true }),
  ).toHaveCount(0);
});

test("T03/T04: raw download contains all reports and a dated audit receipt", async ({
  page,
  collector,
}) => {
  await unlock(page, collector);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Your packets" })
    .click();
  await expect(
    page.getByRole("heading", { name: "1 report shown" }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all as JSON" }).click();
  const download = await downloading;
  const value = JSON.parse(await fs.readFile((await download.path())!, "utf8"));
  expect(value.installation_id).toBe(collector.identity.installation_id);
  expect(value.packets).toHaveLength(1);
  expect(value.export_receipt.packet_count).toBe(1);
  expect(value.export_receipt.scope).toBe("unique accepted usage reports");
  expect(value.export_receipt.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("stored HTML remains text and the portal loads no third-party resources", async ({
  page,
  collector,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(collector.url)) external.push(request.url());
  });
  await page.goto(`${collector.url}/requests`);
  await expect(page.getByText(html, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Boolean((window as any).__injected))).toBe(
    false,
  );
  expect(external).toEqual([]);
});

test("S04: bounded public lists remain fully navigable", async ({
  page,
  collector,
}) => {
  await collector.db.batchInsert(
    "feedback",
    Array.from({ length: 205 }, (_, n) => ({
      id: crypto.randomUUID(),
      installation_id: collector.identity.installation_id,
      kind: "feature_request",
      title: `Synthetic page ${n}`,
      body: "Pagination",
      name: "",
      allow_public: 1,
      allow_marketing: 0,
      published: 1,
      status: "open",
      created_at: new Date().toISOString(),
    })),
    50,
  );
  await page.goto(`${collector.url}/requests`);
  await expect(page.locator("article.request")).toHaveCount(200);
  await page.getByRole("button", { name: "Load more requests" }).click();
  await expect(page.locator("article.request")).toHaveCount(206);
  await expect(
    page.getByRole("button", { name: "Load more requests" }),
  ).toHaveCount(0);
});

test("session sign-in keeps reading after the original voting deadline and clears both credentials on sign-out", async ({ page, collector }) => {
  const session = await collector.send("session", 3);
  // Opening a ten-minute-old session must not grant another fifteen minutes.
  collector.clock.offset += 10 * 60 * 1000;
  await page.clock.install({ time: new Date(Date.now() + collector.clock.offset) });
  const readingCredentials: string[] = [];
  page.on("request", request => {
    if (/\/api\/participant\/(summary|history)$/.test(new URL(request.url()).pathname)) {
      readingCredentials.push(request.headers().authorization);
    }
  });
  await page.goto(`${collector.url}/#connect=${session.session_token}`);
  await expect(page.getByText("You are connected for voting.", { exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Your packets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "1 report shown" })).toBeVisible();
  await expect(page.getByLabel("Installation lookup hash")).toHaveCount(0);
  await nav.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What’s being used" })).toBeVisible();
  await page.locator(".usage-history").getByRole("combobox", { name: "Reporters", exact: true }).selectOption("own");
  collector.clock.offset += 5 * 60 * 1000 + 2000;
  await page.clock.fastForward(5 * 60 * 1000 + 2000);
  await expect(nav.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "Feature requests", exact: true }).click();
  await expect(page.getByText("Voting needs a connected session.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vote for Synthetic request", exact: true })).toBeDisabled();
  await nav.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What’s being used" })).toBeVisible();
  expect(readingCredentials.length).toBeGreaterThan(1);
  expect(readingCredentials.every(value => value === `Bearer ${collector.identity.installation_id}`)).toBe(true);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, ""]);
  await nav.getByRole("link", { name: "Your packets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "1 report shown" })).toBeVisible();
  await nav.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Installation lookup hash")).toBeVisible();
  await nav.getByRole("link", { name: "Feature requests", exact: true }).click();
  await expect(page.getByText("Voting needs a connected session.", { exact: true })).toBeVisible();
  const fresh = await collector.send("session", 4);
  await page.goto(`${collector.url}/#connect=${fresh.session_token}`);
  await expect(page.getByText("You are connected for voting.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(nav.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  await nav.getByRole("link", { name: "Your packets", exact: true }).click();
  await expect(page.getByLabel("Installation lookup hash")).toBeVisible();
});

test("an expired vote removes voting access without discarding the reading hash", async ({ page, collector }) => {
  const session = await collector.send("session", 3);
  await page.goto(`${collector.url}/#connect=${session.session_token}`);
  const vote = page.getByRole("button", { name: "Vote for Synthetic request", exact: true });
  await expect(vote).toBeEnabled();
  // The server expires first (clock skew or a suspended browser timer).
  collector.clock.offset += 16 * 60 * 1000;
  await vote.click();
  await expect(page.getByText("Voting needs a connected session.", { exact: true })).toBeVisible();
  await expect(vote).toBeDisabled();
  await page.getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What’s being used" })).toBeVisible();
});

test("an expired connect link never unlocks reading or voting", async ({ page, collector }) => {
  const session = await collector.send("session", 3);
  collector.clock.offset += 16 * 60 * 1000;
  await page.goto(`${collector.url}/#connect=${session.session_token}`);
  await expect(page.getByRole("alert")).toContainText("expired or is invalid");
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByLabel("Installation lookup hash")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
});

test("a late connect response cannot restore either credential after manual sign-in and sign-out", async ({ page, collector }) => {
  const session = await collector.send("session", 3);
  const held = await holdResponse(page, "**/api/participant/session");
  await page.goto(`${collector.url}/#connect=${session.session_token}`);
  await held.reached;
  await page.getByLabel("Installation lookup hash").fill(collector.identity.installation_id);
  await page.getByRole("button", { name: "Open the dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What’s being used" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await held.release();
  await expect(page.getByLabel("Installation lookup hash")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

async function seedHistory(collector: any) {
  const second = p.generateIdentity();
  await collector.c.receive(p.signPacket(p.makePacket(second, "register", 0, { consent_version: p.CURRENT_CONSENT_VERSION }), second));
  const date = (ago: number) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
  for (const [identity, ago, used] of [
    [collector.identity, 60, false], [collector.identity, 2, false],
    [collector.identity, 1, true], [second, 2, false], [second, 0, true],
  ] as const) {
    const envelope = p.signPacket(p.makePacket(identity, "report", 1, {
      picpeak_version: ago > 1 ? "1.1.0" : "1.2.3", report_date: date(ago),
      inventory: { galleries: 0, photos: 0 },
      generated_at: `${date(ago)}T12:00:00.000Z`, gallery_layouts: ["grid"],
      features: { ...p.emptyFeatures(), crm: { configured: used, used } },
    }), identity);
    await collector.db("reports").insert({
      packet_id: envelope.packet.packet_id, installation_id: identity.installation_id,
      report_date: date(ago), raw: JSON.stringify(envelope), received_at: `${date(ago)}T12:00:00.000Z`,
    });
  }
  await collector.c.bumpRevision(collector.db);
  return { second, date };
}

for (const width of [1280, 390]) test(`inventory at ${width}px: totals, unknown history, own scope and German labels`, async ({ page, collector }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const { date } = await seedHistory(collector);
  // Give the second reporter a nonzero inventory today; the original reporter
  // has an explicitly reported zero. Make the earliest retained report v2 so
  // the graph must show a gap, not zero, before inventory consent existed.
  const rows = await collector.db('reports').select('*');
  for (const row of rows) {
    const e = JSON.parse(row.raw);
    if (row.report_date === date(60)) {
      e.packet.schema_version = 'usage.v2';
      e.packet.payload.features = p.emptyFeatures('usage.v2');
      delete e.packet.payload.inventory;
    } else if (row.report_date === date(0) && row.installation_id !== collector.identity.installation_id) {
      e.packet.payload.inventory = { galleries: 12, photos: 125 };
    }
    await collector.db('reports').where({ packet_id: row.packet_id }).update({ raw: JSON.stringify(e) });
  }
  await collector.c.bumpRevision(collector.db);
  await unlock(page, collector);
  const chart = page.locator('.usage-history');
  await chart.getByRole('combobox', { name: 'Metric', exact: true }).selectOption('photos');
  await chart.getByText('Show values as a table', { exact: true }).click();
  await expect(chart.getByRole('row').last().getByRole('cell').nth(3)).toHaveText('125');
  await expect(chart.getByRole('row').last().getByRole('cell').nth(4)).toHaveText('2');
  await expect(chart.getByRole('combobox', { name: 'Display', exact: true })).toHaveCount(0);
  await chart.getByRole('combobox', { name: 'Reporters', exact: true }).selectOption('own');
  await expect(chart.getByRole('row').last().getByRole('cell').nth(3)).toHaveText('0');
  await chart.getByRole('combobox', { name: 'Date range', exact: true }).selectOption('all');
  await expect(chart.getByRole('row').nth(1).getByRole('cell').nth(3)).toHaveText('Not reported');
  await chart.getByLabel('Language / Sprache').selectOption('de');
  await expect(chart.getByRole('columnheader', { name: 'Gespeicherte Fotoeinträge', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await chart.screenshot({ path: testInfo.outputPath(`inventory-${width}.png`) });
});

for (const width of [1280, 390]) {
  test(`history at ${width}px: participant compares all reporters with own and exports the complete selected range`, async ({ page, collector }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { date } = await seedHistory(collector);
    await unlock(page, collector);
    const chart = page.locator(".usage-history");
    await chart.getByRole("combobox", { name: "Metric", exact: true }).selectOption("used");
    await chart.getByRole("combobox", { name: "Capability", exact: true }).selectOption("crm");
    await chart.getByText("Show values as a table", { exact: true }).click();
    await expect(chart.getByRole("row").last()).toContainText("50% (1/2)");
    await chart.getByRole("combobox", { name: "Reporters", exact: true }).selectOption("own");
    await expect(chart.getByRole("row").last()).toContainText("0% (0/1)");
    await chart.getByRole("combobox", { name: "Reporters", exact: true }).selectOption("all");
    await expect(chart.getByRole("row").last()).toContainText("50% (1/2)");
    await chart.getByRole("combobox", { name: "Capability", exact: true }).selectOption("gallery_guest_uploads");
    await expect(chart).toContainText("Actual use is not collected for this capability");
    await chart.getByRole("combobox", { name: "Metric", exact: true }).selectOption("reporters");
    await chart.getByRole("combobox", { name: "Date range", exact: true }).selectOption("all");
    await expect(chart.getByRole("combobox", { name: "Group by", exact: true })).toHaveValue("month");
    await expect(chart.getByRole("row").nth(1)).toContainText(date(60));
    const downloading = page.waitForEvent("download");
    await chart.getByRole("button", { name: "Download history (JSON)", exact: true }).click();
    const value = JSON.parse(await fs.readFile((await (await downloading).path())!, "utf8"));
    expect(value.from).toBe(date(60));
    expect(value.points.reduce((n: number, point: any) => n + point.reports, 0)).toBe(6);
    expect(JSON.stringify(value)).not.toContain(collector.identity.installation_id);
    await chart.getByLabel("Language / Sprache").selectOption("de");
    await expect(chart.getByRole("heading", { name: "Nutzung im Zeitverlauf" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await chart.screenshot({ path: testInfo.outputPath(`participant-history-${width}.png`) });
  });

  test(`maintainer at ${width}px: no participant login needed for all reporters, raw reports and complete export`, async ({ page, collector }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await seedHistory(collector);
    await page.goto(`${collector.url}/maintainer`);
    await page.getByLabel("Maintainer access token").fill(SECRET);
    await page.getByRole("button", { name: "Open maintainer workspace" }).click();
    await expect(page.getByRole("heading", { name: "Reporter directory", exact: true })).toBeVisible();
    const rows = page.locator(".reporter-directory table tbody tr");
    await expect(rows).toHaveCount(2);
    await rows.filter({ hasText: collector.identity.installation_id }).getByRole("button", { name: "Inspect reporter" }).click();
    const detail = page.locator(".reporter-details");
    await expect(detail.locator("details")).toHaveCount(5);
    await detail.locator("details").nth(1).locator("summary").click();
    await expect(detail.locator("pre").last()).toContainText('"signature_verified": true');
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export all contributions (NDJSON)" }).click();
    const exported = await fs.readFile((await (await downloading).path())!, "utf8");
    const records = exported.trim().split("\n").map((line: string) => JSON.parse(line));
    expect(records.filter((row: any) => row.type === "reporter")).toHaveLength(2);
    expect(records.filter((row: any) => row.type === "report")).toHaveLength(6);
    expect(records.at(-1).type).toBe("export_receipt");
    await page.getByLabel("Language / Sprache").selectOption("de");
    await expect(page.getByRole("heading", { name: "Alle gemeldeten Daten" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator(".maintainer-data").screenshot({ path: testInfo.outputPath(`maintainer-data-${width}.png`) });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.locator(".maintainer-data")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(collector.identity.installation_id);
  });
}

test("a pending maintainer export is cancelled on sign-out", async ({ page, collector }) => {
  await page.goto(`${collector.url}/maintainer`);
  await page.getByLabel("Maintainer access token").fill(SECRET);
  await page.getByRole("button", { name: "Open maintainer workspace" }).click();
  await expect(page.getByRole("heading", { name: "Reporter directory" })).toBeVisible();
  const held = await holdResponse(page, "**/api/maintainer/export");
  const downloads: unknown[] = [];
  page.on("download", (value) => downloads.push(value));
  await page.getByRole("button", { name: "Export all contributions (NDJSON)" }).click();
  await held.reached;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await held.release();
  expect(downloads).toHaveLength(0);
  await expect(page.locator(".maintainer-data")).toHaveCount(0);
});
