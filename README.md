# picpeak-usage

The standalone collector and transparency portal for [PicPeak product usage (#1110)](https://github.com/PicPeak/picpeak/issues/1110): feature adoption analysis and dataset export for participants, private raw-packet lookup/export, participant voting, and a maintainer feedback inbox. Aggregate usage data is never shown anonymously: it unlocks with an installation's lookup hash or a voting session, as #1110 specifies.

PicPeak integration lives in the PicPeak repository. This app has no visitor trackers, third-party scripts, or analytics providers. Fonts are self-hosted (the same three families as picpeak.app) and the UI follows the picpeak.app design tokens.

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

The hash permits read access only: the installation's raw packets, its own history and the participant-wide aggregate dataset and history. It cannot vote, send reports, moderate feedback, or delete data. Maintainers open /maintainer with the deployment's separate token, held only in page memory. Maintainer access does not require a participating installation.

The maintainer workspace provides all retained contribution data: a paginated
reporter directory with registration metadata and latest snapshots, each reporter's
original accepted reports, and a complete NDJSON export of reporters, snapshots,
reports, feedback, votes and operation receipts. Export all reporters or one
selected reporter. Authentication internals and deployment secrets are not usage
contributions and are excluded. Maintainer read access does not authorize public
or marketing publication of feedback.

Participants and maintainers can explore daily, weekly or monthly UTC histories
of reporting installations, report counts, capability configuration/use, versions,
layouts and schemas. Each installation contributes its last report **within**
each period; gaps are not carried forward and reporting more often gives no
additional weight. Feature percentages use per-field denominators. Usage means
used since schema consent, not activity during that period. Opt-out removes
historical contributions. Choose a date range or all retained history, inspect
the chart/table, and download the selected history as JSON. New history and data
views are available in English and German.

## Deploy and audit

Set MAINTAINER_TOKEN in your environment or Compose .env, then:

```sh
docker compose up --build -d
```

The image runs as an unprivileged user and exposes loopback port 3190. Put an HTTPS reverse proxy at usage.picpeak.app in front of it. The image and Compose file trust exactly one X-Forwarded-For hop (TRUST_PROXY_HOPS=1); set the variable to the real number of proxies if there are more (up to 3). With 0 hops behind a proxy, every client shares one rate-limit bucket and the collector rejects legitimate reports as soon as 120 installations report within ten minutes; with more hops than real proxies, clients can spoof their address. The bare `npm start` default stays 0 for direct loopback use. See [operations](docs/OPERATIONS.md) for logging, retention, secrets, and deletion/restore requirements.

Every build includes /source.tar.gz containing a fixed allowlist of application source, protocol, tests, manifests, and documentation. Credentials, storage, Git metadata, and agent files are excluded. The deployed software is auditable without depending on a remote Git repository.

## Contract and verification

The [protocol reference](docs/PROTOCOL.md) defines every field and operation. JSON Schemas are served at /schema/usage.v1.json and /schema/usage.v2.json, with the EN/DE catalog at /schema/features.v2.json. PicPeak carries byte-identical protocol/catalog files in backend/src/usage/.

The [full coverage matrix](docs/FEATURE_COVERAGE.md) lists all 73 capabilities,
their exact meaning, all reviewed route families/flags and privacy exclusions.
v2 adds 54 capabilities to the original 19: 56 configured/used pairs and 17
configuration-only signals. No visitor behavior, user profiles, counts or content.
Existing participants stay on v1 until explicit signed v2 consent; the upgrade
preserves raw history and resets local usage markers only after confirmation.
Deploy the collector first, then PicPeak migration 205/client. Mixed-version
aggregates use per-field reported denominators; absent does not mean unused.

```sh
npm test
npm run build
PICPEAK_CHECKOUT=/path/to/picpeak npm run test:integration
TEST_DATABASE_URL=postgres://user:password@localhost/isolated_usage_test node --test test/postgres.test.js
```

Integration tests run the real PicPeak service against the collector over local HTTP using isolated databases. They cover consent, cadence, raw export, privacy allowlisting, lost receipts, outages, deletion/rejoin, clone detection, feedback, and voting. Install PicPeak's backend dependencies first. Ordinary tests skip integration when the sibling checkout is missing; the explicit integration command fails instead. PostgreSQL tests create synthetic data in the supplied isolated database.

See the [acceptance audit](docs/VERIFICATION.md) for requirement coverage and recorded verification.

MIT licensed. Local implementation does not create a GitHub repository or production deployment.
