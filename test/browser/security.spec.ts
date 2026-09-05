import { test as base, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
const { createDatabase, migrate } = require("../../server/database");
const { createApp } = require("../../server/app");
const p = require("../../protocol/protocol.cjs");
const crypto = require("node:crypto");
const SECRET = "browser-security-fixture-only-123456789012345";
const html = '<img src=x onerror="window.__injected=true">';

const test = base.extend<{ collector: any }>({
  collector: async ({}, use) => {
    const db = createDatabase({ DATABASE_PATH: ":memory:" });
    await migrate(db);
    const app = createApp({
      db,
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
        ),
      );
    await send("register", 0, { consent_version: "usage-consent.v1" });
    const iso = new Date().toISOString();
    await send("report", 1, {
      picpeak_version: "1.2.3",
      report_date: iso.slice(0, 10),
      generated_at: iso,
      gallery_layouts: ["grid"],
      features: Object.fromEntries(
        p.FEATURE_KEYS.map((key: string) => [
          key,
          { configured: false, used: false },
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
  await page.getByRole("button", { name: "Open feedback inbox" }).click();
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
