# Operations and privacy

Deploy the collector and UI together behind HTTPS. PicPeak sends backend
requests, so browser CORS credentials are unnecessary.

| Variable           | Default                       | Purpose                                     |
| ------------------ | ----------------------------- | ------------------------------------------- |
| `HOST`             | 127.0.0.1 (0.0.0.0 in Docker) | Listen address                              |
| `PORT`             | 3190                          | Listen port                                 |
| `DATABASE_PATH`    | storage/usage.sqlite          | Persistent SQLite file                      |
| `DATABASE_URL`     | unset                         | PostgreSQL; takes precedence                |
| `MAINTAINER_TOKEN` | unset                         | 32+ random characters for maintainer access |
| `SESSION_SECRET` | MAINTAINER_TOKEN | Independent 32+ random character session derivation key; identical on every replica |
| `TRUST_PROXY_HOPS` | 0 (1 in Docker/Compose)       | Exact trusted proxy count, 0–3              |

The Node process reads environment variables. Use `node --env-file=.env
server/index.js` to load a native .env, or Compose's own .env loading. Never put
secrets in frontend build variables. This token grants read/export access to all
retained reporter contributions, including private raw reports and feedback,
and feedback moderation. It does not require a participant lookup hash. Participant
credentials permit shared aggregates/history and own raw reports/history only.
The maintainer UI keeps the token in memory and cancels reads/downloads on logout.
Rotate the maintainer token in the
environment and restart; existing page tokens then fail authorization.

SQLite supports the smallest single-process deployment. PostgreSQL supports
concurrent processes and serializable collector transactions. Run startup
migrations once before starting multiple replicas: table guards support repeat
execution but do not provide a distributed migration coordinator.

The health endpoint `/api/health` checks database access. The image runs as UID 1000,
handles SIGTERM/SIGINT, and has a health check. Persist `/app/storage` in a
volume owned by that user. Compose exposes loopback; your proxy terminates TLS.

The runtime is digest-pinned Distroless Node 22 on Debian 13: no npm, shell or
package manager. SQLite is compiled in a matching Debian 13 builder. UID 1000
preserves compatibility with existing volumes. Compose uses a read-only root,
dropped capabilities, no-new-privileges, a 16 MiB noexec tmpfs, 512 MiB memory,
one CPU and 128 PIDs. Adjust resources deliberately for your deployment. Build
with `--pull`; review and update the pinned runtime digest routinely. The
scheduled security workflow scans the resulting image as well as the app lock.

## Logging and abuse protection

No application request/access logger is installed. Disable proxy/CDN access
logging for collection, lookup, and session routes. Never log authorization,
bodies, fingerprints, IPs, user agents, or origins as analytics. Keep essential
infrastructure security logs separate and short-lived (recommended maximum
24 hours), with no payloads or credentials.

Transport rate limits retain only ephemeral HMAC address keys in process memory
for ten minutes. IPv4-mapped IPv6 is normalized; IPv6 clients share a /56 before
the address is HMACed. They key on the address as Express sees it. The Docker image and Compose
file trust one hop because the container runs behind one reverse proxy; set
`TRUST_PROXY_HOPS` to the exact hop count in every other setup, otherwise
all installations share the proxy's single bucket (120 envelopes per ten
minutes) and legitimate reports are rejected. Never set it higher than the real
hop count; clients could then spoof `X-Forwarded-For` and escape the limits.
The process warns at startup when it listens on a non-loopback address with
zero trusted hops. With multiple replicas, add privacy-preserving edge limits;
process-local limits do not coordinate. Database constraints, sequences, body
limits, and per-installation action quotas remain effective across replicas.
Defaults allow 1,000 registrations per UTC day and 100,000 active identities.
Global daily counters have no identity/IP linkage and survive opt-out. Creating
a revocation for a never-registered identity has a separate 1,000/day budget.
Registered installations can always delete, and existing revocations can always
be retried, regardless of those admission budgets. A never-registered client
over that budget remains deletion-pending and can retry next day. Historical
registrations already erased by an old release cannot be reconstructed during
upgrade; the migration backfills the registrations still observable.

Aggregate cache entries carry a database revision changed in the same
transaction as reports/deletions. Every cache read checks it, and late old
computations cannot overwrite a newer result. Invalid/failed submissions do not
invalidate the cache. Lists and raw previews use bounded pages; vote counts use
indexed lookups for that page. Exports run under one repeatable-read snapshot
(SQLite transaction / PostgreSQL repeatable read), obey backpressure, and close
after 30 seconds if unfinished. Slow clients must retry; no partial export is
reported as a successful complete JSON document. An export represents its start
snapshot, not a guarantee of retracting bytes already delivered before opt-out.

## Retention and restores

