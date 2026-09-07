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

While participating, “Open usage portal” signs you in for reading and voting.
Voting expires after 15 minutes; reading remains available until you sign out or
reload the page. Both credentials stay only in page memory, and opting out in
PicPeak revokes access.

The hash permits read access only: the installation's raw packets, its own history and the participant-wide aggregate dataset and history. It cannot vote, send reports, moderate feedback, or delete data. Maintainers open /maintainer with the deployment's separate token, held only in page memory. Maintainer access does not require a participating installation.

The maintainer workspace provides all retained contribution data: a paginated
reporter directory with registration metadata and latest snapshots, each reporter's
original accepted reports, and a complete NDJSON export of reporters, snapshots,
reports, feedback, votes and operation receipts. Export all reporters or one
selected reporter. Authentication internals and deployment secrets are not usage
contributions and are excluded. Maintainer read access does not authorize public
or marketing publication of feedback.

Participants and maintainers start with a shared feature overview: configuration
and use side by side, ranked by the share of installations reporting each field.
Quick views highlight majority use, no reported use and configuration-only
features. Yes/no/unknown counts show the coverage behind each percentage; actual
use that is not collected is labelled separately. The initial list shows eight
features, with search and an option to show all historical capabilities.

Each feature's “View trend” shortcut opens its history directly. Detailed filters
remain available under “Explore history”. Participants and maintainers can explore daily, weekly or monthly UTC histories
of reporting installations, report counts, capability configuration/use, gallery/photo totals, versions,
layouts and schemas. Each installation contributes its last report **within**
each period; gaps are not carried forward and reporting more often gives no
additional weight. Feature percentages use per-field denominators. Usage means
used since schema consent, not activity during that period. Opt-out removes
historical contributions. Choose a date range or all retained history, inspect
the chart/table, and download the selected history as JSON. New history and data
views are available in English and German.

A single language selector in the header controls the entire portal, including
navigation, sign-in, dashboards, requests, transparency and maintainer tools.
An explicit choice is saved locally as `picpeak-usage-language` and applies across
pages and reloads; otherwise the browser language is used (German or English).
If local storage is unavailable, the choice works in page memory. Changing language
preserves current filters, form inputs and sessions; report payloads and submitted
feedback stay unchanged. No credentials are saved with the language preference.

## Deploy and audit

Set MAINTAINER_TOKEN in your environment or Compose .env, then:

```sh
docker compose up --build -d
```

The image runs as an unprivileged user and exposes loopback port 3190. Put an HTTPS reverse proxy at usage.picpeak.app in front of it. The image and Compose file trust exactly one X-Forwarded-For hop (TRUST_PROXY_HOPS=1); set the variable to the real number of proxies if there are more (up to 3). With 0 hops behind a proxy, every client shares one rate-limit bucket and the collector rejects legitimate reports as soon as 120 installations report within ten minutes; with more hops than real proxies, clients can spoof their address. The bare `npm start` default stays 0 for direct loopback use. See [operations](docs/OPERATIONS.md) for logging, retention, secrets, and deletion/restore requirements.

Every build includes /source.tar.gz containing a fixed allowlist of application source, protocol, tests, manifests, and documentation. Credentials, storage, Git metadata, and agent files are excluded. The deployed software is auditable without depending on a remote Git repository.

## Contract and verification

Old and partial reports remain readable after upgrades. The collector supports
v1/v2/v3/v4/v5 and treats omitted or null measurements as unknown. Freshly signed
delayed reports keep their original reporting date. Separate reception schemas
at `/schema/ingress/usage.v1.json` (also v2/v3/v4/v5) describe this compatibility;
the original complete sender schemas, consent and privacy boundaries stay fixed.

The [protocol reference](docs/PROTOCOL.md) defines every field and operation. JSON Schemas are served at `/schema/usage.v1.json`, `/schema/usage.v2.json`, `/schema/usage.v3.json` `/schema/usage.v4.json` and `/schema/usage.v5.json`, with the current EN/DE catalog at `/schema/features.v5.json`. PicPeak carries byte-identical protocol/catalog files in `backend/src/usage/`.

The [full coverage matrix](docs/FEATURE_COVERAGE.md) covers 87 capabilities: 64 configured/used pairs and 23 configuration-only signals. ML face recognition is included without biometric results. v3 adds 13 specific capabilities, including invoice import, plus exactly two installation inventory totals: stored galleries and non-video photo records, including drafts and retained archived records. No contents, per-gallery breakdowns, visitor behavior or identities.

Existing v1/v2/v3 participants retain their previous scope until explicit signed v4 consent. v4 replaces the allowed-downloads question with restricted downloads; old questions remain independently visible in history. Upgrading preserves identity and raw history, restarts local usage markers after confirmation, and never collects the new restriction signal before that confirmation. Counts and features have per-field reporting denominators; older missing values are unknown, not zero.

```sh
npm test
npm run build
PICPEAK_CHECKOUT=/path/to/picpeak npm run test:integration
TEST_DATABASE_URL=postgres://user:password@localhost/isolated_usage_test node --test test/postgres.test.js
```

Integration tests run the real PicPeak service against the collector over local HTTP using isolated databases. They cover consent, cadence, raw export, privacy allowlisting, lost receipts, outages, deletion/rejoin, clone detection, feedback, and voting. Install PicPeak's backend dependencies first. Ordinary tests skip integration when the sibling checkout is missing; the explicit integration command fails instead. PostgreSQL tests create synthetic data in the supplied isolated database.

CI runs the required integration/browser checks, dependency audit, container
build, runtime smoke test and image vulnerability scan. Test results belong
in CI or local artifacts rather than dated reports in the source tree.

Keep application code, tests, build configuration and maintained documentation
in Git. The `docs/` directory contains the design reference, operating guide,
protocol and feature coverage contract. Store local plans, audit notes and
handoffs in `.local/` or `docs/local/`; these are excluded from Git, Docker and
the downloadable source archive.

MIT licensed.

Version 5 separates actual CMS/template/branding/SEO/category/event-type edits from the old broader management questions, and reports real template-mail transport acceptance (including background sends) as one separate boolean. Previews, tests and unchanged saves do not establish these new observations. Built-in capabilities have an availability label, not a configuration percentage. Earlier questions remain separately inspectable; every new signal requires confirmed v5 consent. See the full coverage matrix for the audit of all capabilities and interpretation limits.
