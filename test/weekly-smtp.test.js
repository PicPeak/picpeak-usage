"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const { execFileSync } = require("node:child_process");
const { createDatabase, migrate } = require("../server/database");
const { readWeeklyConfig } = require("../server/weeklyConfig");
const { prepareWeeklyReporting } = require("../server/weeklyActivity");
const { WeeklyReporter } = require("../server/weeklyReporter");

async function smtpFixture(t, { encrypted = false, stall = false } = {}) {
  const sockets = new Set(), received = [], commands = [];
  let tlsOptions, caFile;
  if (encrypted) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "picpeak-weekly-smtp-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const config = path.join(directory, "openssl.cnf");
    fs.writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
    const keyFile = path.join(directory, "key.pem"); caFile = path.join(directory, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", caFile, "-days", "1", "-config", config], { stdio: "ignore" });
    tlsOptions = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(caFile) };
  }
  const connected = socket => {
    let input = "", data = false, message = [], authenticated = false;
    socket.setEncoding("utf8"); socket.on("error", () => {});
    socket.write("220 localhost synthetic SMTP\r\n");
    socket.on("data", chunk => {
      input += chunk;
      while (input.includes("\r\n")) {
        const index = input.indexOf("\r\n"), line = input.slice(0, index);
        input = input.slice(index + 2);
        if (data) {
          if (line === ".") { data = false; received.push(message.join("\r\n")); message = []; socket.write("250 queued\r\n"); }
          else message.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        commands.push(line.split(" ")[0]);
        if (/^EHLO /.test(line)) { if (!stall) socket.write("250-localhost\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n"); }
        else if (/^AUTH PLAIN /.test(line)) {
          authenticated = Buffer.from(line.slice(11), "base64").toString() === "\0test-user\0test-password";
          socket.write(authenticated ? "235 authenticated\r\n" : "535 denied\r\n");
        } else if (line === "STARTTLS") socket.write("454 TLS not available on this fixture\r\n");
        else if (/^MAIL FROM:/.test(line)) socket.write(authenticated ? "250 sender accepted\r\n" : "530 authentication required\r\n");
        else if (/^RCPT TO:/.test(line)) socket.write("250 recipient accepted\r\n");
        else if (line === "DATA") { data = true; socket.write("354 end with dot\r\n"); }
        else if (line === "QUIT") socket.end("221 goodbye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  };
  const server = encrypted ? tls.createServer(tlsOptions, connected) : net.createServer(connected);
  server.on("tlsClientError", () => {});
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, caFile, received, commands };
}

async function workerFixture(t, smtp, settings = {}) {
  const db = createDatabase({ DATABASE_PATH: ":memory:" });
  await migrate(db);
  t.after(() => db.destroy());
  const config = readWeeklyConfig({
    WEEKLY_REPORT_ENABLED: "true", MAINTAINER_TOKEN: "test-only-maintainer-secret-123456789012345",
    WEEKLY_REPORT_TO: "maintainer@example.test", SMTP_FROM: "usage@example.test", SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.port), SMTP_USER: "test-user", SMTP_PASSWORD: "test-password",
    SMTP_TIMEOUT_MS: "1000", ...settings,
  });
  await prepareWeeklyReporting(db, config, Date.parse("2026-09-06T12:00:00Z"));
  const errors = [], worker = new WeeklyReporter({ db, config, now: () => Date.parse("2026-09-07T08:00:00Z"), onError: code => errors.push(code) });
  t.after(() => worker.stop());
  return { worker, db, errors };
}

for (const encrypted of [false, true]) test(`real SMTP: ${encrypted ? "verified TLS with custom CA" : "explicit local relay"}, authentication and multipart email`, async t => {
  const smtp = await smtpFixture(t, { encrypted });
  const f = await workerFixture(t, smtp, encrypted ? { SMTP_TLS_MODE: "tls", SMTP_CA_FILE: smtp.caFile, SMTP_TLS_SERVERNAME: "localhost" } : { SMTP_TLS_MODE: "none" });
  await f.worker.tick();
  assert.deepEqual(f.errors, []); assert.equal(smtp.received.length, 1);
  assert.ok(smtp.commands.includes("AUTH"));
  const mail = smtp.received[0];
  assert.match(mail, /Content-Type: multipart\/alternative/);
  assert.match(mail, /Content-Type: text\/plain/); assert.match(mail, /Content-Type: text\/html/);
  assert.match(mail.replace(/\r\n[ \t]+/g, " "), /Message-ID: <weekly-[a-f0-9]+@usage\.picpeak\.app>/i);
  assert.equal(mail.includes("test-password"), false);
  assert.ok((await f.db("weekly_recipients").first()).last_sent_at);
});

test("real SMTP: required STARTTLS never downgrades to plaintext or advances the weekly cursor", async t => {
  const smtp = await smtpFixture(t);
  const f = await workerFixture(t, smtp);
  await f.worker.tick();
  assert.equal(smtp.received.length, 0); assert.equal(smtp.commands.includes("AUTH"), false);
  assert.equal((await f.db("weekly_recipients").first()).period_end, "2026-09-07T00:00:00.000Z");
  assert.equal(f.errors.length, 1);
});

test("real SMTP: stalled server times out and leaves a durable retry without logging its response", async t => {
  const smtp = await smtpFixture(t, { stall: true });
  const f = await workerFixture(t, smtp, { SMTP_TLS_MODE: "none" });
  await f.worker.tick();
  assert.equal(smtp.received.length, 0); assert.deepEqual(f.errors, ["ETIMEDOUT"]);
  const state = await f.db("weekly_recipients").first();
  assert.equal(state.failures, 1); assert.equal(state.last_sent_at, null);
  assert.equal(state.period_end, "2026-09-07T00:00:00.000Z");
});
