import React, { useEffect, useRef, useState } from "react";
import { useRequestScope } from "./useRequestScope";
import { FeatureCatalog } from "./FeatureCatalog";
import { FeatureAdoption, type FeatureSelection } from "./FeatureAdoption";
import { History } from "./History";
import { InventorySummary } from "./InventorySummary";
import { MaintainerData } from "./MaintainerData";
import { LanguageSelect, messages, type Language } from "./historyLocale";
import { createRoot } from "react-dom/client";
import {
  api,
  downloadWith,
  day,
  stamp,
  type Summary,
  type Feedback,
  type ParticipantSession,
} from "./api";
import "./style.css";

const SITE = "https://www.picpeak.app";
const PROPOSAL = "https://github.com/PicPeak/picpeak/issues/1110";
const NAV = [
  ["/", "Overview"],
  ["/packets", "Your packets"],
  ["/requests", "Feature requests"],
  ["/transparency", "Transparency"],
] as const;

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

function Failure({ retry }: { retry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      We couldn’t load this data. Check your connection or access and try again.
      {retry && (
        <button className="btn" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  text,
}: {
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <header className="page-heading">
      <p className="eyebrow rise">{eyebrow}</p>
      <h1 className="rise" style={delay(60)}>
        {title}
      </h1>
      <p className="lead rise" style={delay(140)}>
        {text}
      </p>
    </header>
  );
}

/* One credential for reading: the installation's private lookup hash. It is
   verified against the collector, then kept only in page memory. */
function AccessForm({
  onUnlock,
  label,
  eyebrow,
  intro,
}: {
  onUnlock: (hash: string) => void;
  label: string;
  eyebrow: string;
  intro: string;
}) {
  const [hash, setHash] = useState("");
  const signal = useRequestScope();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <section className="panel access" id="access">
      <p className="eyebrow">{eyebrow}</p>
      <p className="small muted">{intro}</p>
      <form
        className="lookup"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const value = hash.trim();
          setBusy(true);
          setError(false);
          try {
            await api("/api/participant/summary", { token: value, signal });
            onUnlock(value);
          } catch {
            setError(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Installation lookup hash
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            pattern="[a-f0-9]{64}"
            value={hash}
            disabled={busy}
            onChange={(e) => setHash(e.target.value)}
            placeholder="64 hexadecimal characters"
          />
        </label>
        <button className="btn primary" disabled={busy}>
          {busy ? "Checking…" : label}
        </button>
      </form>
      {error && (
        <p className="notice error" role="alert">
          No participating installation matches this hash, or the service is
          unavailable. Deleted identities no longer have access.
        </p>
      )}
      <p className="caption">
        Found in PicPeak → Settings → Product usage &amp; feedback. Read-only:
        it cannot vote, send reports, or delete data.
      </p>
    </section>
  );
}

function Overview({
  credential,
  unlock,
  expire,
}: {
  credential: string;
  unlock: (hash: string) => void;
  expire: () => void;
}) {
  const signal = useRequestScope();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState(false);
  const [selection, setSelection] = useState<FeatureSelection>();
  const [records, setRecords] = useState<unknown[] | null>(null);
  const load = () => {
    if (!credential) return;
    setError(false);
    api<Summary>("/api/participant/summary", { token: credential, signal })
      .then(setData)
      .catch((error) => {
        if (error.message === "PARTICIPANT_AUTH_REQUIRED") expire();
        else setError(true);
      });
  };
  useEffect(load, [credential]);
  const hero = (
    <div>
      <h1>
        <span className="rise" style={{ display: "block" }}>
          A clearer picture.
        </span>
        <span className="rise" style={{ ...delay(70), display: "block" }}>
          <em>A better PicPeak.</em>
        </span>
      </h1>
      <p className="lead rise" style={delay(200)}>
        Participating installations see which features help photographers most:
        the same data we use to decide what comes next.
      </p>
      <div className="hero-actions rise" style={delay(260)}>
        <a className="btn primary" href={credential ? "#adoption" : "#access"}>
          {credential ? "Explore feature adoption" : "Enter your lookup hash"}
        </a>
        <a
          className="textlink ink small"
          href="/transparency"
          onClick={(e) => navigateEvent(e, "/transparency")}
        >
          How participation works
        </a>
      </div>
      <p className="label meta rise" style={delay(340)}>
        Opt-in · Signed daily reports · Data for participants only
      </p>
    </div>
  );
  if (!credential)
    return (
      <>
        <section className="hero">
          {hero}
          <div className="rise" style={delay(120)}>
            <AccessForm
              eyebrow="Participant access"
              intro="Aggregate usage data is shown to participating installations, not to the public. Your lookup hash unlocks the dashboard, the dataset export and your own raw packets."
              label="Open the dashboard"
              onUnlock={unlock}
            />
          </div>
        </section>
        <section className="prose-columns quiet">
          <div className="prose">
            <h2>Feature signals, not analytics</h2>
            <p>
              Each participating installation sends one signed daily report:
              which capabilities are configured and which were used, as yes/no.
              Feature signals and two inventory totals. No visitor tracking or names.
            </p>
          </div>
          <div className="prose">
            <h2>Every installation is visible</h2>
            <p>
              Participants see the whole dataset, including groups of one. That
              is why it is not published anonymously: the schema and the rules
              are public, the numbers belong to the people who contribute them.
            </p>
          </div>
          <div className="prose">
            <h2>Requests are open to all</h2>
            <p>
              Published feature requests and testimonials appear only with the
              author’s permission and can be read without signing in. Voting
              needs a connected PicPeak session.
            </p>
            <a
              className="textlink ink small"
              href="/requests"
              onClick={(e) => navigateEvent(e, "/requests")}
            >
              Read the feature requests
            </a>
          </div>
        </section>
      </>
    );
  if (error) return <Failure retry={load} />;
  if (!data)
    return (
      <p className="lead" role="status">
        Loading the community picture…
      </p>
    );
  const reports = data.history.reduce((sum, row) => sum + row.reports, 0);
  return (
    <>
      <section className="hero">
        {hero}
        <ul
          className="stats rise"
          style={delay(120)}
          aria-label="Participation summary"
        >
          <li>
            <span className="label">Reporting installations</span>
            <strong>{data.installations.toLocaleString("en")}</strong>
            <small>Latest report from each participant</small>
          </li>
          <li>
            <span className="label">Accepted daily reports</span>
            <strong>{reports.toLocaleString("en")}</strong>
            <small>Retained while participation is active</small>
          </li>
          <li>
            <span className="label">{messages.en.allCapabilities}</span>
            <strong>{Object.keys(data.features).length}</strong>
            <small>Configuration / general capability use, never click counts</small>
          </li>
        </ul>
      </section>
      {!data.installations && (
        <div className="notice">
          <strong>The first reports will appear here.</strong> Enable product
          usage in PicPeak → Settings → Product usage &amp; feedback. This
          dashboard shows accepted reports only; no sample installations are
          included.
        </div>
      )}
      <FeatureAdoption data={data} onExplore={setSelection} />
      <InventorySummary inventory={data.inventory} />
      <History token={credential} selection={selection} />
      <aside className="overview-extras">
        <section className="panel">
          <p className="eyebrow">Releases</p>
          <h2>PicPeak versions</h2>
          <div className="pairs">
            {Object.entries(data.versions).map(([version, count]) => (
              <div className="pair" key={version}>
                <code>{version}</code>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          {!Object.keys(data.versions).length && (
            <p className="muted small">{data.installations ? messages.en.unknown : "Waiting for the first report."}</p>
          )}
        </section>
        <section className="panel">
          <p className="eyebrow">Gallery design</p>
          <h2>Layouts in use</h2>
          <div className="pairs">
            {Object.entries(data.layouts).map(([layout, count]) => (
              <div className="pair" key={layout}>
                <span>{layout}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          {!Object.keys(data.layouts).length && data.layouts_reported === 0 && data.installations > 0 && (
            <p className="muted small">{messages.en.unknown}</p>
          )}
          <p className="caption">
            An installation can use several layouts. Per-layout gallery counts are never
            reported.
          </p>
        </section>
        <section className="callout">
          <p className="eyebrow">Participant dataset</p>
          <h2>See the whole picture.</h2>
          <p>
            Every feature combination is included, including groups of one. No
            installation hashes or signing keys are exposed. The full export
            is a consistent snapshot at its start time.
          </p>
          <button
            className="btn primary"
            onClick={() =>
              downloadWith(
                "/api/participant/export",
                credential,
                "picpeak-usage-dataset.ndjson",
                signal,
              ).catch(() => setError(true))
            }
          >
            Download the dataset (NDJSON)
          </button>
          <button
            className="btn quiet"
            onClick={() =>
              api<{ records: unknown[] }>("/api/participant/dataset", {
                token: credential,
                signal,
              })
                .then((v) => setRecords(v.records))
                .catch(() => setError(true))
            }
          >
            Inspect the first 200 records
          </button>
        </section>
      </aside>
      {records && (
        <section className="panel section">
          <p className="eyebrow">Dataset records</p>
          <h2>The first 200 snapshots</h2>
          <p className="caption" style={{ marginTop: "0.5rem" }}>
            One latest feature snapshot per reporting installation. The complete
            dataset is available above.
          </p>
          <pre>{JSON.stringify(records, null, 2)}</pre>
        </section>
      )}
    </>
  );
}

function Packets({
  hash,
  unlock,
}: {
  hash: string;
  unlock: (hash: string) => void;
}) {
  const signal = useRequestScope();
  const [result, setResult] = useState<{
    installation_id: string;
    packets: {
      envelope: unknown;
      received_at: string;
      signature_verified: boolean;
    }[];
    next: string | null;
    revision: string;
  } | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async (after?: string) => {
    if (!hash) return;
    setBusy(true);
    setError(false);
    try {
      const value = await api<NonNullable<typeof result>>(
        "/api/participant/packets",
        {
          method: "POST",
          signal,
          body: {
            installation_id: hash,
            ...(after ? { after, revision: result?.revision } : {}),
          },
        },
      );
      if (!signal.aborted && value.installation_id === hash)
        setResult((previous) =>
          after && previous
            ? { ...value, packets: [...previous.packets, ...value.packets] }
            : value,
        );
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    setResult(null);
    void load();
  }, [hash]);
  return (
    <>
      <PageHeading
        eyebrow="Nothing hidden"
        title="Your data, exactly as received."
        text="Inspect each unique accepted usage report, exactly as first received. Transport retries are deduplicated; rejected attempts and separate feedback are not usage reports. The private lookup hash is read-only."
      />
      {!hash && (
        <AccessForm
          eyebrow="Your installation"
          intro="Enter the private lookup hash from PicPeak’s usage settings. It also unlocks the aggregate dashboard."
          label="Inspect my packets"
          onUnlock={unlock}
        />
      )}
      {hash && !result && !error && (
        <p className="muted" role="status">
          Loading your packets…
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          No accessible installation was found, or the service is unavailable.
          Deleted identities no longer have access.
          <button className="btn" onClick={() => void load()} disabled={busy}>
            Reload reports
          </button>
        </p>
      )}
      {hash && result?.installation_id === hash && (
        <section className="panel section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Accepted usage reports</p>
              <h2>
                {result.packets.length}{" "}
                {result.packets.length === 1 ? "report" : "reports"} shown
              </h2>
            </div>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void downloadWith(
                  "/api/participant/raw-export",
                  hash,
                  "picpeak-usage-packets.json",
                  signal,
                ).catch(() => {
                  if (!signal.aborted) setError(true);
                })
              }
            >
              Download all as JSON
            </button>
          </div>
          <p className="caption">
            The full download includes all accepted usage reports and a dated
            export receipt. Keep that file as your private audit record.
          </p>
          {result.packets.map((packet, index) => (
            <details key={index}>
              <summary>
                <span>{stamp(packet.received_at)}</span>
                <span className="muted">
                  {packet.signature_verified
                    ? "signature verified on receipt"
                    : "unverified"}
                </span>
              </summary>
              <pre>{JSON.stringify(packet, null, 2)}</pre>
            </details>
          ))}
          {result.next && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => void load(result.next!)}
            >
              Load more reports
            </button>
          )}
          {!result.packets.length && (
            <p className="muted small" style={{ marginTop: "1rem" }}>
              The installation is registered. Its first daily report has not
              arrived yet.
            </p>
          )}
        </section>
      )}
    </>
  );
}

function Requests({ token, expire }: { token: string; expire: () => void }) {
  const signal = useRequestScope();
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState("");
  const [testimonials, setTestimonials] = useState<Feedback[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [testimonialNext, setTestimonialNext] = useState<string | null>(null);
  const load = (after = "") => {
    setError(false);
    (token
      ? api<{ requests: Feedback[]; next: string | null }>(
          `/api/participant/session${after ? `?after=${after}` : ""}`,
          {
            token,
            signal,
          },
        ).then((v) => {
          setNext(v.next);
          return v.requests;
        })
      : api<Feedback[]>(
          `/api/public/requests${after ? `?after=${after}` : ""}`,
          { signal, onPage: setNext },
        )
    )
      .then((value) =>
        setItems((previous) =>
          after ? [...(previous || []), ...value] : value,
        ),
      )
      .catch((error) => {
        if (token && error.message === "PARTICIPANT_AUTH_REQUIRED") expire();
        else setError(true);
      });
  };
  const loadTestimonials = (after = "") => {
    api<Feedback[]>(
      `/api/public/testimonials${after ? `?after=${after}` : ""}`,
      { signal, onPage: setTestimonialNext },
    )
      .then((value) =>
        setTestimonials((previous) =>
          after ? [...previous, ...value] : value,
        ),
      )
      .catch(() => setError(true));
  };
  useEffect(() => {
    load();
    loadTestimonials();
  }, [token]);
  return (
    <>
      <PageHeading
        eyebrow="Shape what’s next"
        title="A place for the next good idea."
        text="Read community requests and support the improvements that matter to you. Public requests appear only with the author’s permission and after maintainer review."
      />
      <div className="notice">
        {token ? (
          <>
            <strong>You are connected for voting.</strong> Your session lasts 15
            minutes; opting out revokes it immediately.
          </>
        ) : (
          <>
            <strong>Voting needs a connected session.</strong> Choose “Open usage
            portal” in your PicPeak usage settings. A lookup
            hash alone does not authorize votes.
          </>
        )}{" "}
        New requests and private feedback are submitted from the same PicPeak
        settings page.
      </div>
      {error && (
        <Failure
          retry={() => {
            load();
            loadTestimonials();
          }}
        />
      )}
      {!items && !error && (
        <p className="muted" role="status">
          Loading requests…
        </p>
      )}
      <div className="requests stack">
        {items?.map((item) => (
          <article key={item.id} className="panel request">
            <button
              className={`vote ${item.voted ? "selected" : ""}`}
              disabled={!token || Boolean(busy)}
              aria-pressed={item.voted}
              aria-label={`${item.voted ? "Remove vote for" : "Vote for"} ${item.title}`}
              onClick={async () => {
                setBusy(item.id);
                try {
                  await api(`/api/participant/votes/${item.id}`, {
                    method: "PUT",
                    body: { voted: !item.voted },
                    token,
                    signal,
                  });
                  load();
                } catch (error) {
                  if (!signal.aborted) {
                    if (error instanceof Error && error.message === "PARTICIPANT_AUTH_REQUIRED") expire();
                    else setError(true);
                  }
                } finally {
                  setBusy("");
                }
              }}
            >
              <span aria-hidden="true">↑</span>
              <strong>{item.votes}</strong>
            </button>
            <div>
              <span className={`badge ${item.status}`}>
                {item.status.replaceAll("_", " ")}
              </span>
              <h2>{item.title}</h2>
              <p className="preserve">{item.body}</p>
              <small>
                {item.name || "Anonymous participant"} · {day(item.created_at)}
              </small>
            </div>
          </article>
        ))}
      </div>
      {next && (
        <button className="btn" onClick={() => load(next)}>
          Load more requests
        </button>
      )}
      {items?.length === 0 && (
        <div className="panel empty">
          <h2>Room for your next idea.</h2>
          <p>
            No feature requests have been approved for publication yet. Share
            yours from PicPeak’s feedback settings.
          </p>
        </div>
      )}
      {testimonials.length > 0 && (
        <section className="panel section">
          <p className="eyebrow">Community voices</p>
          <h2>Shared with permission</h2>
          {testimonials.map((item) => (
            <blockquote key={item.id}>
              <h3>{item.title}</h3>
              <p className="preserve">{item.body}</p>
              <cite>{item.name || "Anonymous participant"}</cite>
            </blockquote>
          ))}
          {testimonialNext && (
            <button
              className="btn"
              onClick={() => loadTestimonials(testimonialNext)}
            >
              Load more testimonials
            </button>
          )}
        </section>
      )}
    </>
  );
}

function Transparency() {
  return (
    <>
      <PageHeading
        eyebrow="Privacy you can inspect"
        title="The rules are part of the product."
        text="Participation is optional. The schema is public. Your raw packets and the aggregate dataset are inspectable by participants. Leaving deletes your contributions."
      />
      <div className="transparency-grid">
        <section className="panel prose">
          <h2>What a daily report contains</h2>
          <p>
            A pseudonymous installation fingerprint, schema version, packet ID
            and sequence, signature metadata, PicPeak version, UTC report date,
            generation time, feature booleans, controlled gallery layout
            values, and (with v3, v4 or v5 consent) two installation totals: stored galleries
            and photo records excluding videos. Drafts and retained archived records are included.
          </p>
          <p>
            Configured means the capability is enabled or has relevant
            configuration; built-in capabilities mean available, not used.
            Used means a disclosed observation (usually a successful admin capability operation)
            since consent to the current schema. v1 measures since joining;
            explicitly upgrading the schema restarts local markers. It is a yes/no signal,
            never a frequency. Configuration-only fields omit used entirely.
          </p>
          <p>All five schema versions remain supported. Existing v1/v2/v3/v4 participants
            keep their previous scope until they explicitly consent to v5 in PicPeak.
            The current v5 catalog explains 87 capability signals and two inventory totals. New edit signals exclude unchanged saves and previews; template-mail use includes real background sends accepted by the mail transport, never test messages.
            Historical views preserve earlier broad editor measurements and the retired v2/v3 allowed-downloads question separately.
            Older and partial reports remain supported; omitted or null measurements are unknown.</p>
          <p>
            Layouts: grid, masonry, carousel, timeline, mosaic, gallery-premium,
            gallery-story, or other. We never include the number of galleries
            using them.
          </p>
          <a className="btn" href="/schema/usage.v5.json">JSON schema: usage.v5</a>{" "}
          <a className="btn" href="/schema/usage.v4.json">Legacy schema: usage.v4</a>{" "}
          <a className="btn" href="/schema/usage.v3.json">Legacy schema: usage.v3</a>{" "}
          <a className="btn" href="/schema/usage.v2.json">Legacy schema: usage.v2</a>{" "}
          <a className="btn" href="/schema/usage.v1.json">Legacy schema: usage.v1</a>
        </section>
        <div className="side-panels">
          <section className="panel prose">
            <h2>What we do not collect</h2>
            <p>
              No gallery visitor tracking, clickstreams, per-gallery or per-photo
              breakdowns, image contents, biometric results, financial values,
              emails, domains, filenames, customer names, location, or
              configuration secrets in automatic reports.
            </p>
            <p>
              The network sees an address to deliver a request. This application
              does not persist it in analytics or access logs. Abuse controls
              keep an ephemeral address HMAC in memory for ten minutes; IPv6
              addresses share a /56 network budget before hashing.
            </p>
          </section>
          <section className="panel prose">
            <h2>Participants see everything</h2>
            <p>
              The aggregate dataset includes every reporting installation’s
              latest feature combination and results, including groups of one.
              It excludes installation fingerprints, raw signatures and private
              feedback. Rare combinations can still be distinctive: this is
              pseudonymous participation, not a promise of anonymity.
            </p>
            <p>
              That is why the numbers are not published anonymously. Your lookup
              hash unlocks the dashboard, the dataset export and all of your
              unique accepted usage reports while you participate. Keep it
              private. The schema, the rules, feature requests and testimonials
              stay public.
            </p>
          </section>
          <section className="panel prose">
            <h2>Leaving means deletion</h2>
            <p>
              Disable participation in PicPeak to stop collection immediately.
              PicPeak signs a deletion request; the collector deletes reports,
              projections, feedback, publications, votes, and sessions. The
              local key and hash are removed after confirmation. Outages leave
              deletion visibly pending and retryable.
            </p>
            <p>
              Only a one-way revocation digest remains to prevent old
              registrations from being replayed. It cannot retrieve a former
              installation’s data. A new opt-in generates a fresh identity.
              Short-lived global abuse counters contain no installation
              identity.
            </p>
          </section>
        </div>
      </div>
      <FeatureCatalog />
      <section className="prose-columns">
        <div className="prose">
          <h2>Feedback has separate consent</h2>
          <p>
            Feedback is sent only when you submit it. You choose anonymity or a
            name per item. Private feedback is maintainer-only; feature requests
            and testimonials need your publication permission and review.
            Homepage marketing requires an additional explicit permission.
            Opt-out removes these items and their votes too.
          </p>
        </div>
        <div className="prose">
          <h2>Signing and retention</h2>
          <p>
            PicPeak holds the Ed25519 private key on its backend and signs every
            operation. The collector checks the public-key fingerprint, schema,
            signature, timestamp, nonce, sequence and packet identity. Re-signed
            retries of the same packet are idempotent; reused nonces are
            rejected. Full copies of the same signing identity cannot be
            distinguished by cryptography alone: registration and sequence
            conflicts stop reporting and require review.
          </p>
          <p>
            Accepted raw reports are retained throughout active participation.
            Security nonces expire after ten minutes and voting sessions after
            fifteen. Cleanup runs at startup, on valid submissions and every
            minute. Tokens are never stored in operation receipts. Deletion
            removes active data and historical aggregate contributions.
            Signatures establish key ownership; they cannot attest that a
            self-hosted client runs unmodified software.
          </p>
        </div>
        <div className="prose">
          <h2>Auditable software</h2>
          <p>
            This service is developed as the separate <code>picpeak-usage</code>{" "}
            application alongside the{" "}
            <a className="textlink ink" href={PROPOSAL} rel="noreferrer">
              public PicPeak usage proposal
            </a>
            . The deployment includes the protocol, collector, UI, database
            migrations, tests, and operator documentation.
          </p>
          <a className="btn" href="/source.tar.gz" download>
            Download this deployment’s source
          </a>
        </div>
      </section>
      <section className="panel prose section">
        <h2>Retention and your audit receipts</h2>
        <p>
          A report export contains each unique accepted usage report exactly as
          first received, with a dated receipt and report count. Re-signed
          transport retries are deduplicated; rejected attempts, registration,
          session commands and separate feedback are not usage reports. Dataset
          exports are consistent snapshots at export start. Already downloaded
          copies cannot be recalled by a later opt-out.
        </p>
        <p>
          Download receipts to keep your own audit trail. PicPeak can show its
          latest local export receipt and identity-free deletion confirmation;
          opt-out clears the export receipt and all local identity/key material.
          The collector does not keep a personal export/access history. Receipts
          document acknowledgement, not forensic proof of storage erasure.
        </p>
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>How long it remains</th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                "Registration, public key and sequence",
                "While participating; deleted on opt-out.",
              ],
              [
                "First accepted raw reports",
                "All logical reports while participating; deleted on opt-out.",
              ],
              [
                "Latest projections and aggregate cache",
                "While participating; committed deletion invalidates caches across replicas.",
              ],
              [
                "Feedback, names, publication/marketing choices and votes",
                "Separate from telemetry; deleted on opt-out, including votes on deleted requests.",
              ],
              [
                "Operation IDs, digests, dates and non-secret receipts",
                "While participating, for retries and quotas; deleted on opt-out. No bearer tokens.",
              ],
              [
                "Voting-session token hashes",
                "15-minute validity, then the next cleanup cycle; never plaintext tokens.",
              ],
              ["Security nonces", "10 minutes, then the next cleanup cycle."],
              [
                "Global admission counters",
                "Current and previous UTC day only, then cleanup; no identity or IP.",
              ],
              [
                "Database revision and migration version",
                "Constant-size coordination state, with no identity history.",
              ],
              [
                "One-way revocation digests",
                "Persistent, to prevent old identities being registered again; no lookup access.",
              ],
              [
                "Address HMAC limits",
                "Process memory for ten-minute windows; no persistent IP, origin or user-agent.",
              ],
              [
                "Audit receipts",
                "Held by the requester; no central personal audit history. PicPeak keeps only the local latest receipts described above.",
              ],
              [
                "Infrastructure logs and backups",
                "No app access logger or automatic backup. Operators must disclose any separate backup retention, apply revocations on restore, and avoid payloads/credentials in logs; essential security logs should be kept at most 24 hours.",
              ],
            ].map(([data, retention]) => (
              <tr key={data}>
                <th scope="row">{data}</th>
                <td>{retention}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Homepage integrations use the marketing-approved testimonial feed,
          never the general portal testimonial list.
        </p>
      </section>
    </>
  );
}

function Maintainer() {
  const [epoch, setEpoch] = useState(0);
  return (
    <MaintainerSession
      key={epoch}
      signOut={() => setEpoch((value) => value + 1)}
    />
  );
}

function MaintainerSession({ signOut }: { signOut: () => void }) {
  const [language, setLanguage] = useState<Language>("en");
  const t = messages[language];
  const signal = useRequestScope();
  const [token, setToken] = useState("");
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const load = async (after = "") => {
    setError(false);
    setBusy(true);
    try {
      const value = await api<Feedback[]>(
        `/api/maintainer/feedback${after ? `?after=${after}` : ""}`,
        { token, signal, onPage: setNext },
      );
      setItems((previous) => (after ? [...(previous || []), ...value] : value));
    } catch {
      setError(true);
      setItems(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeading
        eyebrow="Maintainer workspace"
        title={t.workspaceTitle}
        text={t.workspaceIntro}
      />
      <div className="maintainer-language">
        <LanguageSelect language={language} setLanguage={setLanguage} />
      </div>
      {!items && (
        <form
          className="panel lookup"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            void load();
          }}
        >
          <label>
            Maintainer access token
            <input
              type="password"
              autoComplete="off"
              value={token}
              disabled={busy}
              onChange={(e) => setToken(e.target.value)}
              required
              minLength={32}
            />
          </label>
          <button className="btn primary" disabled={busy}>
            {t.openWorkspace}
          </button>
        </form>
      )}
      {items && (
        <div className="section-heading">
          <p className="caption">
            {items.length} {items.length === 1 ? "item" : "items"} in the inbox
          </p>
          <button className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      )}
      {error && <Failure />}
      {items && <MaintainerData key={token} token={token} language={language} />}
      {items && <h2 className="section">{t.feedback}</h2>}
      {items?.length === 0 && (
        <div className="panel empty section">
          <h2>Your inbox is clear.</h2>
          <p>Private and publication-requested feedback will appear here.</p>
        </div>
      )}
      <div className="stack section">
        {items?.map((item) => (
          <article key={item.id} className="panel moderation">
            <span className="badge">{item.kind?.replaceAll("_", " ")}</span>
            <h2>{item.title}</h2>
            <p className="preserve">{item.body}</p>
            <p className="caption">
              {item.name || "Anonymous"} · {day(item.created_at)} · publication{" "}
              {item.allow_public ? "permitted" : "not permitted"} · marketing{" "}
              {item.allow_marketing ? "permitted" : "not permitted"}
            </p>
            <div className="moderation-controls">
              <label>
                Status
                <select
                  value={item.status}
                  onChange={(e) =>
                    setItems(
                      items.map((row) =>
                        row.id === item.id
                          ? { ...row, status: e.target.value }
                          : row,
                      ),
                    )
                  }
                >
                  {[
                    "open",
                    "planned",
                    "in_progress",
                    "completed",
                    "declined",
                  ].map((status) => (
                    <option key={status} value={status}>
                      {status.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={Boolean(item.published)}
                  disabled={!item.allow_public || item.kind === "feedback"}
                  onChange={(e) =>
                    setItems(
                      items.map((row) =>
                        row.id === item.id
                          ? { ...row, published: e.target.checked }
                          : row,
                      ),
                    )
                  }
                />
                Publish this item
              </label>
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(false);
                  try {
                    await api(`/api/maintainer/feedback/${item.id}`, {
                      method: "PATCH",
                      body: {
                        published: Boolean(item.published),
                        status: item.status,
                      },
                      token,
                      signal,
                    });
                    await load();
                  } catch {
                    setError(true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Save review
              </button>
            </div>
          </article>
        ))}
      </div>
      {next && (
        <button className="btn" disabled={busy} onClick={() => void load(next)}>
          Load more feedback
        </button>
      )}
    </>
  );
}

/* Client-side navigation shared by the header, footer and in-page links. */
let setRouteGlobal: ((route: string) => void) | null = null;
function navigateEvent(
  event: React.MouseEvent<HTMLAnchorElement>,
  href: string,
) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState(null, "", href);
  setRouteGlobal?.(href);
  window.scrollTo(0, 0);
}

function Brand() {
  return (
    <a className="brand" href="/" onClick={(e) => navigateEvent(e, "/")}>
      <img src="/picpeak-mark.svg" alt="" width={37} height={28} />
      PicPeak <span>Usage</span>
    </a>
  );
}

function App() {
  const [route, setRoute] = useState(location.pathname);
  const [session, setSession] = useState<{ token: string; expiresAt: number } | null>(null);
  const [hash, setHash] = useState("");
  const [sessionError, setSessionError] = useState(false);
  const connecting = useRef<AbortController | null>(null);
  setRouteGlobal = setRoute;
  const token = session?.token || "";
  const credential = hash;
  const signOut = () => {
    connecting.current?.abort();
    setSession(null);
    setHash("");
    setSessionError(false);
  };
  const unlock = (value: string) => {
    connecting.current?.abort();
    setSession(null);
    setHash(value);
    setSessionError(false);
  };
  useEffect(() => {
    if (!session) return;
    const expire = () => {
      if (Date.now() >= session.expiresAt) {
        setSession(null);
        setSessionError(true);
      }
    };
    const timer = window.setTimeout(expire, Math.max(0, session.expiresAt - Date.now()));
    // Background tabs may suspend timers; check again when the page resumes.
    window.addEventListener("focus", expire);
    document.addEventListener("visibilitychange", expire);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", expire);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [session]);
  useEffect(() => {
    const controller = new AbortController();
    const connect = new URLSearchParams(location.hash.slice(1)).get("connect");
    if (connect) {
      connecting.current = controller;
      history.replaceState(null, "", location.pathname);
      api<ParticipantSession>("/api/participant/session", {
        token: connect,
        signal: controller.signal,
      })
        .then((value) => {
          setHash(value.installation_id);
          setSession({ token: connect, expiresAt: Date.parse(value.expires_at) });
          setRoute("/requests");
          history.replaceState(null, "", "/requests");
        })
        .catch(() => {
          if (!controller.signal.aborted) setSessionError(true);
        });
    }
    const pop = () => setRoute(location.pathname);
    window.addEventListener("popstate", pop);
    return () => {
      controller.abort();
      window.removeEventListener("popstate", pop);
    };
  }, []);
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="wrap topbar">
        <Brand />
        <nav aria-label="Main navigation">
          {NAV.map(([href, label]) => (
            <a
              key={href}
              className="textlink"
              href={href}
              aria-current={route === href ? "page" : undefined}
              onClick={(e) => navigateEvent(e, href)}
            >
              {label}
            </a>
          ))}
          <a className="textlink" href={SITE}>
            picpeak.app
          </a>
          {credential && (
            <button className="btn quiet nav-signout" onClick={signOut}>
              Sign out
            </button>
          )}
        </nav>
      </header>
      <main id="main">
        {sessionError && (
          <div className="notice error" role="alert">
            That voting connection has expired or is invalid. Open a new session
            from PicPeak.
          </div>
        )}
        {route === "/" ? (
          <Overview
            key={credential}
            credential={credential}
            unlock={unlock}
            expire={signOut}
          />
        ) : route === "/packets" ? (
          <Packets key={hash} hash={hash} unlock={unlock} />
        ) : route === "/requests" ? (
          <Requests
            key={token}
            token={token}
            expire={() => {
              setSession(null);
              setSessionError(true);
            }}
          />
        ) : route === "/transparency" ? (
          <Transparency />
        ) : route === "/maintainer" ? (
          <Maintainer key={credential} />
        ) : (
          <PageHeading
            eyebrow="404"
            title="This page isn’t here."
            text="Use the navigation to return to the community dashboard."
          />
        )}
      </main>
      <footer>
        <div className="wrap">
          <p>PicPeak Usage · MIT license · Opt-in, no visitor tracking</p>
          <nav aria-label="Footer">
            {NAV.map(([href, label]) => (
              <a
                key={href}
                className="textlink"
                href={href}
                onClick={(e) => navigateEvent(e, href)}
              >
                {label}
              </a>
            ))}
            <a className="textlink" href={PROPOSAL} rel="noreferrer">
              Proposal on GitHub
            </a>
            <a className="textlink" href={SITE}>
              picpeak.app
            </a>
            <a
              className="textlink"
              href="/maintainer"
              onClick={(e) => navigateEvent(e, "/maintainer")}
            >
              Maintainer access
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
