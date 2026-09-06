# Maintainer access and usage history

The `/maintainer` workspace accepts the deployment's `MAINTAINER_TOKEN` without
requiring a participant registration. It provides the reporter directory,
registration/latest-snapshot inspection, original accepted report inspection,
and full or per-reporter exports of all retained contributions. Feedback review
remains available below the usage data. Author publication/marketing consent
still controls publication, independently of maintainer read access.

Participants use their lookup hash or a live voting session on the overview to
switch between their own and all reporters' time series. They cannot inspect
other reporters' original envelopes or private feedback through these routes.

History supports UTC days, Monday-based weeks and calendar months. Select a
preset/custom range or all retained history (monthly), a metric, a capability
or version/layout/schema, and counts or percentages. Each reporter contributes
its last report within the period. Report counts separately include all accepted
reports. There is no forward fill, and missing fields do not enter feature
denominators. Use means used since schema consent, not activity during a period.
Charts, accessible tables and JSON downloads share the same response. New views
and the data-access disclosure support English and German.

API details and export record types are documented in [PROTOCOL.md](PROTOCOL.md).
No schema migration, additional collection or new client protocol is required.
Deploy the updated collector/frontend together using the normal build process.
Raw report responses also expose `packet` as an alias of `envelope.packet` so
the current PicPeak client counts exported reports correctly. The signed
envelope remains unchanged. The shared catalog reflects the client's clarified
image-protection signal, and retry tests use the explicit retry API when
bypassing unattended backoff.

## Verification, 2026-09-06

- 50 backend/integration tests passed, no skips: SQLite, isolated PostgreSQL 15,
  and the real PicPeak usage client from the feature-coverage checkout.
- 12 Playwright browser tests passed, including the new participant and
  maintainer journeys at 1280 px and 390 px, German labels, history/raw exports,
  private-state cleanup and cancellation of an in-flight export on logout.
- TypeScript and Vite production build passed; Git whitespace check passed.
- Signed-report tests verify UTC week/month boundaries, per-reporter weighting,
  mixed v1/v2 denominators, configuration-only fields, missing days, own/all
  scopes, invalid/expired credentials, and removal of historical contributions
  and raw access on opt-out. Synthetic 206-reporter fixtures verify pagination
  and complete exports beyond the 200-record preview limit on both databases.
- A local SQLite benchmark with 1,000 synthetic reporters and 30,000 reports
  took approximately 0.50 s for 30 daily periods, 0.14 s for five weekly periods,
  and 0.09 s for one monthly period. The initial daily query took 4.72 s on the
  same dataset. These are local measurements, not production latency guarantees.

```sh
TEST_DATABASE_URL=postgres://.../isolated_test_database \
PICPEAK_CHECKOUT=/path/to/picpeak npm test
npm run test:e2e
git diff --check
```

Use an isolated PostgreSQL database: tests create synthetic data and disposable
schemas. Browser screenshots are written under the gitignored `test-results/`.
