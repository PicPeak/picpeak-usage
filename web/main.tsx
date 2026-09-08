import { LocaleProvider, useLocale } from "./Locale";
import { initializeAnalytics } from "./analytics";
import { linkedFeedbackId } from "./maintainerLinks";
import React, { useEffect, useRef, useState } from "react";
import { useRequestScope } from "./useRequestScope";
import { FeatureCatalog } from "./FeatureCatalog";
import { FeatureAdoption, type FeatureSelection } from "./FeatureAdoption";
import { History } from "./History";
import { InventorySummary } from "./InventorySummary";
import { MaintainerData } from "./MaintainerData";
import { LanguageSelect, type Messages } from "./historyLocale";
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
  ["/", "navOverview"],
  ["/packets", "navPackets"],
  ["/requests", "navRequests"],
  ["/transparency", "navTransparency"],
] as const;

function statusLabel(status: string, t: Messages) {
  const labels: Record<string, string> = {
    open: t.statusOpen,
    planned: t.statusPlanned,
    in_progress: t.statusInProgress,
    completed: t.statusCompleted,
    declined: t.statusDeclined,
  };
  return labels[status] ?? status;
}

function kindLabel(kind: string | undefined, t: Messages) {
  const labels: Record<string, string> = {
    feedback: t.kindFeedback,
    feature_request: t.kindFeatureRequest,
    testimonial: t.kindTestimonial,
  };
  return kind ? (labels[kind] ?? kind) : "";
}

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

