# Versioned usage protocol (usage.v1 / usage.v2)

Implements the backend-signs/backend-sends decision in
[#1110's transport follow-up](https://github.com/PicPeak/picpeak/issues/1110#issuecomment-5367220785).
Browser transport is not implemented. CORS is not authentication.

## Exact envelope

`POST /api/envelopes` accepts at most 16 KiB of uncompressed JSON. The complete
closed JSON Schemas are at `/schema/usage.v1.json` and `/schema/usage.v2.json`.
The bilingual field catalog is at `/schema/features.v2.json`. Unknown fields are rejected at
every level. No arbitrary attributes or free-form telemetry are supported.

| Field                    | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `packet.schema_version`  | Literal `usage.v1` or `usage.v2`; never inferred from payload |
| `packet.installation_id` | SHA-256 of Ed25519 SPKI public-key DER, lowercase hex         |
| `packet.packet_id`       | UUIDv4 identifying an immutable operation                     |
| `packet.action`          | `register`, `report`, `delete`, `feedback`, `vote`, `session`; v2 also `consent` |
| `packet.sequence`        | 0 at registration; increments per accepted operation          |
| `packet.payload`         | Action-specific closed schema, below                          |
| `public_key`             | Ed25519 SPKI DER, unpadded base64url                          |
| `issued_at`              | UTC ISO-8601 with milliseconds, within 5 minutes              |
| `nonce`                  | UUIDv4; reused nonces rejected                                |
| `signature`              | Ed25519 signature, unpadded base64url                         |

Sign the UTF-8 canonical JSON of the envelope without `signature`. Recursively
sort object keys lexicographically, preserve array order, and use JSON
string/primitive serialization. The schema excludes non-finite numbers,
undefined values, unsafe integers, and arbitrary numeric fields. Use the
included protocol implementation and conformance fixtures.

Identity is self-certifying: registration proves possession of the private key.
The key never enters browser storage. HTTPS authenticates the collector.
PicPeak validates receipt operation ID, identity, action, sequence, packet
digest, and status before acknowledging delivery.

Retries reuse the immutable packet with a fresh issue time, nonce, and signature.
An accepted packet with matching digest receives its original non-secret receipt, without
another data point. Conflicting packet IDs or sequences are rejected. A full
clone of the same private key is cryptographically indistinguishable; local
storage binding and diverging sequence detection provide additional safeguards.

## Actions

- `register`: `consent_version: usage-consent.v1` in v1 or `usage-consent.v2` in v2,
  with sequence zero. A second
  different registration for the same identity conflicts.
- `report`: `picpeak_version`, `report_date`, `generated_at`, `features`, and
  `gallery_layouts`. Dates are UTC. Version accepts release versions and
  numbered alpha/beta/rc prereleases, not arbitrary build labels. One accepted
  report per logical day; at most two per receipt day to allow a delayed report
  plus the current day. Failed delivery remains durable in PicPeak.
- `delete`: empty payload. Requires ownership proof, even for a stale sequence.
  Atomically deletes active records. Repeating deletion safely handles lost
  receipts. A one-way revocation digest blocks replayed old registrations.
- `feedback`: UUID `feedback_id`, kind (`feedback`, `feature_request`,
  `testimonial`), title (1–120 characters), body (1–4000), name (0–80),
  `allow_public`, `allow_marketing`. Deliberate submissions, separate from
  telemetry. Publication defaults off and requires permission plus review.
  Marketing permission is valid only for a public-authorized testimonial.
- `vote`: target feature-request UUID and `voted` boolean. Target must be
  published. At most one vote per installation/request.
- `session`: empty payload. Returns a pseudorandom, server-key-derived 15-minute participant token for
  portal voting. It cannot send reports, delete data, or moderate. Transfer via
  URL fragment; the UI removes it immediately and keeps it only in memory.
  The token is never stored in a receipt. Re-signing the same command can return
  the same token only while it remains valid. Expired/rotated/migrated sessions
  return the accepted receipt with `session_expired: true` and no token; request
  a new session with the next sequence, never reuse that expired command.

Daily per-installation limits: 10 feedback items, 50 sessions, 100 signed vote
changes, and 100 portal vote changes. Transport and global registration limits
provide additional abuse controls. Signatures prevent impersonating another
installation; they cannot attest that a self-hosted client runs unmodified code.

## v2 features and explicit consent upgrades

The [complete feature catalog and coverage matrix](FEATURE_COVERAGE.md) documents
every one of the 73 capabilities, its source, meaning and exclusions. v2 has
56 configured/used pairs plus 17 configuration-only booleans; those objects
forbid `used`. v1 remains unchanged with its 19 pairs. No new counters, free-form
values or visitor observations. Both applications ship identical catalogs.

`consent` is a v2-only signed command with exactly
`{ "consent_version": "usage-consent.v2" }`. It upgrades an existing v1
installation, never another identity, and is limited to one accepted upgrade
(at most one per day). Same-packet retries return the original receipt; a second
distinct upgrade returns CONSENT_ALREADY_CURRENT. A v2 report without stored
v2 consent returns CONSENT_REQUIRED, without advancing sequence or storing data.
Old v1 envelopes remain accepted/exportable, including delayed v1 reports.

Client acknowledgement atomically starts the expanded observation period and
clears old local markers. Until confirmed, only v1 markers/fields are collected.
An upgrade does not bypass the one-report-per-UTC-day rule. Opt-out always wins,
including lost receipts and in-flight consent responses. Identity and accepted
raw history are unchanged by upgrading. See OPERATIONS.md for deployment order.

Aggregate records now explicitly include their originating `schema_version`;
legacy projections lacking it are returned as v1. Missing fields stay absent.
Summary entries have `configured`, `used`, `reported`, `used_reported` counts.
Divide configured by reported, used by used_reported; denominator zero means
not collected, not 0%. `schema_versions` counts the latest reports by schema.
This avoids interpreting non-consenting v1 installations as not using v2 features.

## Legacy v1 feature signals

All features have `configured` and `used` booleans. Used is monotonic since the
current participation began. Opt-out clears all local markers.

| Feature                                                                                    | Configured                                           | Used                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `crm`                                                                                      | Clients flag                                         | Successful admin customer/CRM operation                              |
| `crm_quotes`, `crm_invoices`, `crm_contracts`, `crm_projects`, `crm_calendar`, `crm_hours` | Corresponding capability flag                        | Successful admin capability API operation                            |
| `customer_portal`                                                                          | Portal flag                                          | Successful admin invitation/send-invitation                          |
| `accounting`, `workflows`, `newsletters`                                                   | Corresponding flag                                   | Successful admin capability API operation                            |
| `face_recognition`                                                                         | Faces flag                                           | Admin faces/people operation, never visitor search                   |
| `custom_css`                                                                               | Nonempty applied global or event CSS                 | Applied CSS observed after consent; no CSS text sent                 |
| `oauth`                                                                                    | Enabled OIDC with issuer/client ID                   | Successful admin SSO callback after consent                          |
| `smtp`                                                                                     | Global or mail-account SMTP host configured          | Successful admin email test/send request                             |
| `whatsapp`                                                                                 | Enabled flag and configured enabled sender           | Successful admin WhatsApp test/send request                          |
| `backup`                                                                                   | Backup schedule enabled                              | Successful admin backup/export initiation                            |
| `s3_storage`                                                                               | S3 photo storage or S3 backup destination configured | Admin S3 photo upload, S3 test upload, or backup initiation using S3 |
| `share_mounts`                                                                             | At least one event linked to an external-media path  | Successful admin external-media operation                            |

An admin operation means successful API invocation, not completion of a later
queued job. Failed/unauthorized calls set no marker. Markers contain only
capability names, never paths, user/event IDs, times, counts, or request values.

Gallery layouts are the set of controlled enums applied to events, inspected
only during admin-triggered reporting: grid, masonry, carousel, timeline,
mosaic, gallery-premium, gallery-story, other. Unknown values become other.
No event identifiers or counts are sent. Public, gallery, visitor, and customer
portal requests never set markers or cause reports.

## Inspection, publication, and deletion

- Aggregate data is available to participants only, never anonymously. The
  reader credential is `Authorization: Bearer <lookup hash>` of a registered
  installation or a live voting session token.
- `/api/participant/summary`: latest adoption/version/layout distributions and
  daily history. Opt-out removes historical contributions too.
- `POST /api/participant/history`: bearer-authenticated time series. Body:
  `from` (inclusive UTC date or `all`), `to` (inclusive UTC date), `interval`
  (`day`, `week`, `month`) and `scope` (`all`, `own`). Defaults: last 30 days,
  daily, all reporters. Own scope is derived from the credential; participant
  callers cannot supply another installation ID. Dates are validated and ranges
  are limited to 366 periods; choose weeks/months for longer histories.
  Responses include `revision`, `available` date bounds and `points` with period
  start, clipped `from`/`to`, total `reports`, unique `reporters`, feature numerators
  and reported denominators, and version/layout/schema counts. Weeks start Monday.
  One latest report **within each period** per reporter contributes to signals
  and distributions. Report count includes all reports in the period. Empty
  periods have zero reporters/reports and zero denominators (unknown percentages).
  No forward fill; no identity, signature or private feedback fields. Used means
  used since schema consent, not per-period activity. Read from one DB snapshot.
- `/api/participant/dataset`: every latest feature projection without identity
  or signature, in pages of 200. `/api/participant/export` downloads all as
  NDJSON from one database snapshot. Pages return `revision`; pass it on requests
  with `offset > 0`. A changed/missing revision returns `DATASET_CHANGED` (409):
  restart pagination. No minimum bucket size or suppression applies.
- Public without credentials: schema, source archive, published feature requests
  and testimonials, and the transparency documentation.
- `POST /api/participant/lookup` with `installation_id`: all accepted raw report
  envelopes, received time, and signature-verification status. Hash is a private
  read credential, never a URL parameter or a public dataset field.
  This compatibility endpoint streams a complete JSON object under a read
  snapshot; `GET /api/participant/raw-export` offers the same download with a
  bearer read credential. Both include a dated export receipt. Each logical
  usage report appears once, exactly as first received; transport retries are
  deduplicated and rejected attempts/other operation types are not usage reports.
  Each report retains the original signed `envelope`; `packet` is an alias of
  `envelope.packet` for clients inspecting action/type metadata directly.
- `POST /api/participant/packets`: bounded UI preview. Body `installation_id`,
  optionally `after` (last UTC report date) and `revision` from the previous page.
  Returns up to 200 packets, `next` and `revision`. On `DATASET_CHANGED`, restart.
- Public requests/testimonials and the maintainer inbox return up to 200 items,
  ordered by immutable ID. Follow `X-Next-Cursor` with `?after=<id>`; refresh from
  the start to discover concurrent new publications. Voting-session responses
  expose the same cursor as `next`. There is no full-dataset truncation.
- Homepage consumers use `/api/public/marketing-testimonials`, which requires
  author publication AND marketing consent AND maintainer publication. The
  general `/api/public/testimonials` feed is portal-only and is NOT approval for
  homepage marketing. Neither feed exposes private consent flags or identities.
- Private feedback is maintainer-only. Publication requires submitter permission
  and review; homepage marketing requires additional permission. Opt-out deletes
  private/public feedback, requests, testimonials, votes, and all sessions.
- Maintainers use the separate configured `MAINTAINER_TOKEN` as a bearer token
  for all `/api/maintainer/*` routes. Participant hashes/sessions do not qualify.
  `GET /summary` returns the same usage summary without requiring participation.
  `POST /history` accepts the history filters above, with scope `all` only and an
  optional `installation_id` to inspect a reporter. `POST /reporters` returns
  registration metadata, report counts/date bounds and latest snapshots, with
  `after` (last reporter ID) and `revision` pagination in the JSON body, 200/page.
  `POST /packets` uses `installation_id`, `after` (report date), and `revision`,
  with the same raw page format as participant packets. IDs remain out of URLs.
  `POST /export` accepts `{}` for all reporters or `{installation_id}` for one;
  streams every retained contribution under a single DB snapshot as NDJSON.
  Records have `{type, data}`; types: `manifest`, `reporter`, `snapshot`, `report`,
  `feedback`, `vote`, `operation`, `export_receipt`. Reports contain original
  `envelope` objects; feedback includes private text, attribution, and consent.
  A filtered export includes votes cast by that reporter. The final receipt has
  per-type counts, timestamp and revision; no access/export log is persisted.
  Sessions, nonces, revocation digests, abuse counters, and deployment secrets
  are excluded. Maintainer reads never expand feedback publication permissions.
- Raw packets remain available for active participation. Opt-out removes them
  and their projections; only a one-way revocation digest remains linked to the
  former identity. Short-lived global abuse counters have no identity linkage.
  A deletion response also carries an identity-free confirmation for the user
  to retain. See OPERATIONS.md for the full retention inventory and upgrade rules.