Every unique accepted usage report remains inspectable during participation;
only its first accepted signed envelope is retained. Transport retries are
deduplicated; rejected attempts, registration/session commands and separately
submitted feedback are not part of the report export. Nonces expire
after ten minutes and portal sessions after fifteen, pruned on valid submissions,
startup and once a minute even when idle. Expiry is enforced before cleanup.
Private/public feedback is separate from telemetry but shares opt-out deletion.

Session tokens are derived with a domain-separated HMAC of the server secret
and immutable receipt metadata. Only their hashes are stored; operation receipts
contain no bearer token. A retry can reconstruct a token only while its session
is live and the secret is unchanged. Otherwise the receipt says
`session_expired: true` and a new signed session command is needed. Missing/short
session secrets fail closed. Rotating SESSION_SECRET does not extend old token
lifetime; rotate MAINTAINER_TOKEN separately if an independent session key is set.
The security upgrade revokes old voting sessions and scrubs legacy plaintext
receipt copies once. Participants reconnect from PicPeak; reports/feedback remain.

### Complete data inventory and retention

| Data | Retention / deletion |
| --- | --- |
| `installations` identity/public key/sequence/consent_version | While participating; removed on opt-out |
| `reports` first accepted signed envelopes + received time | Every logical usage report while participating; removed on opt-out |
| `snapshots` latest projection + aggregate cache | Current participation only; shared revision invalidates cache after committed deletion |
| `feedback`, names and consent/moderation state; `votes` | Separate from telemetry; removed on the author's opt-out, and votes on deleted items also removed |
| `operations` packet ID/digest/action/day and non-secret receipt metadata | While participating for idempotency and quotas; removed on opt-out; never a raw-token store |
| `sessions` token hash, installation ID, expiry | At most 15-minute validity; expired rows removed within the next cleanup cycle |
| `nonces` nonce, installation ID, expiry | 10 minutes plus the next cleanup cycle |
| `abuse_budgets` kind/day/count | Current and previous UTC day only (under 48 hours plus cleanup); no identity/IP/hash |
| `collector_meta` revision and migration version | Constant-size non-personal coordination state; no identity history |
| `revocations` SHA256(installation ID) | Persistent replay-prevention ledger; no key, report, timestamp or lookup access |
| Address HMAC rate-limit buckets | Process memory only, 10-minute windows; no persisted raw IP/UA/origin |
| Export/deletion audit receipts | Generated for the requester, no collector-side access/export history. Download and retain privately. PicPeak optionally retains only its latest local export receipt and identity-free deletion confirmation; opt-out clears the export receipt. |
| Proxy/CDN/security logs | No payloads or credentials; access logging disabled; exceptional security logs recommended maximum 24 hours, operator responsibility |
| Backups | None created by this service; if added, explicitly disclose a short retention and apply revocations on restore |
| Optional `weekly_activity` day/joined/removed totals | At most 90 days plus cleanup, no identities; aggregate counts survive individual opt-outs and are removed when weekly reporting is disabled |
| Optional `weekly_recipients` / `weekly_report_meta` | Minimal scheduling/retry/lease state and activation time while enabled; no SMTP credentials, installation identity or email body; disabling clears delivery state and activation time |
| Optional `weekly_feedback_receipts` | References to live feedback already accepted in the current multipart report; removed on author opt-out, report completion or disabling reporting |
| Maintainer email copies | Held by configured recipients and SMTP infrastructure; cannot be recalled by opt-out. Operator-controlled retention and access. No collector email-content archive. |

Raw JSON exports include a dated `export.v1` receipt (receipt ID, snapshot
revision, scope and report count). Dataset exports expose `X-Exported-At`,
`X-Export-Receipt` and `X-Dataset-Revision`. Signed deletion responses contain an
identity-free `deletion.v1` confirmation in addition to the normal protocol
receipt. These are user-held evidence of what the server acknowledged, not a
cryptographic proof of forensic storage erasure. There is deliberately no
central personal audit trail surviving opt-out.

Signed opt-out deletes active records and all derived contributions in one
transaction. Only SHA256(installation_id) remains linked to that identity in a revocation table without
identity, key, packet, timestamp, or lookup access. This persistent tombstone
prevents replayed old registrations.

Optional weekly reporting retains identity-free aggregate join/opt-out totals
for 90 days, separately from usage history. Those counters cannot retrieve a
former installation's data. Feedback delivery references cascade on opt-out.
See [weekly report configuration and privacy](WEEKLY_REPORTS.md) before enabling
SMTP delivery of private feedback to trusted maintainers.

The collector makes no automatic backups. If you add backups, keep and apply
the revocation ledger across restores, purging revoked installations before
serving a restored database. Never resurrect opted-out users from stale
backups. Disclose a short backup retention period. SQL deletion is logical
deletion, not a claim of forensic erasure from storage snapshots.

