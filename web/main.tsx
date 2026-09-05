import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  download,
  featureNames,
  type Summary,
  type Feedback,
} from "./api";
import "./style.css";

const NAV = [
  ["/", "Overview"],
  ["/packets", "Your packets"],
  ["/requests", "Feature requests"],
  ["/transparency", "Transparency"],
] as const;
function Failure({ retry }: { retry?: () => void }) {
  return (
    <div className="notice" role="alert">
      We couldn’t load this data. Check your connection or access and try again.
      {retry && <button onClick={retry}>Try again</button>}
    </div>
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
  if (!data) return <p role="status">Loading the community picture…</p>;
  const entries = Object.entries(data.features)
    .filter(([key]) =>
      (featureNames[key] || key).toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b[1][metric] - a[1][metric]);
  const reports = data.history.reduce((sum, row) => sum + row.reports, 0);
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">THE COMMUNITY, IN FOCUS</p>
          <h1>
            A clearer picture.
            <br />
            <em>A better PicPeak.</em>
          </h1>
          <p className="lead">
            Which features help people most? Explore the same open data we use
            to shape what comes next.
          </p>
        </div>
        <div className="promise">
          <span className="status-dot" /> VOLUNTARY BY DESIGN
          <p>
            Feature signals.
            <br />
            No visitor tracking.
          </p>
          <a href="/transparency">How participation works ↗</a>
        </div>
      </section>
      <section className="stats" aria-label="Participation summary">
        <article>
          <span>Reporting installations</span>
          <strong>{data.installations.toLocaleString()}</strong>
          <small>Latest report from each participant</small>
        </article>
        <article>
          <span>Accepted daily reports</span>
          <strong>{reports.toLocaleString()}</strong>
          <small>Retained while participation is active</small>
        </article>
        <article>
          <span>Documented capabilities</span>
          <strong>{Object.keys(data.features).length}</strong>
          <small>Configured and used, never click counts</small>
        </article>
      </section>
      {!data.installations && (
        <div className="notice">
          <strong>The first reports will appear here.</strong> Enable product
          usage in PicPeak → Settings → Product usage & feedback. This dashboard
          displays actual accepted reports; no sample installations are
          included.
        </div>
      )}
      <div className="dashboard-grid">
        <section className="panel adoption">
          <div className="section-heading">
            <div>
              <p className="eyebrow">FEATURE ADOPTION</p>
              <h2>What’s being used</h2>
            </div>
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
          <label className="search">
            Find a capability
            <input
              type="search"
              placeholder="Search features…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
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
                      {percent}% <small>({value[metric]})</small>
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
            {entries.length === 0 && <p>No matching capabilities.</p>}
          </div>
        </section>
        <aside className="side-panels">
          <section className="panel">
            <p className="eyebrow">RELEASES</p>
            <h2>PicPeak versions</h2>
            {Object.entries(data.versions).map(([version, count]) => (
              <div className="pair" key={version}>
                <code>{version}</code>
                <strong>{count}</strong>
              </div>
            ))}
            {!Object.keys(data.versions).length && (
              <p className="muted">Waiting for the first report.</p>
            )}
          </section>
          <section className="panel">
            <p className="eyebrow">GALLERY DESIGN</p>
            <h2>Layouts in use</h2>
            {Object.entries(data.layouts).map(([layout, count]) => (
              <div className="pair" key={layout}>
                <span>{layout}</span>
                <strong>{count}</strong>
              </div>
            ))}
            <p className="caption">
              An installation can use several layouts. Gallery counts are never
              reported.
            </p>
          </section>
          <section className="panel open-data">
            <span className="eyebrow">OPEN DATA</span>
            <h2>See the whole picture.</h2>
            <p>
              Every feature combination is included. No installation hashes or
              signing keys are exposed.
            </p>
            <a className="button" href="/api/public/export" download>
              Download public dataset ↓
            </a>
            <button
              className="text-button"
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
      <section className="panel">
        <p className="eyebrow">PARTICIPATION OVER TIME</p>
        <h2>Daily report history</h2>
        <p className="caption">
          Reports per UTC day from installations still participating. Opt-out
          removes historical contributions too.
        </p>
        <div className="history">
          {data.history.slice(-30).map((row) => (
            <div key={row.date}>
              <span>{row.date}</span>
              <div className="bar">
                <span
                  style={{
                    width: `${(row.reports / Math.max(...data.history.map((r) => r.reports), 1)) * 100}%`,
                  }}
                />
              </div>
              <strong>{row.reports}</strong>
            </div>
          ))}
        </div>
        {!data.history.length && <p className="muted">No reports yet.</p>}
      </section>
      {records && (
        <section className="panel">
          <h2>Public records</h2>
          <p>
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
        eyebrow="NOTHING HIDDEN"
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
            placeholder="Your 64-character hash"
          />
        </label>
        <button className="button" disabled={busy}>
          {busy ? "Looking up…" : "Inspect my packets →"}
        </button>
      </form>
      {error && (
        <p className="notice" role="alert">
          No accessible installation was found, or the service is unavailable.
          Check the hash and try again. Deleted identities no longer have
          access.
        </p>
      )}
      {result && (
        <section className="panel">
          <div className="section-heading">
            <h2>{result.packets.length} accepted packets</h2>
            <button
              onClick={() => download(result, "picpeak-usage-packets.json")}
            >
              Download all JSON ↓
            </button>
          </div>
          {result.packets.map((packet, index) => (
            <details key={index}>
              <summary>
                Received {new Date(packet.received_at).toLocaleString()} ·{" "}
                {packet.signature_verified
                  ? "Signature verified"
                  : "Unverified"}
              </summary>
              <pre>{JSON.stringify(packet, null, 2)}</pre>
            </details>
          ))}
          {!result.packets.length && (
            <p>
              The installation is registered. Its first daily report has not
              arrived yet.
            </p>
          )}
        </section>
      )}
    </>
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
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="lead">{text}</p>
    </header>
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
        eyebrow="SHAPE WHAT’S NEXT"
        title="A place for the next good idea."
        text="Read community requests and support the improvements that matter to you. Public requests appear only with the author’s permission and after maintainer review."
      />
      <div className="notice">
        {token
          ? "You are connected for voting. Your session lasts 15 minutes; opt-out revokes it immediately."
          : "To vote, choose “Connect to requests & voting” in your PicPeak usage settings. A lookup hash alone does not authorize votes."}{" "}
        Submit new requests or private feedback from the same PicPeak settings
        page.
      </div>
      {error && <Failure retry={load} />}
      {!items && !error && <p>Loading requests…</p>}
      <div className="requests">
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
              <span>↑</span>
              <strong>{item.votes}</strong>
            </button>
            <div>
              <span className="badge">{item.status.replaceAll("_", " ")}</span>
              <h2>{item.title}</h2>
              <p className="preserve">{item.body}</p>
              <small>
                {item.name || "Anonymous participant"} ·{" "}
                {new Date(item.created_at).toLocaleDateString()}
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
        <section className="panel">
          <p className="eyebrow">COMMUNITY VOICES</p>
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
        eyebrow="PRIVACY YOU CAN INSPECT"
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
            frequency. The schema’s feature names are listed below.
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
          <a className="button" href="/schema/usage.v1.json">
            Read the exact JSON schema ↗
          </a>
        </section>
        <div className="side-panels">
          <section className="panel">
            <h2>What we do not collect</h2>
            <p>
              No gallery visitor tracking, clickstreams, photo/gallery counts,
              emails, domains, filenames, customer names, location, or
              configuration secrets in automatic reports.
            </p>
            <p>
              The network sees an address to deliver a request. This application
              does not persist it in analytics or access logs. Abuse controls
              keep an ephemeral address HMAC in memory for ten minutes.
            </p>
          </section>
          <section className="panel">
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
          <section className="panel">
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
      <section className="panel prose">
        <h2>Feedback has separate consent</h2>
        <p>
          Feedback is sent only when you submit it. You choose anonymity or a
          name per item. Private feedback is maintainer-only; feature requests
          and testimonials need your publication permission and review. Homepage
          marketing requires an additional explicit permission. Opt-out removes
          these items and their votes too.
        </p>
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
        <h2>Auditable software</h2>
        <p>
          This service is developed as the separate <code>picpeak-usage</code>{" "}
          application alongside the{" "}
          <a
            href="https://github.com/PicPeak/picpeak/issues/1110"
            rel="noreferrer"
          >
            public PicPeak usage proposal
          </a>
          . The deployment includes the protocol, collector, UI, database
          migrations, tests, and operator documentation.
        </p>
        <a className="button" href="/source.tar.gz" download>
          Download this deployment’s source ↓
        </a>
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
        eyebrow="MAINTAINER WORKSPACE"
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
          <button className="button" disabled={busy}>
            Open feedback inbox →
          </button>
        </form>
      )}
      {items && (
        <button
          onClick={() => {
            setToken("");
            setItems(null);
          }}
        >
          Sign out
        </button>
      )}
      {error && <Failure />}
      {items?.length === 0 && (
        <div className="panel empty">
          <h2>Your inbox is clear.</h2>
          <p>Private and publication-requested feedback will appear here.</p>
        </div>
      )}
      {items?.map((item) => (
        <article key={item.id} className="panel moderation">
          <span className="badge">{item.kind?.replaceAll("_", " ")}</span>
          <h2>{item.title}</h2>
          <p className="preserve">{item.body}</p>
          <p className="caption">
            {item.name || "Anonymous"} · Publication:{" "}
            {item.allow_public ? "permitted" : "not permitted"} · Marketing:{" "}
            {item.allow_marketing ? "permitted" : "not permitted"}
          </p>
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
              {["open", "planned", "in_progress", "completed", "declined"].map(
                (status) => (
                  <option key={status}>{status}</option>
                ),
              )}
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
            className="button"
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
        </article>
      ))}
    </>
  );
}

