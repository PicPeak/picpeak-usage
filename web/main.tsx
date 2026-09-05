import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  download,
  featureNames,
  day,
  stamp,
  type Summary,
  type Feedback,
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

function Overview() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [metric, setMetric] = useState<"configured" | "used">("used");
  const [records, setRecords] = useState<unknown[] | null>(null);
  const load = () => {
    setError(false);
    api<Summary>("/api/public/summary")
      .then(setData)
      .catch(() => setError(true));
  };
  useEffect(load, []);
  if (error) return <Failure retry={load} />;
  if (!data)
    return (
      <p className="lead" role="status">
        Loading the community picture…
      </p>
    );
  const entries = Object.entries(data.features)
    .filter(([key]) =>
      (featureNames[key] || key).toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b[1][metric] - a[1][metric]);
  const reports = data.history.reduce((sum, row) => sum + row.reports, 0);
  const peak = Math.max(...data.history.map((r) => r.reports), 1);
  return (
    <>
      <section className="hero">
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
            Which features help photographers most? Explore the same open data
            we use to decide what comes next.
          </p>
          <div className="hero-actions rise" style={delay(260)}>
            <a className="btn primary" href="#adoption">
              Explore feature adoption
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
            Opt-in · Signed daily reports · No visitor tracking
          </p>
        </div>
        <ul className="stats rise" style={delay(120)} aria-label="Participation summary">
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
            <span className="label">Documented capabilities</span>
            <strong>{Object.keys(data.features).length}</strong>
            <small>Configured and used as yes/no, never click counts</small>
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
      <div className="dashboard-grid">
        <section className="panel adoption" id="adoption">
          <p className="eyebrow">Feature adoption</p>
          <h2>What’s being used</h2>
          <div className="controls">
            <label className="search">
              Find a capability
              <input
                type="search"
                placeholder="Search features…"
                autoComplete="off"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label className="metric">
              Show
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as typeof metric)}
              >
                <option value="used">Used since joining</option>
                <option value="configured">Currently configured</option>
              </select>
            </label>
          </div>
          <p className="caption">
            Share of {data.installations} reporting installations · includes
            groups of one
          </p>
          <div className="feature-list">
            {entries.map(([key, value]) => {
              const percent = data.installations
                ? Math.round((value[metric] / data.installations) * 100)
                : 0;
              return (
                <article className="feature-row" key={key}>
                  <div>
                    <span>{featureNames[key] || key}</span>
                    <strong>
                      {percent}%<small>({value[metric]})</small>
                    </strong>
                  </div>
                  <div
                    className="bar"
                    role="meter"
                    aria-label={featureNames[key] || key}
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </article>
              );
            })}
            {entries.length === 0 && (
              <p className="muted small">No matching capabilities.</p>
            )}
          </div>
        </section>
        <aside className="side-panels">
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
              <p className="muted small">Waiting for the first report.</p>
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
            <p className="caption">
              An installation can use several layouts. Gallery counts are never
              reported.
            </p>
          </section>
          <section className="callout">
            <p className="eyebrow">Open data</p>
            <h2>See the whole picture.</h2>
            <p>
              Every feature combination is included. No installation hashes or
              signing keys are exposed.
            </p>
            <a className="btn primary" href="/api/public/export" download>
              Download public dataset (NDJSON)
            </a>
            <button
              className="btn quiet"
              onClick={() =>
                api<{ records: unknown[] }>("/api/public/dataset")
                  .then((v) => setRecords(v.records))
                  .catch(() => setError(true))
              }
            >
              Inspect the first 200 records
            </button>
          </section>
        </aside>
      </div>
      <section className="panel section">
        <p className="eyebrow">Participation over time</p>
        <h2>Daily report history</h2>
        <p className="caption" style={{ marginTop: "0.5rem" }}>
          Reports per UTC day from installations still participating. Opt-out
          removes historical contributions too.
        </p>
        <div className="history">
          {data.history.slice(-30).map((row) => (
            <div key={row.date}>
              <span>{row.date}</span>
              <div className="bar">
                <span style={{ width: `${(row.reports / peak) * 100}%` }} />
              </div>
              <strong>{row.reports}</strong>
            </div>
          ))}
        </div>
        {!data.history.length && (
          <p className="muted small" style={{ marginTop: "1rem" }}>
            No reports yet.
          </p>
        )}
      </section>
      {records && (
        <section className="panel section">
          <p className="eyebrow">Public records</p>
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

function Packets() {
  const [hash, setHash] = useState("");
  const [result, setResult] = useState<{
    installation_id: string;
    packets: {
      envelope: unknown;
      received_at: string;
      signature_verified: boolean;
    }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <PageHeading
        eyebrow="Nothing hidden"
        title="Your data, exactly as received."
        text="Enter the private lookup hash from PicPeak’s usage settings to inspect and download your accepted packets. It gives read-only access; it cannot submit reports, vote, or delete data."
      />
      <form
        className="panel lookup"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(false);
          setResult(null);
          try {
            setResult(
              await api("/api/participant/lookup", {
                method: "POST",
                body: { installation_id: hash.trim() },
              }),
            );
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
            onChange={(e) => setHash(e.target.value)}
            placeholder="64 hexadecimal characters"
          />
        </label>
        <button className="btn primary" disabled={busy}>
          {busy ? "Looking up…" : "Inspect my packets"}
        </button>
      </form>
      {error && (
        <p className="notice error" role="alert">
          No accessible installation was found, or the service is unavailable.
          Check the hash and try again. Deleted identities no longer have
          access.
        </p>
      )}
      {result && (
        <section className="panel section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Accepted packets</p>
              <h2>
                {result.packets.length}{" "}
                {result.packets.length === 1 ? "packet" : "packets"} on record
              </h2>
            </div>
            <button
              className="btn"
              onClick={() => download(result, "picpeak-usage-packets.json")}
            >
              Download all as JSON
            </button>
          </div>
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
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState("");
  const [testimonials, setTestimonials] = useState<Feedback[]>([]);
  const load = () => {
    setError(false);
    (token
      ? api<{ requests: Feedback[] }>("/api/participant/session", {
          token,
        }).then((v) => v.requests)
      : api<Feedback[]>("/api/public/requests")
    )
      .then(setItems)
      .catch((error) => {
        if (token && error.message === "PARTICIPANT_AUTH_REQUIRED") expire();
        else setError(true);
      });
    api<Feedback[]>("/api/public/testimonials")
      .then(setTestimonials)
      .catch(() => setError(true));
  };
  useEffect(load, [token]);
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
            <strong>You are connected for voting.</strong> Your session lasts
            15 minutes; opting out revokes it immediately.
          </>
        ) : (
          <>
            <strong>Voting needs a connected session.</strong> Choose “Connect
            to requests &amp; voting” in your PicPeak usage settings. A lookup
            hash alone does not authorize votes.
          </>
        )}{" "}
        New requests and private feedback are submitted from the same PicPeak
        settings page.
      </div>
      {error && <Failure retry={load} />}
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
                  });
                  load();
                } catch {
                  setError(true);
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
        text="Participation is optional. The schema is public. Your raw packets are inspectable. Leaving deletes your contributions."
      />
      <div className="transparency-grid">
        <section className="panel prose">
          <h2>What a daily report contains</h2>
          <p>
            A pseudonymous installation fingerprint, schema version, packet ID
            and sequence, signature metadata, PicPeak version, UTC report date,
            generation time, feature booleans, and controlled gallery layout
            values.
          </p>
          <p>
            Configured means the capability is enabled or has relevant
            configuration. Used means an allowlisted successful admin operation
            has been observed since joining. It is a yes/no signal, never a
            frequency. The schema’s feature names:
          </p>
          <ul>
            {Object.values(featureNames).map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p>
            Layouts: grid, masonry, carousel, timeline, mosaic, gallery-premium,
            gallery-story, or other. We never include the number of galleries
            using them.
          </p>
          <a className="btn" href="/schema/usage.v1.json">
            Read the exact JSON schema
          </a>
        </section>
        <div className="side-panels">
          <section className="panel prose">
            <h2>What we do not collect</h2>
            <p>
              No gallery visitor tracking, clickstreams, photo or gallery
              counts, emails, domains, filenames, customer names, location, or
              configuration secrets in automatic reports.
            </p>
            <p>
              The network sees an address to deliver a request. This application
              does not persist it in analytics or access logs. Abuse controls
              keep an ephemeral address HMAC in memory for ten minutes.
            </p>
          </section>
          <section className="panel prose">
            <h2>Public means inspectable</h2>
            <p>
              The public dataset includes every reporting installation’s latest
              feature combination and aggregate results, including groups of
              one. It excludes installation fingerprints, raw signatures and
              private feedback. Rare combinations can still be distinctive: this
              is pseudonymous participation, not a promise of anonymity.
            </p>
            <p>
              Your lookup hash grants access to all accepted raw packets while
              you participate. Keep it private.
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
            </p>
          </section>
        </div>
      </div>
      <section className="prose-columns">
        <div className="prose">
        <h2>Feedback has separate consent</h2>
        <p>
          Feedback is sent only when you submit it. You choose anonymity or a
          name per item. Private feedback is maintainer-only; feature requests
          and testimonials need your publication permission and review. Homepage
          marketing requires an additional explicit permission. Opt-out removes
          these items and their votes too.
        </p>
        </div>
        <div className="prose">
        <h2>Signing and retention</h2>
        <p>
          PicPeak holds the Ed25519 private key on its backend and signs every
          operation. The collector checks the public-key fingerprint, schema,
          signature, timestamp, nonce, sequence and packet identity. Re-signed
          retries of the same packet are idempotent; reused nonces are rejected.
          Full copies of the same signing identity cannot be distinguished by
          cryptography alone: registration and sequence conflicts stop reporting
          and require review.
        </p>
        <p>
          Accepted raw reports are retained throughout active participation.
          Security nonces expire after ten minutes and voting sessions after
          fifteen. Deletion removes active data and historical aggregate
          contributions. Signatures establish key ownership; they cannot attest
          that a self-hosted client runs unmodified software.
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
    </>
  );
}

function Maintainer() {
  const [token, setToken] = useState("");
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setError(false);
    setBusy(true);
    try {
      setItems(await api("/api/maintainer/feedback", { token }));
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
        title="Listen first. Publish with permission."
        text="Private feedback stays here. Author permission is required before any item can appear publicly. Access tokens stay in this page’s memory."
      />
      {!items && (
        <form
          className="panel lookup"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label>
            Maintainer access token
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              minLength={32}
            />
          </label>
          <button className="btn primary" disabled={busy}>
            Open feedback inbox
          </button>
        </form>
      )}
      {items && (
        <div className="section-heading">
          <p className="caption">
            {items.length} {items.length === 1 ? "item" : "items"} in the inbox
          </p>
          <button
            className="btn"
            onClick={() => {
              setToken("");
              setItems(null);
            }}
          >
            Sign out
          </button>
        </div>
      )}
      {error && <Failure />}
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
              {item.name || "Anonymous"} · {day(item.created_at)} ·
              publication {item.allow_public ? "permitted" : "not permitted"} ·
              marketing {item.allow_marketing ? "permitted" : "not permitted"}
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
  const [token, setToken] = useState("");
  const [sessionError, setSessionError] = useState(false);
  setRouteGlobal = setRoute;
  useEffect(() => {
    const connect = new URLSearchParams(location.hash.slice(1)).get("connect");
    if (connect) {
      history.replaceState(null, "", location.pathname);
      api("/api/participant/session", { token: connect })
        .then(() => {
          setToken(connect);
          setRoute("/requests");
          history.replaceState(null, "", "/requests");
        })
        .catch(() => setSessionError(true));
    }
    const pop = () => setRoute(location.pathname);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
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
          <Overview />
        ) : route === "/packets" ? (
          <Packets />
        ) : route === "/requests" ? (
          <Requests
            token={token}
            expire={() => {
              setToken("");
              setSessionError(true);
            }}
          />
        ) : route === "/transparency" ? (
          <Transparency />
        ) : route === "/maintainer" ? (
          <Maintainer />
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
          <p>PicPeak Usage · MIT license · Open data, no visitor tracking</p>
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