PicPeak stops collection immediately at opt-out and retains signing credentials
only until it confirms remote deletion. Outages remain visibly pending, with
retry on admin activity or the retry button. Lost receipts must be recoverable.

A restored PicPeak database lacking its local storage binding stops reporting.
A full storage clone can copy that binding too; diverging sequences then
conflict. Exact same-key clones are inherently indistinguishable and require
operator resolution. Deleting a shared identity affects every copy using it;
delete/rejoin creates a fresh identity.

## Auditable releases

`npm run build` creates `/source.tar.gz` from a fixed allowlist, then builds the
UI. Inspect the archive when changing this list. Exclude .env, storage, Git,
logs, screenshots, and agent files. The archive lets participants audit the
deployed source even without a remote Git repository.
Only the maintained design, operations, protocol and feature-coverage documents
are included. Local implementation reports and notes in `.local/` or
`docs/local/` are excluded even when building from a working directory where
those files still exist.

Protocol changes need a new schema version and synchronized PicPeak/collector
copies. Run integration and PostgreSQL tests and both frontend builds. Deploy
collector support before distributing clients that require a new schema.

### usage.v2 rollout

Migrate/deploy the collector before the PicPeak client. The guarded collector
migration adds consent_version defaulting to usage-consent.v1, preserving existing
participants. PicPeak migration 205 does the same locally. Never backfill v2
consent from an existing registration, config, feature marker or UI visit.
The explicit signed consent action is required for the wider scope; until its
matching acknowledgement the client records only v1 signals. Repeat migration
is safe; coordinate migrations before starting multiple replicas as above.

v1 packets remain valid and raw history remains unchanged. Legacy aggregate
projections are read as schema_version usage.v1 without fabricating new fields.
Each aggregate metric has its own reported denominator; zero means not collected.
Both UI disclosures and the downloadable source include the complete bilingual
catalog and the [coverage/exclusion matrix](FEATURE_COVERAGE.md).

A queued consent on an old/unreachable collector remains pending, not silently
active. Finish deployment and retry, or opt out to delete. No additional report
is accepted on the upgrade day if the v1 report for that UTC date was accepted.
Do not roll back the client to a build unaware of migration 205 after a v2 opt-in;
retain compatible state/schema support or complete opt-out before rollback.

Run `npm run test:required` with PICPEAK_CHECKOUT and a disposable
TEST_DATABASE_URL. It requires the real client integration, PostgreSQL checks
and browser regression tests instead of accepting skipped integration as green.
The GitHub workflow checks the explicitly configured PicPeak client ref; update
PICPEAK_TEST_REF when the feature moves to the main release branch.

### usage.v3 rollout

Deploy the collector with v1/v2/v3 support first, then the client. No database
migration is needed: inventories and additional booleans use existing signed
report/projection storage. Verify `/api/health` lists all three schemas and
`/schema/features.v3.json` exposes 86 features and exactly two inventory totals.

Existing v1/v2 participation continues at its previous scope until explicit v3
consent. Do not backfill markers, counts, or consent. Lost receipts keep the
client on the old scope until a verified retry; disabling deletes all versions.

After a v3 opt-in, do not roll back to a client that does not understand v3
consent. Roll back using a build that retains the v3 protocol or disable
participation first. Keep v1/v2 validators and public catalogs available for
older clients and immutable historical exports.

### Compatible report reception

Deploy the compatible collector to accept partial v1/v2/v3 reports; existing
PicPeak clients need no upgrade or new consent for their existing report scope.
No database migration or backfill is required. The client still sends complete
reports; its shared protocol copy includes separate strict writer and tolerant
receiver validation. The receiver does not remove authentication, consent,
sequence or quota requirements.

Once partial reports have been accepted, keep a collector version that supports
them: earlier aggregators assumed every report contained features and layouts.
Do not rewrite signed historical reports to fill missing fields during rollback.
The compatibility regression suite runs on SQLite and PostgreSQL and checks
unknown values, delayed reports, unchanged raw exports and opt-out removal.

### usage.v4 rollout

Deploy the collector before releasing/enabling v4 clients. Check `/api/health`
for v1/v2/v3/v4 in `supported_schemas`, and the v4 sender, ingress and catalog
endpoints for JSON. Existing v1/v2/v3 senders must still work unchanged.

v4 changes the downloads question only after fresh explicit consent. Do not
rename, invert, delete or backfill historical values. Never mutate an immutable
pending packet to fit a newer catalog: old schemas remain supported for retries,
including when the original receipt was lost. Keep a v4-aware collector after
accepting v4 reports. No database migration is needed. Issue #9 rollout acceptance
requires live v4 validation; merging source alone does not deploy this service.
