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
| `TRUST_PROXY_HOPS` | 0                             | Exact trusted proxy count, 0–3              |

The Node process reads environment variables. Use `node --env-file=.env
server/index.js` to load a native .env, or Compose's own .env loading. Never put
secrets in frontend build variables. Rotate the maintainer token in the
environment and restart; existing page tokens then fail authorization.

SQLite supports the smallest single-process deployment. PostgreSQL supports
concurrent processes and serializable collector transactions. Run startup
migrations once before starting multiple replicas: table guards support repeat
execution but do not provide a distributed migration coordinator.

The health endpoint `/api/health` checks database access. The image runs as node,
handles SIGTERM/SIGINT, and has a health check. Persist `/app/storage` in a
volume owned by that user. Compose exposes loopback; your proxy terminates TLS.

## Logging and abuse protection

No application request/access logger is installed. Disable proxy/CDN access
logging for collection, lookup, and session routes. Never log authorization,
bodies, fingerprints, IPs, user agents, or origins as analytics. Keep essential
infrastructure security logs separate and short-lived (recommended maximum
24 hours), with no payloads or credentials.

Transport rate limits retain only ephemeral HMAC address keys in process memory
for ten minutes. With multiple replicas, add privacy-preserving edge limits;
process-local limits do not coordinate. Database constraints, sequences, body
limits, and per-installation action quotas remain effective across replicas.
Defaults allow 1,000 registrations per UTC day and 100,000 active identities.

## Retention and restores

All accepted raw packets remain inspectable during participation. Nonces expire
after ten minutes and portal sessions after fifteen, pruned on submissions.
Private/public feedback is separate from telemetry but shares opt-out deletion.

Signed opt-out deletes active records and all derived contributions in one
transaction. Only SHA256(installation_id) remains in a revocation table without
identity, key, packet, timestamp, or lookup access. This persistent tombstone
prevents replayed old registrations.

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

Protocol changes need a new schema version and synchronized PicPeak/collector
copies. Run integration and PostgreSQL tests and both frontend builds. Deploy
collector support before distributing clients that require a new schema.
