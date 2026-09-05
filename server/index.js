"use strict";
const { createDatabase, migrate } = require("./database");
const { createApp } = require("./app");

async function start() {
  const db = createDatabase();
  await migrate(db);
  const app = createApp({ db });
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
  const stop = () =>
    server.close(() => db.destroy().finally(() => process.exit(0)));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
start().catch(() => {
  process.stderr.write(
    "picpeak-usage startup failed; check database configuration\n",
  );
  process.exit(1);
});
