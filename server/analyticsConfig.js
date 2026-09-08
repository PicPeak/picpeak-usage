"use strict";

function parseAnalyticsConfig(env) {
  const scriptUrl = env.UMAMI_SCRIPT_URL?.trim();
  const websiteId = env.UMAMI_WEBSITE_ID?.trim();
  if (!scriptUrl && !websiteId) return null;
  if (!scriptUrl || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(websiteId || ""))
    throw new Error("Set UMAMI_SCRIPT_URL and a valid UMAMI_WEBSITE_ID together");
  const script = new URL(scriptUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(script.hostname);
  if ((script.protocol !== "https:" && !(local && script.protocol === "http:")) ||
      script.username || script.password || script.search || script.hash)
    throw new Error("UMAMI_SCRIPT_URL must be an HTTPS script URL without credentials, query or fragment");
  const domains = (env.UMAMI_DOMAINS || "usage.picpeak.app").split(",").map(value => value.trim().toLowerCase());
  if (domains.some(domain => !/^[a-z0-9.-]+$/.test(domain) || domain.length > 253 ||
      domain.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))))
    throw new Error("UMAMI_DOMAINS must contain comma-separated hostnames");
  return { scriptUrl: script.href, websiteId, domains };
}

function readAnalyticsConfig(env = process.env) {
  try { return parseAnalyticsConfig(env); }
  catch (error) {
    throw Object.assign(new Error(`Invalid Umami configuration: ${error.message}`), { code: "ANALYTICS_CONFIG" });
  }
}

module.exports = { readAnalyticsConfig };
