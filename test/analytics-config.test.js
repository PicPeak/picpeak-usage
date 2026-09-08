const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { readAnalyticsConfig } = require("../server/analyticsConfig");
const { createApp } = require("../server/app");
const valid = { UMAMI_SCRIPT_URL: "https://stats.example.test/script.js", UMAMI_WEBSITE_ID: "11111111-1111-4111-8111-111111111111" };

test("analytics is opt-in and rejects incomplete or unsafe configuration", () => {
  assert.equal(readAnalyticsConfig({}), null);
  for (const env of [{ UMAMI_SCRIPT_URL: valid.UMAMI_SCRIPT_URL }, { UMAMI_WEBSITE_ID: valid.UMAMI_WEBSITE_ID },
    { ...valid, UMAMI_SCRIPT_URL: "javascript:alert(1)" }, { ...valid, UMAMI_SCRIPT_URL: "http://stats.example.test/script.js" },
    { ...valid, UMAMI_SCRIPT_URL: "https://user:password@stats.example.test/script.js" },
    { ...valid, UMAMI_SCRIPT_URL: "https://stats.example.test/script.js?secret=x" },
    { ...valid, UMAMI_DOMAINS: "example.test/path" }, { ...valid, UMAMI_DOMAINS: "*.example.test" }]) {
    assert.throws(() => readAnalyticsConfig(env));
  }
});

test("runtime config exposes only public fields and permits only the configured CSP origin", async () => {
  const config = readAnalyticsConfig({ ...valid, MAINTAINER_TOKEN: "PRIVATE", SESSION_SECRET: "PRIVATE" });
  const app = createApp({ db: {}, analyticsConfig: config, disableRateLimit: true });
  const response = await request(app).get("/api/public/analytics-config").expect(200);
  assert.deepEqual(response.body, { scriptUrl: valid.UMAMI_SCRIPT_URL, websiteId: valid.UMAMI_WEBSITE_ID, domains: ["usage.picpeak.app"] });
  assert.equal(response.headers["cache-control"], "no-store");
  for (const directive of ["script-src", "connect-src"]) {
    assert.ok(response.headers["content-security-policy"].includes(directive + " 'self' https://stats.example.test"));
  }
  assert.ok(!response.text.includes("PRIVATE"));
});

test("disabled analytics leaves the original self-only CSP intact", async () => {
  const app = createApp({ db: {}, analyticsConfig: null, disableRateLimit: true });
  const response = await request(app).get("/api/public/analytics-config").expect(200);
  assert.equal(response.body, null);
  assert.match(response.headers["content-security-policy"], /script-src 'self';/);
  assert.match(response.headers["content-security-policy"], /connect-src 'self'(;|$)/);
});
