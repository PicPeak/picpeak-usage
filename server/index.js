"use strict";
const { createDatabase, migrate } = require("./database");
const { createApp } = require("./app");

async function start() {
  const db = createDatabase();
  await migrate(db);
  const app = createApp({ db });
  const port = Number(process.env.PORT || 3190);
  const server = app.listen(port, process.env.HOST || "127.0.0.1", () =>
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
