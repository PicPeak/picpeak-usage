"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { readWeeklyConfig, weekStart, recipientId } = require("../server/weeklyConfig");
const { createDatabase, migrate } = require("../server/database");
const { weeklyData } = require("../server/weeklyData");
const { renderWeeklyEmail } = require("../server/weeklyEmail");

function commandError(message) {
  const error = new Error(message);
  error.code = "WEEKLY_COMMAND";
  return error;
}

async function main() {
  const config = readWeeklyConfig();
  if (!config.enabled) throw commandError("Configure and enable WEEKLY_REPORT_ENABLED before previewing or verifying SMTP.");
  if (process.argv[2] === "--verify") {
    const transport = require("nodemailer").createTransport(config.smtp);
    try {
      await transport.verify();
      process.stdout.write("SMTP connection and authentication verified. No email was sent.\n");
    } catch {
      throw commandError("SMTP verification failed; check host, TLS and authentication settings.");
    } finally { transport.close(); }
    return;
  }
  if (process.argv[2] !== "--preview") throw commandError("Use --preview [output-prefix] or --verify.");
  const db = createDatabase();
  try {
    await migrate(db);
    const data = await weeklyData(db, new Date(weekStart(Date.now())).toISOString(), recipientId("preview"));
    const preview = renderWeeklyEmail(data, config);
    const prefix = path.resolve(process.argv[3] || ".local/weekly-report");
    fs.mkdirSync(path.dirname(prefix), { recursive: true, mode: 0o700 });
    for (const [extension, contents] of [["html", preview.html], ["txt", preview.text]]) {
      fs.writeFileSync(`${prefix}.${extension}`, contents, { mode: 0o600 });
      fs.chmodSync(`${prefix}.${extension}`, 0o600);
    }
    process.stdout.write(`Saved first-part preview to ${prefix}.html and .txt. No email was sent; delivery cursors are unchanged.\n`);
  } finally { await db.destroy(); }
}
main().catch(error => {
  process.stderr.write(["WEEKLY_CONFIG", "WEEKLY_COMMAND"].includes(error.code) ? `${error.message}\n` : "Weekly report command failed.\n");
  process.exitCode = 1;
});
