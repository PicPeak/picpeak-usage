"use strict";
const { createDatabase, migrate } = require("./database");
const { createApp } = require("./app");
const { readWeeklyConfig } = require("./weeklyConfig");
const { prepareWeeklyReporting } = require("./weeklyActivity");
const { WeeklyReporter } = require("./weeklyReporter");

async function start() {
  const weeklyConfig = readWeeklyConfig();
  const db = createDatabase();
  await migrate(db);
  await prepareWeeklyReporting(db, weeklyConfig);
  const app = createApp({ db });
  await app.locals.collector.pruneExpired();
  let maintaining = false;
  const maintenance = setInterval(async () => {
    if (maintaining) return;
    maintaining = true;
    try {
      await app.locals.collector.pruneExpired();
    } catch {
      process.stderr.write("picpeak-usage: security metadata cleanup failed\n");
    } finally {
      maintaining = false;
    }
  }, 60000);
  maintenance.unref();
  const host = process.env.HOST || "127.0.0.1";
  if (host !== "127.0.0.1" && Number(process.env.TRUST_PROXY_HOPS || 0) === 0)
    process.stderr.write(
      "picpeak-usage: TRUST_PROXY_HOPS=0 while listening on a non-loopback " +
        "address. Behind a reverse proxy every client then shares one " +
        "rate-limit bucket (the proxy's address); set TRUST_PROXY_HOPS to the " +
        "exact number of proxies that append X-Forwarded-For.\n",
    );
  const port = Number(process.env.PORT || 3190);
  const server = app.listen(port, host, () =>
    process.stdout.write(`picpeak-usage listening on port ${port}\n`),
  );
  const weeklyReporter = new WeeklyReporter({ db, config: weeklyConfig, onError: code =>
    process.stderr.write(`picpeak-usage: weekly report ${code}; will retry\n`),
  });
  weeklyReporter.start();
  let shutdown;
  const stop = () => {
    if (shutdown) return;
    clearInterval(maintenance);
    shutdown = weeklyReporter.stop();
    server.close(() => shutdown.finally(() => db.destroy().finally(() => process.exit(0))));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
start().catch((error) => {
  process.stderr.write(
    error.code === "WEEKLY_CONFIG" ? `${error.message}\n` : "picpeak-usage startup failed; check database configuration\n",
  );
  process.exit(1);
});
