const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function tracker(site = "usage") {
  const location = new URL(site === "usage" ? "https://usage.picpeak.app/" : "https://www.picpeak.app/en/");
  const handlers = {};
  const context = { URL, URLSearchParams, Promise, setTimeout, location, navigator: {}, localStorage: { getItem: () => null },
    document: { currentScript: { getAttribute: () => site }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    window: { addEventListener: (name, handler) => { handlers[name] = handler; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/analytics-privacy.js"), "utf8"), context);
  const send = (overrides = {}, type = "event") => context.window.picpeakUmamiBeforeSend(type, {
    website: "11111111-1111-4111-8111-111111111111", hostname: location.hostname,
    language: "en-US", screen: "1440x900", title: "PicPeak", url: location.pathname, ...overrides,
  });
  return { context, handlers, send };
}

test("keeps page and campaign metrics but strips credentials, fragments and arbitrary data", () => {
  const { send } = tracker();
  const page = "usage" === "usage" ? "/requests" : "/en/features";
  const result = send({ url: page + "?connect=SECRET&token=SECRET&feedback=PRIVATE&utm_source=newsletter&utm_campaign=launch#connect=SECRET",
    referrer: "https://example.test/private/SECRET?token=SECRET#SECRET", id: "PRIVATE", data: { email: "PRIVATE" } });
  assert.equal(result.url, page + "?utm_source=newsletter&utm_campaign=launch");
  assert.equal(result.referrer, "https://example.test");
  assert.equal(result.screen, "1440x900");
  assert.equal(result.language, "en-US");
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("counts real navigation and back visits, without duplicating filtered URL changes", () => {
  const { send } = tracker();
  const a = "usage" === "usage" ? "/" : "/en";
  const b = "usage" === "usage" ? "/transparency" : "/de/faq";
  assert.ok(send({ url: a }));
  assert.equal(send({ url: a + "?token=SECRET#anything" }), false);
  assert.ok(send({ url: b }));
  assert.ok(send({ url: a }));
});

test("drops unknown page paths and session identification", () => {
  const { send } = tracker();
  assert.equal(send({ url: "/PRIVATE-LOOKUP-HASH" }), false);
  assert.equal(send({ id: "PRIVATE" }, "identify"), false);
  assert.equal(send({ name: "Private feedback text" }), false);
  assert.equal(send({ url: "https://foreign.test/" }), false);
});

test("honors browser privacy choices and exact production domain restrictions", () => {
  for (const privacy of ["dnt", "gpc", "optout"]) {
    const { context, send } = tracker();
    if (privacy === "dnt") context.navigator.doNotTrack = "1";
    if (privacy === "gpc") context.navigator.globalPrivacyControl = true;
    if (privacy === "optout") context.localStorage.getItem = () => "1";
    assert.equal(context.window.picpeakAnalyticsAllowed([context.location.hostname]), false);
    assert.equal(send(), false);
  }
  const { context } = tracker();
  assert.equal(context.window.picpeakAnalyticsAllowed([context.location.hostname]), true);
  assert.equal(context.window.picpeakAnalyticsAllowed(["localhost"]), false);
  context.localStorage.getItem = () => { throw new Error("storage unavailable"); };
  assert.equal(context.window.picpeakAnalyticsAllowed([context.location.hostname]), true);
});

test("click analytics never waits for or prevents navigation", () => {
  const { context, handlers, send } = tracker();
  let tracked;
  context.window.umami = { track: build => { tracked = build({}).name; return new Promise(() => {}); } };
  let prevented = false;
  handlers.click({ target: { closest: () => ({ getAttribute: () => "Open GitHub" }) }, preventDefault: () => { prevented = true; } });
  assert.equal(tracked, "Open GitHub");
  assert.equal(prevented, false);
  assert.equal(send({ name: "Open GitHub", data: { token: "SECRET" } }).name, "Open GitHub");
  context.window.umami.track = () => { throw new Error("blocked"); };
  assert.doesNotThrow(() => handlers.click({ target: { closest: () => ({ getAttribute: () => "Open GitHub" }) } }));
});
