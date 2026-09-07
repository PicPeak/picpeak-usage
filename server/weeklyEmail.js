"use strict";
const messages = require("./weeklyMessages.json");
const catalog = require("../protocol/features.v5.json");
const german = require("../web/locales/catalog.de.json");
const { DAY } = require("./weeklyConfig");
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const colors = { ground: "#f2f8f5", surface: "#e6f0ec", line: "#c5d8cd", ink: "#123b30", muted: "#49685d", primary: "#175b49" };

function feedbackChunk(rows) {
  const selected = [];
  let bytes = 0;
  for (const item of rows) {
    const size = Buffer.byteLength(escape(item.title) + escape(item.body) + escape(item.name)) + 2000;
    if (selected.length && (bytes + size > 48000 || selected.length >= 10)) break;
    selected.push(item); bytes += size;
  }
  return { feedback: selected, hasMore: selected.length < rows.length };
}

function renderWeeklyEmail(data, config, part = 1) {
  const t = messages[config.language];
  const n = value => value === null ? t.unknown : value.toLocaleString(config.language, { maximumFractionDigits: 1 });
  const signed = value => `${value > 0 ? "+" : ""}${n(value)}`;
  const featureName = key => config.language === "de" ? german.features[key].name : catalog.features[key].name.en;
  const url = (path = "", query = "", hash = "") => `${config.baseUrl}/maintainer${path}${query}${hash}`;
  const featureUrl = key => url("", `?feature=${encodeURIComponent(key)}`, "#history");
  const period = `${data.from.slice(0, 10)} – ${new Date(Date.parse(data.to) - DAY).toISOString().slice(0, 10)}`;
  const chunk = feedbackChunk(data.feedback);
  const introText = [`PicPeak ${t.brand}`, t.title, `${t.period}: ${period}`, `${t.part} ${part}`, "", t.intro, url(), ""];
  const text = [t.participation,
    `${t.joined}: ${n(data.joined)}`, `${t.removed}: ${n(data.removed)}`, `${t.registered}: ${n(data.registered)}`, t.installationsNote,
    ...(data.partialActivity ? [t.partialActivity] : []), "", t.data];
  const link = (label, href) => `<a href="${escape(href)}" style="color:${colors.primary};text-decoration:underline">${escape(label)}</a>`;
  const button = (label, href) => `<a href="${escape(href)}" style="display:inline-block;background:${colors.primary};color:#ffffff;padding:12px 20px;border-radius:8px;font-weight:bold;text-decoration:none;line-height:1.5">${escape(label)}</a>`;
  const p = value => `<p style="margin:12px 0;color:${colors.muted};line-height:1.65">${escape(value)}</p>`;
  const h2 = value => `<h2 style="font-family:'Schibsted Grotesk',Arial,sans-serif;font-size:23px;line-height:1.25;margin:0 0 18px;color:${colors.ink}">${escape(value)}</h2>`;
  const card = content => `<tr><td style="padding:0 24px 24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${colors.line};border-radius:8px"><tr><td style="padding:24px">${content}</td></tr></table></td></tr>`;
  const stat = (label, value, detail = "") => `<tr><td style="padding:12px;border-bottom:1px solid ${colors.line};vertical-align:top">${escape(label)}${detail ? `<br><span style="font-size:13px;color:${colors.muted}">${escape(detail)}</span>` : ""}</td><td style="padding:12px;border-bottom:1px solid ${colors.line};text-align:right;vertical-align:top;font-weight:bold;font-size:22px;color:${colors.primary}">${escape(value)}</td></tr>`;
  const stats = rows => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${colors.surface};border-radius:8px">${rows}</table>`;
  let html = `<!doctype html><html lang="${t.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(t.subject)}</title></head><body style="margin:0;padding:0;background:${colors.ground};color:${colors.ink};font-family:'Source Sans 3',Arial,sans-serif;font-size:16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${colors.ground}"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:720px;text-align:left"><tr><td style="padding:32px 24px;font-size:22px;color:${colors.primary}"><strong>PicPeak</strong> ${escape(t.brand)}</td></tr><tr><td style="padding:16px 24px 32px"><p style="text-transform:uppercase;letter-spacing:1.5px;font-size:12px;color:${colors.muted};margin:0 0 16px">${escape(t.eyebrow)} · ${escape(t.part)} ${part}</p><h1 style="font-family:'Schibsted Grotesk',Arial,sans-serif;font-size:38px;line-height:1.1;margin:0 0 20px;color:${colors.ink}">${escape(t.title)}</h1>${p(`${t.period}: ${period}`)}${p(t.intro)}${button(t.dashboard, url("", "", "#adoption"))}</td></tr>`;
  const sections = [];
  sections.push(card(h2(t.participation) + stats(stat(t.joined, n(data.joined)) + stat(t.removed, n(data.removed)) + stat(t.registered, n(data.registered))) + p(t.installationsNote) + (data.partialActivity ? p(t.partialActivity) : "")));
  let dataRows = "";
  for (const key of ["reports", "reporters", "galleries", "photos"]) {
    const inventory = ["galleries", "photos"].includes(key);
    const current = inventory ? data.current.inventory[key] : null;
    const previous = inventory ? data.previous.inventory[key] : null;
    const value = inventory ? current.reported ? current.total : null : data.current[key];
    const before = inventory ? previous.reported ? previous.total : null : data.previous[key];
    const detail = `${t.previous}: ${n(before)}${value !== null && before !== null ? ` (${signed(value - before)})` : ""}${inventory ? ` · ${n(current.reported)} ${t.reporting}` : ""}`;
    dataRows += stat(t[key], n(value), detail);
    text.push(`${t[key]}: ${n(value)} — ${detail}`);
  }
  text.push(t.dataNote);
  sections.push(card(h2(t.data) + stats(dataRows) + p(t.dataNote)));
  const featureRows = (entries, changes) => entries.map(item => {
    const value = changes ? `${signed(item.delta)} ${t.points}` : `${n(item.share)}%`;
    const detail = `${n(item.used)} / ${n(item.used_reported)}${changes ? ` · ${n(item.previousShare)}% → ${n(item.share)}%` : ""}`;
    text.push(`${featureName(item.key)}: ${value} (${detail})`, featureUrl(item.key));
    return `<p style="margin:14px 0;line-height:1.5">${link(featureName(item.key), featureUrl(item.key))}<br><strong>${escape(value)}</strong> <span style="color:${colors.muted}">(${escape(detail)})</span></p>`;
  }).join("");
  text.push("", t.adoption, t.adoptionNote);
  const top = featureRows(data.top, false);
  if (!data.top.length) text.push(t.noUse);
  sections.push(card(h2(t.adoption) + p(t.adoptionNote) + (top || p(t.noUse))));
  text.push("", t.changes);
  const changes = featureRows(data.changes, true);
  if (!data.changes.length) text.push(t.noChanges);
  let news = h2(t.changes) + (changes || p(t.noChanges));
  text.push("", t.newCoverage, t.newCoverageNote);
  news += h2(t.newCoverage) + p(t.newCoverageNote);
  const coverage = data.newCoverage.slice(0, 6);
  news += coverage.length ? coverage.map(key => `<p style="margin:12px 0">${link(featureName(key), featureUrl(key))}</p>`).join("") : p(t.none);
  text.push(...coverage.map(key => `${featureName(key)}: ${featureUrl(key)}`));
  if (data.newCoverage.length > coverage.length) { news += p(`${t.more}: ${n(data.newCoverage.length - coverage.length)}`); text.push(`${t.more}: ${url()}`); }
  const versions = data.newVersions.slice(0, 10).join(", ") || t.none;
  text.push("", t.versions, versions);
  news += h2(t.versions) + p(versions);
  if (data.newVersions.length > 10) { news += p(`${t.more}: ${n(data.newVersions.length - 10)}`); text.push(`${t.more}: ${url()}`); }
  sections.push(card(news));
  const feedbackCount = `${n(data.feedbackCount)} ${data.feedbackCount === 1 ? t.feedbackCountOne : t.feedbackCount}`;
  const feedbackText = [t.feedback, feedbackCount, t.feedbackIntro];
  let feedbackHtml = h2(t.feedback) + p(feedbackCount) + p(t.feedbackIntro);
  for (const item of chunk.feedback) {
    const href = url("", `?feedback=${encodeURIComponent(item.id)}`, `#feedback-${item.id}`);
    const kind = item.kind === "feedback" ? t.feedbackKind : t[item.kind];
    const author = item.name || t.anonymous;
    const permissions = [item.allow_public ? t.publicAllowed : t.private, ...(item.allow_marketing ? [t.marketingAllowed] : [])].join(" · ");
    const received = `${item.created_at.slice(0, 10)} ${item.created_at.slice(11, 16)} UTC`;
    feedbackText.push("", `${kind} · ${t[item.status] || item.status}`, item.title, `${author} · ${received}`, permissions, item.body, `${t.review}: ${href}`);
    feedbackHtml += `<div style="border-top:1px solid ${colors.line};padding-top:20px;margin-top:24px;overflow-wrap:anywhere;word-break:break-word"><p style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${colors.muted};margin:0 0 8px">${escape(kind)} · ${escape(t[item.status] || item.status)}</p><h3 style="font-size:20px;line-height:1.35;margin:0">${escape(item.title)}</h3>${p(`${author} · ${received}`)}${p(permissions)}<p style="line-height:1.65;margin:16px 0">${escape(item.body).replace(/\r?\n/g, "<br>")}</p>${button(t.review, href)}</div>`;
  }
  if (!chunk.feedback.length) { feedbackHtml += p(t.noFeedback); feedbackText.push(t.noFeedback); }
  if (chunk.hasMore) { feedbackHtml += p(t.moreFeedback); feedbackText.push(t.moreFeedback); }
  feedbackHtml += `<p style="margin:24px 0 0">${link(t.inbox, url("", "", "#feedback"))}</p>`;
  sections.unshift(card(feedbackHtml));
  html += sections.join("");
  html += `<tr><td style="padding:8px 24px 40px;font-size:13px">${p(t.footer)}${p(t.settings)}</td></tr></table></td></tr></table></body></html>`;
  text.push("", `${t.inbox}: ${url("", "", "#feedback")}`, "", t.footer, t.settings);
  return { html, text: [...introText, ...feedbackText, "", ...text].join("\n"), subject: `${t.subject} · ${period} · ${t.part} ${part}`, feedbackIds: chunk.feedback.map(item => item.id), hasMore: chunk.hasMore };
}
module.exports = { renderWeeklyEmail, feedbackChunk, escape };
