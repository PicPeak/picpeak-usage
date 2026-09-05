# picpeak-usage

The standalone collector and transparency portal for [PicPeak product usage (#1110)](https://github.com/PicPeak/picpeak/issues/1110): feature adoption analysis, public data export, private raw-packet lookup/export, participant voting, and a maintainer feedback inbox.

PicPeak integration lives in the PicPeak repository. This app has no visitor trackers, third-party scripts, fonts, or analytics providers.

## Run locally

Requires Node.js 22.20+ and npm.

```sh
npm ci
npm run build
MAINTAINER_TOKEN=<at-least-32-random-characters> npm start
```

Open http://127.0.0.1:3190. SQLite data lives in storage/usage.sqlite; set DATABASE_URL to use PostgreSQL. Generate a maintainer token with a password manager or `openssl rand -hex 32`. The public portal works without it, but maintainer access remains disabled.

For development, run `npm run dev:server` and `npm run dev` in separate shells. The Vite UI runs on port 5190, proxying API requests to 3190. For native .env loading use `node --env-file=.env server/index.js`.

## Connect PicPeak

Use the PicPeak implementation of #1110 and run its normal migrations. For local testing, set USAGE_COLLECTOR_URL=http://127.0.0.1:3190 in its backend. Production requires HTTPS; the default is https://usage.picpeak.app.

Open PicPeak → Settings → Product usage & feedback, read the disclosure, and explicitly enable participation. The backend registers an Ed25519 identity and sends daily reports on admin app use. Use the same page to preview/export packets, submit feedback, open a 15-minute voting session, or disable participation and delete data.

The hash permits raw-packet lookup only. It cannot vote, send reports, moderate feedback, or delete data. Maintainers open /maintainer with the deployment's separate token, held only in page memory.

## Deploy and audit

Set MAINTAINER_TOKEN in your environment or Compose .env, then:

```sh
docker compose up --build -d
```

The image runs as an unprivileged user and exposes loopback port 3190. Put an HTTPS reverse proxy at usage.picpeak.app in front of it. See [operations](docs/OPERATIONS.md) for logging, retention, secrets, and deletion/restore requirements.

Every build includes /source.tar.gz containing a fixed allowlist of application source, protocol, tests, manifests, and documentation. Credentials, storage, Git metadata, and agent files are excluded. The deployed software is auditable without depending on a remote Git repository.

## Contract and verification

The [protocol reference](docs/PROTOCOL.md) defines every field and operation. JSON Schema is served at /schema/usage.v1.json. PicPeak carries byte-identical protocol files in backend/src/usage/.

```sh
npm test
npm run build
PICPEAK_CHECKOUT=/path/to/picpeak npm run test:integration
TEST_DATABASE_URL=postgres://user:password@localhost/isolated_usage_test node --test test/postgres.test.js
```

Integration tests run the real PicPeak service against the collector over local HTTP using isolated databases. They cover consent, cadence, raw export, privacy allowlisting, lost receipts, outages, deletion/rejoin, clone detection, feedback, and voting. Install PicPeak's backend dependencies first. Ordinary tests skip integration when the sibling checkout is missing; the explicit integration command fails instead. PostgreSQL tests create synthetic data in the supplied isolated database.

See the [acceptance audit](docs/VERIFICATION.md) for requirement coverage and recorded verification.

MIT licensed. Local implementation does not create a GitHub repository or production deployment.
