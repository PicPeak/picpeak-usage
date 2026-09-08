import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
const { createDatabase, migrate } = require("../../server/database");
const { createApp } = require("../../server/app");
const tracker = process.env.UMAMI_TRACKER_FIXTURE
  ? fs.readFileSync(process.env.UMAMI_TRACKER_FIXTURE, "utf8")
  : require("../helpers/umamiTracker.cjs");
const websiteId = "11111111-1111-4111-8111-111111111111";
const config = { scriptUrl: "https://analytics.example.test/script.js", websiteId, domains: ["127.0.0.1"] };

const test = base.extend<{ portal: { url: string }; packets: any[] }>({
  portal: async ({}, use) => {
    const db = createDatabase({ DATABASE_PATH: ":memory:" });
    await migrate(db);
    const app = createApp({ db, analyticsConfig: config, disableRateLimit: true });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try { await use({ url: `http://127.0.0.1:${server.address().port}` }); }
    finally { await new Promise<void>(resolve => server.close(resolve)); await db.destroy(); }
  },
  packets: async ({ page }, use) => {
    const packets: any[] = [];
    await page.route("https://analytics.example.test/**", async route => {
      if (route.request().url().endsWith("/script.js")) {
        await route.fulfill({ contentType: "application/javascript", body: tracker });
      } else {
        packets.push(route.request().postDataJSON().payload);
        await route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
      }
    });
    await use(packets);
  },
});

test("runtime configuration tracks SPA navigation, back/forward and sanitized attribution once", async ({ page, portal, packets }) => {
  await page.goto(`${portal.url}/?token=PRIVATE&utm_source=newsletter&utm_campaign=launch#PRIVATE`, {
    referer: "https://source.example.test/private?token=PRIVATE",
  });
  await expect.poll(() => packets.length).toBe(1);
  expect(packets[0]).toMatchObject({ website: websiteId, url: "/?utm_source=newsletter&utm_campaign=launch", referrer: "https://source.example.test" });
  for (const path of ["/requests", "/transparency"]) {
    await page.locator(`header nav a[href="${path}"]`).click();
    await expect.poll(() => packets.at(-1)?.url).toBe(path);
  }
  await page.goBack();
  await expect.poll(() => packets.at(-1)?.url).toBe("/requests");
  await page.goForward();
  await expect.poll(() => packets.at(-1)?.url).toBe("/transparency");
  expect(packets).toHaveLength(5);
  expect(await page.locator("#picpeak-umami").count()).toBe(1);
  expect(JSON.stringify(packets)).not.toContain("PRIVATE");
});

test("private links contribute a page name without any access or feedback identifiers", async ({ page, portal, packets }) => {
  await page.goto(`${portal.url}/maintainer?feedback=PRIVATE&lookup=PRIVATE#connect=PRIVATE`);
  await expect.poll(() => packets.length).toBe(1);
  expect(packets[0].url).toBe("/maintainer");
  expect(JSON.stringify(packets)).not.toContain("PRIVATE");
});

for (const setting of ["dnt", "gpc", "optout", "domain"]) {
  test(`does not load Umami with ${setting} excluded`, async ({ page, portal, packets }) => {
    await page.addInitScript(setting => {
      if (setting === "dnt") Object.defineProperty(navigator, "doNotTrack", { value: "1" });
      if (setting === "gpc") Object.defineProperty(navigator, "globalPrivacyControl", { value: true });
      if (setting === "optout") localStorage.setItem("umami.disabled", "1");
    }, setting);
    if (setting === "domain") await page.route("**/api/public/analytics-config", route => route.fulfill({ json: { ...config, domains: ["usage.picpeak.app"] } }));
    await page.goto(portal.url);
    await page.waitForFunction(() => typeof (window as any).picpeakAnalyticsAllowed === "function");
    await expect(page.locator("#picpeak-umami")).toHaveCount(0);
    expect(packets).toHaveLength(0);
    await page.locator('header nav a[href="/requests"]').click();
    await expect(page).toHaveURL(`${portal.url}/requests`);
  });
}

test("an unavailable tracker does not break navigation", async ({ page, portal }) => {
  await page.route("https://analytics.example.test/**", route => route.abort());
  await page.goto(portal.url);
  await page.locator('header nav a[href="/transparency"]').click();
  await expect(page.getByRole("heading", { name: "Website visitor statistics" })).toBeVisible();
});

test("click tracking records the action without waiting on the analytics server", async ({ page, portal, packets }) => {
  await page.goto(portal.url);
  await expect.poll(() => packets.length).toBe(1);
  let event;
  await page.route("https://analytics.example.test/api/send", async route => {
    event = route.request().postDataJSON().payload;
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" }).catch(() => {});
  });
  await page.route("https://www.picpeak.app/", route => route.fulfill({ contentType: "text/html", body: "<h1>Website fixture</h1>" }));
  await page.locator('header a[href="https://www.picpeak.app"]').click({ timeout: 1000 });
  await expect(page).toHaveURL("https://www.picpeak.app/");
  await expect.poll(() => event?.name).toBe("Open website");
});
