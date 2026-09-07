# Weekly maintainer email

The collector can send a confidential weekly report to one or more trusted
maintainers. This is optional and disabled by default. It uses the same green
palette, wordmark, headings and panels as the portal, with email-compatible
tables and inline styles. A complete plain-text alternative is included.
Fonts fall back to locally available fonts; the message loads no remote images,
web fonts, trackers or scripts.

Each report starts with new requests and messages, followed by usage insights:

- Every new feature request, private feedback message and testimonial, including
  unpublished and unreviewed messages, with the complete submitted text and a
  direct link. Large inboxes continue in numbered emails; there is no 200-item
  cutoff and no truncation of individual messages.
- New registrations and completed opt-outs, including installations that never
  sent a usage report. These are installations, not people or gallery visitors.
- The current registered installation count, received reports and reporting
  installations, with a comparison to the previous week.
- Gallery/photo totals with reporting coverage, top used features, the largest
  comparable percentage-point changes, newly reported fields and versions.

## Configure `.env`

Copy `.env.example` to `.env` and set your real SMTP values. `npm start`,
`npm run dev:server` and the weekly CLI commands load `.env` automatically.
Docker Compose passes these settings to the container; restart it after changes.
All replicas sharing a database must use the same weekly reporting configuration.

```dotenv
MAINTAINER_TOKEN=replace-with-at-least-32-random-characters
WEEKLY_REPORT_ENABLED=true
WEEKLY_REPORT_TO=maintainer@example.com
WEEKLY_REPORT_BASE_URL=https://usage.picpeak.app
WEEKLY_REPORT_LANGUAGE=en
WEEKLY_REPORT_DAY=monday
WEEKLY_REPORT_TIME=08:00

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_TLS_MODE=starttls
SMTP_USER=mailer@example.com
SMTP_PASSWORD='replace-with-your-smtp-password'
SMTP_FROM=mailer@example.com
SMTP_FROM_NAME=PicPeak Usage
```

Set `WEEKLY_REPORT_LANGUAGE=de` for German. The email language is an operator
setting and is independent of the language selected in a maintainer's browser.

| Variable | Meaning / default |
| --- | --- |
| `WEEKLY_REPORT_ENABLED` | `false`; explicitly set `true` to enable scheduling and aggregate join/opt-out counts |
| `WEEKLY_REPORT_TO` | Required when enabled; 1–20 comma-separated plain mailbox addresses for authorized maintainers. Each receives a separate copy. |
| `WEEKLY_REPORT_BASE_URL` | `https://usage.picpeak.app`; HTTPS origin used for links. No credentials, query or path. HTTP loopback is allowed for local tests. |
| `WEEKLY_REPORT_LANGUAGE` | `en` or `de`, default `en` |
| `WEEKLY_REPORT_DAY` | English weekday name, default `monday` |
| `WEEKLY_REPORT_TIME` | `HH:MM`, default `08:00`, **UTC** |
| `SMTP_HOST` | Required SMTP hostname or IP |
| `SMTP_PORT` | Default 587 for STARTTLS, 465 for implicit TLS when omitted in a native environment. Compose defaults to 587, so explicitly set 465 with `SMTP_TLS_MODE=tls`. |
| `SMTP_TLS_MODE` | `starttls` requires STARTTLS; `tls` starts encrypted; `none` explicitly disables encryption for a trusted local relay |
| `SMTP_USER`, `SMTP_PASSWORD` | Username/password authentication; leave both empty for an unauthenticated relay |
| `SMTP_AUTH_METHOD` | Optional `PLAIN`, `LOGIN` or `CRAM-MD5`; otherwise negotiated |
| `SMTP_FROM` | Required plain sender mailbox |
| `SMTP_FROM_NAME` | Sender display name, default `PicPeak Usage` |
| `SMTP_REPLY_TO` | Optional plain reply-to mailbox |
| `SMTP_CA_FILE` | Optional path to a PEM CA certificate; mount this path read-only when using Docker |
| `SMTP_TLS_SERVERNAME` | Optional TLS certificate hostname when connecting by IP; defaults to `SMTP_HOST` |
| `SMTP_TIMEOUT_MS` | Connection, greeting and socket inactivity timeout; default 30000, allowed 1000–120000 |