function App() {
  const [route, setRoute] = useState(location.pathname);
  const [token, setToken] = useState("");
  const [sessionError, setSessionError] = useState(false);
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
  const navigate = (
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    history.pushState(null, "", href);
    setRoute(href);
    window.scrollTo(0, 0);
  };
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => navigate(e, "/")}>
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M2 26 13 6l7 12 4-6 7 14H2Z" fill="currentColor" />
            <path d="m10 12 3-6 4 7-4-2Z" fill="var(--paper)" />
          </svg>
          <strong>
            PicPeak<span>Usage</span>
          </strong>
        </a>
        <nav aria-label="Main navigation">
          {NAV.map(([href, label]) => (
            <a
              key={href}
              href={href}
              aria-current={route === href ? "page" : undefined}
              onClick={(e) => navigate(e, href)}
            >
              {label}
            </a>
          ))}
        </nav>
        <span className="open-label">
          <span className="status-dot" /> OPEN BY DESIGN
        </span>
      </header>
      <main id="main">
        {sessionError && (
          <div className="notice" role="alert">
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
        <a className="brand" href="/" onClick={(e) => navigate(e, "/")}>
          <strong>
            PicPeak<span>Usage</span>
          </strong>
        </a>
        <p>Better software, shaped by the people who use it.</p>
        <a href="/maintainer" onClick={(e) => navigate(e, "/maintainer")}>
          Maintainer access
        </a>
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