function Failure({ retry }: { retry?: () => void }) {
  const { t } = useLocale();
  return (
    <div className="notice error" role="alert">
      {t.loadFailure}
      {retry && (
        <button className="btn" onClick={retry}>
          {t.retry}
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
  const { t } = useLocale();
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
          {t.lookupHash}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            pattern="[a-f0-9]{64}"
            value={hash}
            disabled={busy}
            onChange={(e) => setHash(e.target.value)}
            placeholder={t.lookupPlaceholder}
          />
        </label>
        <button className="btn primary" disabled={busy}>
          {busy ? t.checking : label}
        </button>
      </form>
      {error && (
        <p className="notice error" role="alert">
          {t.lookupFailure}
        </p>
      )}
      <p className="caption">{t.lookupHelp}</p>
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
  const { language, t } = useLocale();
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
          {t.overviewTitle}
        </span>
        <span className="rise" style={{ ...delay(70), display: "block" }}>
          <em>{t.overviewSubtitle}</em>
        </span>
      </h1>
      <p className="lead rise" style={delay(200)}>
        {t.overviewIntro}
      </p>
      <div className="hero-actions rise" style={delay(260)}>
        <a className="btn primary" href={credential ? "#adoption" : "#access"}>
          {credential ? t.exploreAdoption : t.enterLookupHash}
        </a>
        <a
          className="textlink ink small"
          href="/transparency"
          onClick={(e) => navigateEvent(e, "/transparency")}
        >
          {t.participationLink}
        </a>
      </div>
      <p className="label meta rise" style={delay(340)}>
        {t.participationMeta}
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
              eyebrow={t.participantAccess}
              intro={t.participantAccessIntro}
              label={t.openDashboard}
              onUnlock={unlock}
            />
          </div>
        </section>
        <section className="prose-columns quiet">
          <div className="prose">
            <h2>{t.featureSignalsTitle}</h2>
            <p>{t.featureSignalsIntro}</p>
          </div>
          <div className="prose">
            <h2>{t.datasetVisibilityTitle}</h2>
            <p>{t.datasetVisibilityIntro}</p>
          </div>
          <div className="prose">
            <h2>{t.publicRequestsTitle}</h2>
            <p>{t.publicRequestsIntro}</p>
            <a
              className="textlink ink small"
              href="/requests"
              onClick={(e) => navigateEvent(e, "/requests")}
            >
              {t.readRequests}
            </a>
          </div>
        </section>
      </>
    );
  if (error) return <Failure retry={load} />;
  if (!data)
    return (
      <p className="lead" role="status">
        {t.loadingOverview}
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
          aria-label={t.participationSummary}
        >
          <li>
            <span className="label">{t.reporters}</span>
            <strong>{data.installations.toLocaleString(language)}</strong>
            <small>{t.latestPerParticipant}</small>
          </li>
          <li>
            <span className="label">{t.dailyReports}</span>
            <strong>{reports.toLocaleString(language)}</strong>
            <small>{t.retainedDuringParticipation}</small>
          </li>
          <li>
            <span className="label">{t.allCapabilities}</span>
            <strong>{Object.keys(data.features).length}</strong>
            <small>{t.capabilitySummary}</small>
          </li>
        </ul>
      </section>
      {!data.installations && (
        <div className="notice">
          <strong>{t.firstReportsTitle}</strong> {t.firstReportsIntro}
        </div>
      )}
      <FeatureAdoption data={data} onExplore={setSelection} />
      <InventorySummary inventory={data.inventory} />
      <History token={credential} selection={selection} />
      <aside className="overview-extras">
        <section className="panel">
          <p className="eyebrow">{t.releasesTitle}</p>
          <h2>{t.versionDistribution}</h2>
          <div className="pairs">
            {Object.entries(data.versions).map(([version, count]) => (
              <div className="pair" key={version}>
                <code>{version}</code>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          {!Object.keys(data.versions).length && (
            <p className="muted small">
              {data.installations ? t.unknown : t.waitingForReport}
            </p>
          )}
        </section>
        <section className="panel">
          <p className="eyebrow">{t.galleryDesign}</p>
          <h2>{t.layoutDistribution}</h2>
          <div className="pairs">
            {Object.entries(data.layouts).map(([layout, count]) => (
              <div className="pair" key={layout}>
                <span>{layout}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          {!Object.keys(data.layouts).length &&
            data.layouts_reported === 0 &&
            data.installations > 0 && (
              <p className="muted small">{t.unknown}</p>
            )}
          <p className="caption">{t.layoutDisclosure}</p>
        </section>
        <section className="callout">
          <p className="eyebrow">{t.participantDataset}</p>
          <h2>{t.datasetTitle}</h2>
          <p>{t.datasetIntro}</p>
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
            {t.downloadDataset}
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
            {t.inspectDataset}
          </button>
        </section>
      </aside>
      {records && (
        <section className="panel section">
          <p className="eyebrow">{t.datasetRecords}</p>
          <h2>{t.datasetPreviewTitle}</h2>
          <p className="caption" style={{ marginTop: "0.5rem" }}>
            {t.datasetPreviewIntro}
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
  const { language, t } = useLocale();
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
        eyebrow={t.packetsEyebrow}
        title={t.packetsTitle}
        text={t.packetsIntro}
      />
      {!hash && (
        <AccessForm
          eyebrow={t.yourInstallation}
          intro={t.packetsAccessIntro}
          label={t.openPackets}
          onUnlock={unlock}
        />
      )}
      {hash && !result && !error && (
        <p className="muted" role="status">
          {t.loadingPackets}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {t.packetsFailure}
          <button className="btn" onClick={() => void load()} disabled={busy}>
            {t.reloadPackets}
          </button>
        </p>
      )}
      {hash && result?.installation_id === hash && (
        <section className="panel section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t.acceptedUsageReports}</p>
              <h2>
                {(result.packets.length === 1
                  ? t.oneReportShown
                  : t.reportsShown
                ).replace(
                  "{count}",
                  result.packets.length.toLocaleString(language),
                )}
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
              {t.downloadPackets}
            </button>
          </div>
          <p className="caption">{t.packetsDownloadIntro}</p>
          {result.packets.map((packet, index) => (
            <details key={index}>
              <summary>
                <span>{stamp(packet.received_at)}</span>
                <span className="muted">
                  {packet.signature_verified
                    ? t.signatureVerified
                    : t.signatureUnverified}
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
              {t.moreReports}
            </button>
          )}
          {!result.packets.length && (
            <p className="muted small" style={{ marginTop: "1rem" }}>
              {t.registeredWithoutReport}
            </p>
          )}
        </section>
      )}
    </>
  );
}

function Requests({ token, expire }: { token: string; expire: () => void }) {
  const { t } = useLocale();
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
        eyebrow={t.requestsEyebrow}
        title={t.requestsTitle}
        text={t.requestsIntro}
      />
      <div className="notice">
        {token ? (
          <>
            <strong>{t.votingConnected}</strong> {t.votingDuration}
          </>
        ) : (
          <>
            <strong>{t.votingConnectionRequired}</strong>{" "}
            {t.votingConnectionHelp}
          </>
        )}{" "}
        {t.submitFeedbackHelp}
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
          {t.loadingRequests}
        </p>
      )}
      <div className="requests stack">
        {items?.map((item) => (
          <article key={item.id} className="panel request">
            <button
              className={`vote ${item.voted ? "selected" : ""}`}
              disabled={!token || Boolean(busy)}
              aria-pressed={item.voted}
              aria-label={`${item.voted ? t.removeVote : t.addVote} ${item.title}`}
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
                    if (
                      error instanceof Error &&
                      error.message === "PARTICIPANT_AUTH_REQUIRED"
                    )
                      expire();
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
                {statusLabel(item.status, t)}
              </span>
              <h2>{item.title}</h2>
              <p className="preserve">{item.body}</p>
              <small>
                {item.name || t.anonymousParticipant} · {day(item.created_at)}
              </small>
            </div>
          </article>
        ))}
      </div>
      {next && (
        <button className="btn" onClick={() => load(next)}>
          {t.moreRequests}
        </button>
      )}
      {items?.length === 0 && (
        <div className="panel empty">
          <h2>{t.noRequestsTitle}</h2>
          <p>{t.noRequestsIntro}</p>
        </div>
      )}
      {testimonials.length > 0 && (
        <section className="panel section">
          <p className="eyebrow">{t.communityVoices}</p>
          <h2>{t.sharedWithPermission}</h2>
          {testimonials.map((item) => (
            <blockquote key={item.id}>
              <h3>{item.title}</h3>
              <p className="preserve">{item.body}</p>
              <cite>{item.name || t.anonymousParticipant}</cite>
            </blockquote>
          ))}
          {testimonialNext && (
            <button
              className="btn"
              onClick={() => loadTestimonials(testimonialNext)}
            >
              {t.moreTestimonials}
            </button>
          )}
        </section>
      )}
    </>
  );
}

function Transparency() {
  const { t } = useLocale();
  return (
    <>
      <PageHeading
        eyebrow={t.transparencyEyebrow}
        title={t.transparencyTitle}
        text={t.transparencyIntro}
      />
      <div className="transparency-grid">
        <section className="panel prose">
          <h2>{t.reportContentsTitle}</h2>
          <p>{t.reportContentsIntro}</p>
          <p>{t.signalMeaning}</p>
          <p>{t.schemaCompatibility}</p>
          <p>{t.layoutValues}</p>
          <a className="btn" href="/schema/usage.v5.json" data-analytics-event="Read schema">
            {t.schemaV5}
          </a>{" "}
          <a className="btn" href="/schema/usage.v4.json" data-analytics-event="Read schema">
            {t.schemaV4}
          </a>{" "}
          <a className="btn" href="/schema/usage.v3.json" data-analytics-event="Read schema">
            {t.schemaV3}
          </a>{" "}
          <a className="btn" href="/schema/usage.v2.json" data-analytics-event="Read schema">
            {t.schemaV2}
          </a>{" "}
          <a className="btn" href="/schema/usage.v1.json" data-analytics-event="Read schema">
            {t.schemaV1}
          </a>
        </section>
        <div className="side-panels">
          <section className="panel prose">
            <h2>{t.excludedDataTitle}</h2>
            <p>{t.excludedDataIntro}</p>
            <p>{t.networkPrivacy}</p>
          </section>
          <section className="panel prose">
            <h2>{t.participantVisibilityTitle}</h2>
            <p>{t.participantVisibilityIntro}</p>
            <p>{t.privateLookupDisclosure}</p>
          </section>
          <section className="panel prose">
            <h2>{t.deletionTitle}</h2>
            <p>{t.deletionIntro}</p>
            <p>{t.revocationDisclosure}</p>
          </section>
        </div>
      </div>
      <section className="panel prose section">
        <h2>{t.websiteAnalyticsTitle}</h2>
        <p>{t.websiteAnalyticsIntro}</p>
        <p>{t.websiteAnalyticsPrivacy}</p>
      </section>
      <FeatureCatalog />
      <section className="panel prose section">
        <h2>{t.weeklyEmailTitle}</h2>
        <p>{t.weeklyEmailDisclosure}</p>
        <p>{t.weeklyCounterDisclosure}</p>
      </section>
      <section className="prose-columns">
        <div className="prose">
          <h2>{t.feedbackConsentTitle}</h2>
          <p>{t.feedbackConsentIntro}</p>
        </div>
        <div className="prose">
          <h2>{t.signingTitle}</h2>
          <p>{t.signingIntro}</p>
          <p>{t.retentionIntro}</p>
        </div>
        <div className="prose">
          <h2>{t.sourceTitle}</h2>
          <p>
            {t.sourceIntroBefore} <code>picpeak-usage</code>{" "}
            {t.sourceIntroAfter}{" "}
            <a className="textlink ink" href={PROPOSAL} rel="noreferrer">
              {t.publicProposal}
            </a>
            {t.sourceContents}
          </p>
          <a className="btn" href="/source.tar.gz" data-analytics-event="Download source" download>
            {t.downloadSource}
          </a>
        </div>
      </section>
      <section className="panel prose section">
        <h2>{t.auditTitle}</h2>
        <p>{t.auditExportIntro}</p>
        <p>{t.auditReceiptIntro}</p>
        <table className="retention-table">
          <thead>
            <tr>
              <th>{t.retentionData}</th>
              <th>{t.retentionDuration}</th>
            </tr>
          </thead>
          <tbody>
            {[
              [t.retentionRegistrationData, t.retentionRegistrationDuration],
              [t.retentionRawReportsData, t.retentionRawReportsDuration],
              [t.retentionProjectionsData, t.retentionProjectionsDuration],
              [t.retentionFeedbackData, t.retentionFeedbackDuration],
              [t.retentionOperationsData, t.retentionOperationsDuration],
              [t.retentionSessionsData, t.retentionSessionsDuration],
              [t.retentionNoncesData, t.retentionNoncesDuration],
              [t.retentionAdmissionData, t.retentionAdmissionDuration],
              [t.retentionRevisionData, t.retentionRevisionDuration],
              [t.retentionRevocationsData, t.retentionRevocationsDuration],
              [t.retentionAddressLimitsData, t.retentionAddressLimitsDuration],
              [t.retentionReceiptsData, t.retentionReceiptsDuration],
              [
                t.retentionInfrastructureData,
                t.retentionInfrastructureDuration,
              ],
              [t.retentionWeeklyData, t.retentionWeeklyDuration],
            ].map(([data, retention]) => (
              <tr key={data}>
                <th scope="row">{data}</th>
                <td>{retention}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>{t.marketingFeedDisclosure}</p>
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
  const { language, t } = useLocale();
  const signal = useRequestScope();
  const [token, setToken] = useState("");
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [linkedFeedback, setLinkedFeedback] = useState(linkedFeedbackId);
  const [missingFeedback, setMissingFeedback] = useState(false);
  const hasAccess = items !== null;
  useEffect(() => {
    if (!hasAccess) return;
    const id = linkedFeedback ? `feedback-${linkedFeedback}` : location.hash.slice(1);
    if (!["adoption", "history", "feedback", `feedback-${linkedFeedback}`].includes(id)) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(id) || (linkedFeedback ? document.getElementById("feedback") : null);
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [hasAccess, linkedFeedback]);
  const load = async (after = "", target = linkedFeedback) => {
    setError(false);
    setMissingFeedback(false);
    setBusy(true);
    try {
      const value = target ? [await api<Feedback>(`/api/maintainer/feedback/${target}`, { token, signal })] : await api<Feedback[]>(
        `/api/maintainer/feedback${after ? `?after=${after}` : ""}`,
        { token, signal, onPage: setNext },
      );
      if (target) setNext(null);
      setItems((previous) => (after ? [...(previous || []), ...value] : value));
    } catch (error) {
      if (error instanceof Error && error.message === "FEEDBACK_NOT_FOUND") {
        setMissingFeedback(true);
        setItems([]);
        setNext(null);
      } else {
        setError(true);
        setItems(null);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeading
        eyebrow={t.maintainerWorkspace}
        title={t.workspaceTitle}
        text={t.workspaceIntro}
      />
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
            {t.maintainerToken}
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
            {(items.length === 1 ? t.oneInboxItem : t.inboxItems).replace(
              "{count}",
              items.length.toLocaleString(language),
            )}
          </p>
          <button className="btn" onClick={signOut}>
            {t.signOut}
          </button>
        </div>
      )}
      {error && <Failure />}
      {items && <MaintainerData key={token} token={token} />}
      {items && <h2 id="feedback" tabIndex={-1} className="section">{t.feedback}</h2>}
      {linkedFeedback && <div className="notice section">
        <p>{missingFeedback ? t.linkedFeedbackMissing : t.linkedFeedbackNotice}</p>
        <button className="btn" disabled={busy} onClick={() => {
          setLinkedFeedback("");
          setMissingFeedback(false);
          const url = new URL(location.href);
          url.searchParams.delete("feedback");
          url.hash = "feedback";
          history.replaceState(null, "", url.pathname + url.search + url.hash);
          if (hasAccess) void load("", "");
        }}>{t.allFeedback}</button>
      </div>}
      {items?.length === 0 && !missingFeedback && (
        <div className="panel empty section">
          <h2>{t.inboxEmptyTitle}</h2>
          <p>{t.inboxEmptyIntro}</p>
        </div>
      )}
      <div className="stack section">
        {items?.map((item) => (
          <article id={`feedback-${item.id}`} tabIndex={-1} key={item.id} className="panel moderation">
            <span className="badge">{kindLabel(item.kind, t)}</span>
            <h2>{item.title}</h2>
            <p className="preserve">{item.body}</p>
            <p className="caption">
              {item.name || t.anonymous} · {day(item.created_at)}{" "}
              {t.publicationLabel}{" "}
              {item.allow_public ? t.permitted : t.notPermitted}{" "}
              {t.marketingLabel}{" "}
              {item.allow_marketing ? t.permitted : t.notPermitted}
            </p>
            <div className="moderation-controls">
              <label>
                {t.reviewStatus}
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
                      {statusLabel(status, t)}
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
                {t.publishItem}
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
                {t.saveReview}
              </button>
            </div>
          </article>
        ))}
      </div>
      {next && (
        <button className="btn" disabled={busy} onClick={() => void load(next)}>
          {t.moreFeedback}
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
  const { t } = useLocale();
  return (
    <a className="brand" href="/" onClick={(e) => navigateEvent(e, "/")}>
      <img src="/picpeak-mark.svg" alt="" width={37} height={28} />
      PicPeak <span>{t.usage}</span>
    </a>
  );
}

function App() {
  const { language, setLanguage, t } = useLocale();
  const [route, setRoute] = useState(location.pathname);
  const [session, setSession] = useState<{
    token: string;
    expiresAt: number;
  } | null>(null);
  const [hash, setHash] = useState("");
  const [sessionError, setSessionError] = useState(false);
  const connecting = useRef<AbortController | null>(null);
  setRouteGlobal = setRoute;
  useEffect(() => {
    const title = NAV.find(([href]) => href === route)?.[1];
    document.title =
      (title
        ? t[title]
        : route === "/maintainer"
          ? t.maintainerWorkspace
          : t.notFoundTitle) +
      " · PicPeak " +
      t.usage;
  }, [route, t]);
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
    const timer = window.setTimeout(
      expire,
      Math.max(0, session.expiresAt - Date.now()),
    );
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
          setSession({
            token: connect,
            expiresAt: Date.parse(value.expires_at),
          });
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
        {t.skipContent}
      </a>
      <header className="wrap topbar">
        <Brand />
        <div className="page-language">
          <LanguageSelect language={language} setLanguage={setLanguage} />
        </div>
        <nav aria-label={t.mainNavigation}>
          {NAV.map(([href, label]) => (
            <a
              key={href}
              className="textlink"
              href={href}
              aria-current={route === href ? "page" : undefined}
              onClick={(e) => navigateEvent(e, href)}
            >
              {t[label]}
            </a>
          ))}
          <a className="textlink" href={SITE} data-analytics-event="Open website">
            picpeak.app
          </a>
          {credential && (
            <button className="btn quiet nav-signout" onClick={signOut}>
              {t.signOut}
            </button>
          )}
        </nav>
      </header>
      <main id="main">
        {sessionError && (
          <div className="notice error" role="alert">
            {t.votingExpired}
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
            title={t.notFoundTitle}
            text={t.notFoundIntro}
          />
        )}
      </main>
      <footer>
        <div className="wrap">
          <p>{t.footerText}</p>
          <nav aria-label={t.footerNavigation}>
            {NAV.map(([href, label]) => (
              <a
                key={href}
                className="textlink"
                href={href}
                onClick={(e) => navigateEvent(e, href)}
              >
                {t[label]}
              </a>
            ))}
            <a className="textlink" href={PROPOSAL} rel="noreferrer">
              {t.proposalLink}
            </a>
            <a className="textlink" href={SITE} data-analytics-event="Open website">
              picpeak.app
            </a>
            <a
              className="textlink"
              href="/maintainer"
              onClick={(e) => navigateEvent(e, "/maintainer")}
            >
              {t.maintainerAccess}
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
);
void initializeAnalytics();