TLS certificates are verified and TLS 1.2 or later is required. For a private
certificate authority, provide `SMTP_CA_FILE`; there is no certificate-check
bypass. SMTP debug/transaction logs are disabled. An invalid enabled configuration
fails at startup with the setting name, without printing its value or credentials.
Keep the recipient list limited to people authorized to read private feedback.

## Preview and verify without sending

With the enabled configuration present:

```sh
npm run weekly:verify
npm run weekly:preview
```

`weekly:verify` checks the SMTP connection and authentication without sending an
email. It does not prove that the sender/recipient or final delivery will be
accepted. `weekly:preview` renders the first part of the latest completed week's
report to `.local/weekly-report.html` and `.local/weekly-report.txt`, with mode
0600. It sends no email and does not advance the delivery schedule. These files
may contain private feedback; they are ignored by Git and source archives.
An optional output prefix can follow `npm run weekly:preview --`.

## Scheduling, retries and links

Report windows are Monday 00:00 through the following Monday 00:00, in UTC,
matching the portal's UTC date convention. The configured delivery day/time is
in the following week. The first run is the next scheduled delivery after
enabling; it covers the preceding complete calendar week. Join/opt-out counts
from before tracking started are explicitly unknown or marked partial.

The worker checks once per minute, so delivery begins within approximately a
minute of the configured time while the service is healthy. It runs in the
collector process; no external cron or separate worker container is needed.
Persistent per-recipient cursors survive restarts. If the service misses weeks,
it catches up in order. Each minute delivers at most one part per recipient,
so a large backlog is spread across multiple bounded emails.

Successful recipients and parts are recorded independently. SMTP failures retry
after 5 minutes with exponential backoff, capped at 6 hours. A database lease
prevents normal duplicate sends across replicas; crashed leases expire after
15 minutes. Messages have stable Message-IDs on retry. SMTP cannot provide
exactly-once delivery: a crash or connection loss after transport acceptance
but before its durable receipt can cause a duplicate. Transport acceptance is
not proof of inbox delivery or reading. Error logs contain only fixed error codes.

Message links look like `/maintainer?feedback=<message-id>#feedback-<message-id>`.
They contain no access token or installation lookup hash. Sign in with the
normal maintainer token to open even unpublished messages outside the first
page of the inbox. Deleted messages show an unavailable notice and a link back
to the inbox. Feature links select the relevant capability and open its history.

## Interpretation and retention

Reports are grouped by **receipt time**, so delayed submissions are included in
the week they arrived. For feature and inventory comparisons, each installation
contributes the newest report date among its reports received in that week.
The portal history groups by report date; late arrivals can therefore make its
calendar-week totals differ from the email. Usage still means an observation
since schema consent, not weekly frequency. Missing fields are unknown, and
percentages use the number of installations reporting the field. Changes in
reporter composition can change both percentages and total inventory. A newly
reported field or version means absent from the previous week's retained data,
not first-ever use. Opt-out removes retained usage contributions from both weeks.

When enabled, `weekly_activity` stores only a UTC day and aggregate joined/removed
counts, for at most 90 days plus the cleanup interval. No installation identifier,
hash, address, message or event log is stored in those counts. They survive
individual opt-outs so completed removals remain countable; disabling weekly
reporting clears them. Windows outside that retention or before activation are
marked partial/unknown, not filled with invented zeros.

`weekly_recipients` holds hashed configured recipient addresses, the next period,
part number, lease/retry state and the last successful SMTP acceptance time.
It contains no email body, subject, SMTP password or installation identity.
During a multipart report, `weekly_feedback_receipts` references already accepted
live feedback items. These references cascade away on author opt-out and are
cleared at completion of that recipient's weekly report. Removed recipient
configurations and disabling reporting clear their delivery state.

Email content is rebuilt from retained data before each send; opted-out feedback
is excluded from later parts/retries. Already delivered or in-flight email copies
cannot be recalled. Operators control SMTP provider and mailbox retention and
must protect private feedback there. The collector keeps no email-content archive.
Public transparency text discloses this optional delivery and aggregate-counter
retention. Automatic PicPeak report schemas and their consent scopes are unchanged.

When restoring a database, apply opt-out revocations before starting the service,
and preserve its delivery state to avoid replaying previously sent reports.
Changing SMTP credentials does not reset delivery cursors. To stop reporting,
set `WEEKLY_REPORT_ENABLED=false` on every replica and restart.
