"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const DAY = 86400000;
const WEEK = 7 * DAY;
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function invalid(key, reason) {
  const error = new Error(`Weekly report configuration: ${key} ${reason}`);
  error.code = "WEEKLY_CONFIG";
  throw error;
}
function integer(env, key, fallback, min, max) {
  const value = env[key] || String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    invalid(key, `must be an integer between ${min} and ${max}`);
  return Number(value);
}
function address(value, key) {
  // Plain mailbox addresses only. Display names are configured separately.
  if (!value || value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value))
    invalid(key, "must contain a plain email address");
  return value;
}
function readWeeklyConfig(env = process.env) {
  if (![undefined, "", "false", "true"].includes(env.WEEKLY_REPORT_ENABLED))
    invalid("WEEKLY_REPORT_ENABLED", "must be true or false");
  if (env.WEEKLY_REPORT_ENABLED !== "true") return { enabled: false };
  if (!env.MAINTAINER_TOKEN || env.MAINTAINER_TOKEN.length < 32)
    invalid("MAINTAINER_TOKEN", "must be configured for protected report links");
  const host = env.SMTP_HOST?.trim();
  if (!host || /[\s\x00-\x1f]/.test(host)) invalid("SMTP_HOST", "is required");
  const mode = env.SMTP_TLS_MODE || "starttls";
  if (!["starttls", "tls", "none"].includes(mode)) invalid("SMTP_TLS_MODE", "must be starttls, tls or none");
  const username = env.SMTP_USER || "", password = env.SMTP_PASSWORD || "";
  if (Boolean(username) !== Boolean(password)) invalid("SMTP_USER / SMTP_PASSWORD", "must both be set or both be empty");
  const authMethod = env.SMTP_AUTH_METHOD || undefined;
  if (authMethod && !["PLAIN", "LOGIN", "CRAM-MD5"].includes(authMethod)) invalid("SMTP_AUTH_METHOD", "must be PLAIN, LOGIN or CRAM-MD5");
  const recipients = [...new Set((env.WEEKLY_REPORT_TO || "").split(",").map(value => value.trim()).filter(Boolean))];
  if (!recipients.length || recipients.length > 20) invalid("WEEKLY_REPORT_TO", "must list 1–20 trusted maintainer email addresses");
  recipients.forEach(value => address(value, "WEEKLY_REPORT_TO"));
  const from = address(env.SMTP_FROM?.trim(), "SMTP_FROM");
  const fromName = env.SMTP_FROM_NAME || "PicPeak Usage";
  if (/[\x00-\x1f]/.test(fromName) || fromName.length > 100) invalid("SMTP_FROM_NAME", "must be a single display name");
  const replyTo = env.SMTP_REPLY_TO ? address(env.SMTP_REPLY_TO.trim(), "SMTP_REPLY_TO") : undefined;
  let base;
  try { base = new URL(env.WEEKLY_REPORT_BASE_URL || "https://usage.picpeak.app"); }
  catch { invalid("WEEKLY_REPORT_BASE_URL", "must be an absolute portal URL"); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))))
    invalid("WEEKLY_REPORT_BASE_URL", "must be an HTTPS origin (HTTP loopback is allowed locally)");
  const language = env.WEEKLY_REPORT_LANGUAGE || "en";
  if (!["en", "de"].includes(language)) invalid("WEEKLY_REPORT_LANGUAGE", "must be en or de");
  const day = DAYS.indexOf((env.WEEKLY_REPORT_DAY || "monday").toLowerCase());
  if (day < 0) invalid("WEEKLY_REPORT_DAY", "must be a weekday name in English");
  const time = env.WEEKLY_REPORT_TIME || "08:00";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) invalid("WEEKLY_REPORT_TIME", "must be HH:MM in UTC");
  const [hour, minute] = time.split(":").map(Number);
  const timeout = integer(env, "SMTP_TIMEOUT_MS", 30000, 1000, 120000);
  let ca;
  if (env.SMTP_CA_FILE) {
    try { ca = fs.readFileSync(env.SMTP_CA_FILE, "utf8"); }
    catch { invalid("SMTP_CA_FILE", "must be a readable PEM CA certificate file"); }
  }
  const servername = env.SMTP_TLS_SERVERNAME || host;
  if (/[\s\x00-\x1f]/.test(servername)) invalid("SMTP_TLS_SERVERNAME", "must be a TLS hostname");
  return {
    enabled: true, recipients, from: { name: fromName, address: from }, replyTo,
    baseUrl: base.origin, language, scheduleOffset: day * DAY + (hour * 60 + minute) * 60000,
    smtp: {
      host, port: integer(env, "SMTP_PORT", mode === "tls" ? 465 : 587, 1, 65535),
      secure: mode === "tls", requireTLS: mode === "starttls", ignoreTLS: mode === "none",
      ...(username ? { auth: { user: username, pass: password }, authMethod } : {}),
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", servername, ...(ca ? { ca } : {}) },
      connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    },
  };
}
function weekStart(now) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.getTime();
}
function firstPeriodEnd(now, config) {
  const start = weekStart(now);
  return start + (now > start + config.scheduleOffset ? WEEK : 0);
}
const recipientId = value => crypto.createHash("sha256").update(value).digest("hex");
module.exports = { readWeeklyConfig, weekStart, firstPeriodEnd, recipientId, DAY, WEEK };
