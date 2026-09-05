# Security and transparency hardening

Follow-up to the 2026-09-05 review and PicPeak #1110. This records the changes
and regression coverage; it is not a certification of a production deployment.

| Review item | Resolution | Regression coverage |
| --- | --- | --- |
| S01: late private responses after logout | Credential-keyed components; abort reads and pending file saves on scope removal; prevent changing credentials during login | Browser: raw response, download and maintainer reload after logout |
| S02: admission budgets erased by opt-out | Identity-free current/previous-day counters; separate unknown-deletion admission; legitimate opt-out and tombstone retries remain possible | SQLite + PostgreSQL: quota exhaustion, opt-out, retries and pruning |
| S03: IPv6 rotation | Official IPv6 /56 and mapped-IPv4 normalization before the ephemeral HMAC limiter key | HTTP rate-limit regression |
| S04: invalid requests evict cache; unbounded reads | Revision changes only on committed dataset writes; share in-flight calculations; paged feedback/vote lookups and streaming exports | Invalid-envelope/cache test; 205-row raw and feedback fixtures; browser pagination |
| S05: stale replica/deletion cache | Database-backed revision checked on every read and after calculations | Separate collector instances; a calculation delayed across committed deletion |
| S06: plaintext session receipts | Server-key-derived retryable tokens; only token hashes persisted; one-time legacy receipt scrub and session revocation | SQLite + PostgreSQL upgrade, replay, expiry and rotation; client receipt checks |
| T01: incomplete concurrent dataset exports | One read snapshot for the entire streamed export; revision-guarded paged inspection | 250-row export with concurrent PostgreSQL deletion; changed-revision rejection |
| T02: misleading public-dataset wording | PicPeak EN/DE consent explicitly says participants only; public source/schema and moderated feedback distinguished | PicPeak consent UI and Docker workflows |
| T03: ambiguous raw-packet promise | First accepted envelope per unique report; retries deduplicated; other commands are not report history | Exact envelope and retry tests; export UI and docs |
| T04: retention and audit trail | Full data inventory; user-held export/deletion receipts; bounded identity-free local PicPeak receipts, no permanent personal collector audit log | Raw receipt export, upgrade scrubbing and opt-out-during-export tests |
| T05: marketing feed ambiguity | Dedicated public feed requires both publication and marketing consent plus maintainer publication | SQLite + PostgreSQL consent matrix; full cross-app workflow |
| V01: stale or skipped integration fixture | Run the client's actual usage migrations; mandatory client/PostgreSQL environment for release checks; browser and image smoke tests in CI | `npm run test:required` fails when its prerequisites are absent |
| Runtime/container findings | Digest-pinned Debian 13 Distroless Node 22; no shell/npm/package manager; read-only root, no capabilities, non-root and resource limits | `scripts/runtime-smoke.js`; scheduled HIGH/CRITICAL image scan and npm audit |

## Verification commands

Use a disposable database and the corresponding updated PicPeak checkout:

```sh
PICPEAK_CHECKOUT=/path/to/picpeak TEST_DATABASE_URL=postgres://... npm run test:required
npm audit --audit-level=high
docker build --pull -t picpeak-usage:security-check .
node scripts/runtime-smoke.js picpeak-usage:security-check
```

The required command covers the collector, real cross-repository HTTP transport,
SQLite/PostgreSQL regressions, TypeScript/Vite build and Chromium UI regressions.
The runtime smoke creates uniquely named synthetic Docker resources and removes
only those resources when finished. It tests SQLite persistence across restart,
native module loading, authenticated export, sessions and opt-out in the actual
image. CI also scans the application lockfile and the built container image.

The local paired Docker workflow additionally exercises desktop/mobile consent,
real gallery upload/view with no usage transport, reporting/export, private and
named feedback, publication and marketing consent, votes, collector outage,
durable retries, restart, deletion receipts and rejoining with a fresh identity.
This is usage-feature E2E coverage, not every unrelated PicPeak feature.

## Upgrade and remaining operator responsibilities

Run the collector's migration with a single startup coordinator before scaling
replicas; upgrade PicPeak through migration 204. The collector upgrade revokes
legacy voting sessions once; reconnect from PicPeak. All replicas need the same
stable session derivation secret. Existing reports and feedback remain intact.

Homepage consumers must switch to `/api/public/marketing-testimonials` and
follow its continuation cursor. External copies, actual proxy/CDN logs, backup
retention/restores and TLS configuration remain operator responsibilities; no
production systems were changed or certified by these local tests.

A fully copied signing identity cannot be distinguished from its original,
and self-registration proves key possession, not execution of unmodified
software. These protocol limits remain explicitly disclosed. Hash-based own-data
access, small groups, backend transport and retryable signed deletion remain
supported as required by #1110.
