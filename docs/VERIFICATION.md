# Issue #1110 acceptance audit

Verified locally on 2026-09-05. This implements both the PicPeak integration and
the independent picpeak-usage collector/web UI. No production deployment or
remote repository publication is implied.

## Requirement coverage

| Requirement | Implementation and evidence |
| --- | --- |
| Disabled by default, explicit consent after upgrade | Guarded PicPeak migration creates no identity; admin-only notice; unchecked EN/DE consent dialog. Frontend consent test, backend permission tests, real browser opt-in. |
| Clear fields, transport, visibility, deletion disclosure | Consent dialog, settings, public transparency page, JSON Schema and PROTOCOL.md. Includes small groups, pseudonymity and outage behavior. |
| No public gallery tracking or behavioral data | Lazy admin-only chunks and allowlisted backend middleware; authenticated activity endpoint accepts no telemetry. Gallery browser load observed zero usage requests/chunks. Integration fixtures prove names, domains and CSS text stay out of reports. |
| Collision-resistant installation identity; ownership proof | Ed25519 public-key fingerprint, encrypted backend-only private key, signed activation/reports/deletion, schema/timestamp/nonce/digest/sequence verification. Tampering, forged ownership and replay tests. |
| Detect duplicated identities; fresh rejoin | Storage binding and sequence conflict detection, persistent revocation digests. Clone, concurrent send and delete/rejoin tests. Full identical clones remain inherently indistinguishable, documented rather than overstated. |
| Daily reporting on admin use | Authenticated admin activity, UTC date guard, durable immutable queued packets and cross-process lease. Cadence, concurrent activity, outage and lost-receipt integration tests. |
| Initial feature signals | Nineteen configured/used capability pairs and controlled gallery-layout enums. Signal definitions are in PROTOCOL.md; no photo/gallery counts or visitor events. |
| Private keys never in browser storage | Backend encryption and status allowlist; public lookup hash is read-only. JWT/token-type and settings.edit checks. Participant voting uses a separate short-lived memory-only session. |
| Own data lookup and every accepted raw report export | Hash-based lookup, received time and verified signature flag, full raw JSON download, PicPeak preview/export. Exact-envelope test and browser download. |
| Full aggregate visibility for participants, no bucket suppression | Latest per-installation projections without lookup IDs/keys, complete NDJSON export, adoption/version/layout/history views, unlocked by the lookup hash or a voting session and never served anonymously. Single-installation aggregate/export and 401/404 tests. |
| Auditable collector | MIT source, public schema and build-generated source archive, reproducible manifests, Dockerfile, operational docs. Fixed archive allowlist excludes secrets and data. |
| Complete signed opt-out deletion | Atomic removal of raw reports, projections, private/public feedback, votes and sessions; local identity/key/binding cleared on confirmation. Outage, lost receipt, in-flight send, stale vote and revoked lookup tests; browser opt-out. |
| Spam/replay protection | Strict closed schema, 16 KiB body limit, Ed25519 signatures, freshness/nonce checks, immutable packet dedupe, quotas and short-lived HMAC-address limits. Bounds/replay/sequence tests, concurrent PostgreSQL test. |
| Explicit separate feedback | Anonymous/private default even with a remembered name; per-item naming, publication and testimonial marketing choices. Feedback never enters usage projections. Frontend and collector privacy tests. |
| Maintainer-only private inbox | Independent bearer credential, no browser persistence, explicit publication review constrained by submitter consent. Authorization tests and real browser moderation. |
| Public feature requests and participant votes | Only approved, publication-authorized requests are public; one vote per installation/request, authenticated updates and expiry. HTTP, integration and browser tests. |

The transport decision follows the preferred backend-signs/backend-sends
[follow-up](https://github.com/PicPeak/picpeak/issues/1110#issuecomment-5367220785),
which supersedes browser-only transport in the original issue. Browser relay
is optional and is not implemented. Feedback follows the
[later addition](https://github.com/PicPeak/picpeak/issues/1110#issuecomment-5401411055).

## Repeatable checks

From picpeak-usage (Node.js 22.20+):

```sh
npm ci
npm test
PICPEAK_CHECKOUT=/path/to/isolated/picpeak npm run test:integration
TEST_DATABASE_URL=postgres://user:password@localhost/isolated_test_db node --test test/postgres.test.js
npm run build
docker build -t picpeak-usage:local .
```

The main suite passed 14 tests; PostgreSQL is skipped without its explicit test
URL and passed separately against an isolated PostgreSQL 17 container. Tests
cover SQLite storage and the actual PicPeak service over local HTTP. PostgreSQL
coverage exercises the collector's migrations, concurrency, booleans and
deletion, not PicPeak's entire application schema.

From PicPeak backend:

```sh
npm test -- --runInBand __tests__/routes/adminUsage.test.js __tests__/integration/oidcSso.test.js
npx eslint src/usage/UsageService.js src/services/productUsageService.js src/routes/adminUsage.js src/middleware/productUsage.js migrations/core/201_product_usage.js __tests__/routes/adminUsage.test.js
```

Both suites passed: 40 tests. Targeted lint passed. The full core migrations
also ran successfully on the isolated SQLite browser-test database.

From PicPeak frontend:

```sh
npm test -- --run src/features/settings/__tests__/ProductUsageTab.test.tsx
npm run build:check
```

Four tests and the full TypeScript/production build passed. Existing warnings
about fonts, stylesheet import ordering and bundle sizes are unrelated to the
usage implementation. The complete pre-existing PicPeak test suite was not run.

## Browser evidence

Tested the actual built PicPeak admin and Docker-hosted collector with synthetic
local credentials and data. The full flow covered unchecked consent, a signed
report, packet inspection, explicit feature-request publication permission,
maintainer review, participant voting, JSON download and opt-out. After opt-out,
the previous lookup hash returned 404, the public request disappeared and the
voting session lost access. A separate gallery navigation loaded no usage code
or usage endpoints. Desktop and 390px mobile collector layouts were checked.

Screenshots are in the sibling workspace's verification directory, intentionally
excluded from the deployed source archive. Test credentials are synthetic; no
real PicPeak installation opted into a production collector.
