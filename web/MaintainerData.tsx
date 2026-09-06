import { useEffect, useState } from "react";
import { api, downloadWith, stamp } from "./api";
import { History } from "./History";
import { messages, type Language } from "./historyLocale";
import { useRequestScope } from "./useRequestScope";

type Reporter = {
  id: string;
  consent_version: string;
  reports: number;
  first_report: string | null;
  last_report: string | null;
  latest: { picpeak_version: string } | null;
};
type ReporterPage = {
  records: Reporter[];
  next: string | null;
  revision: string;
};

export function MaintainerData({
  token,
  language,
}: {
  token: string;
  language: Language;
}) {
  const signal = useRequestScope();
  const t = messages[language];
  const [result, setResult] = useState<ReporterPage | null>(null);
  const [selected, setSelected] = useState<Reporter | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = async (after?: string) => {
    setBusy(true);
    setError(false);
    try {
      const value = await api<ReporterPage>("/api/maintainer/reporters", {
        method: "POST",
        token,
        signal,
        body: after ? { after, revision: result?.revision } : {},
      });
      setResult((previous) =>
        after && previous
          ? { ...value, records: [...previous.records, ...value.records] }
          : value,
      );
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="section maintainer-data">
      <section className="panel">
        <div className="section-heading">
          <h2>{t.dataTitle}</h2>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(false);
              try {
                await downloadWith(
                  "/api/maintainer/export",
                  token,
                  "picpeak-usage-maintainer.ndjson",
                  signal,
                  {},
                );
              } catch {
                if (!signal.aborted) setError(true);
              } finally {
                if (!signal.aborted) setBusy(false);
              }
            }}
          >
            {t.downloadAll}
          </button>
        </div>
        <p className="caption section">{t.dataIntro}</p>
      </section>
      <History
        key={`${selected?.id || "all"}:${epoch}`}
        token={token}
        maintainer
        reporter={selected?.id}
        language={language}
      />
      {selected && (
        <button className="btn section" onClick={() => setSelected(null)}>
          {t.all}
        </button>
      )}
      <section
        className="panel section reporter-directory"
        aria-label={t.reporterList}
      >
        <div className="section-heading">
          <h2>{t.reporterList}</h2>
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setResult(null);
              setSelected(null);
              setEpoch((value) => value + 1);
              void load();
            }}
          >
            {t.reload}
          </button>
        </div>
        {error && (
          <p className="notice error" role="alert">
            {t.error}
          </p>
        )}
        {!result && !error && <p role="status">{t.loading}</p>}
        {result?.records.length === 0 && (
          <p className="notice">{t.noReporters}</p>
        )}
        {!!result?.records.length && (
          <div className="table-scroll section" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>{t.reporterHash}</th>
                  <th>{t.reports}</th>
                  <th>{t.lastReport}</th>
                  <th>{t.versions}</th>
                  <th>{t.inspect}</th>
                </tr>
              </thead>
              <tbody>
                {result.records.map((reporter) => (
                  <tr key={reporter.id}>
                    <td>
                      <code className="reporter-id">{reporter.id}</code>
                    </td>
                    <td>{reporter.reports}</td>
                    <td>{reporter.last_report || "—"}</td>
                    <td>{reporter.latest?.picpeak_version || "—"}</td>
                    <td>
                      <button
                        className="btn"
                        aria-pressed={selected?.id === reporter.id}
                        onClick={() => setSelected(reporter)}
                      >
                        {t.inspect}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result?.next && (
          <button
            className="btn section"
            disabled={busy}
            onClick={() => void load(result.next!)}
          >
            {t.moreReporters}
          </button>
        )}
      </section>
      {selected && (
        <ReporterDetails
          key={`${selected.id}:${epoch}`}
          token={token}
          reporter={selected}
          language={language}
        />
      )}
    </div>
  );
}

function ReporterDetails({
  token,
  reporter,
  language,
}: {
  token: string;
  reporter: Reporter;
  language: Language;
}) {
  const t = messages[language];
  const signal = useRequestScope();
  const [result, setResult] = useState<{
    packets: {
      envelope: {
        packet: { packet_id: string; payload: { report_date: string } };
      };
      received_at: string;
    }[];
    next: string | null;
    revision: string;
  } | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async (after?: string) => {
    setBusy(true);
    setError(false);
    try {
      const value = await api<NonNullable<typeof result>>(
        "/api/maintainer/packets",
        {
          method: "POST",
          token,
          signal,
          body: {
            installation_id: reporter.id,
            ...(after ? { after, revision: result?.revision } : {}),
          },
        },
      );
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
    void load();
  }, []);
  return (
    <section className="panel section reporter-details" aria-label={t.selected}>
      <div className="section-heading">
        <h2>{t.rawPackets}</h2>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(false);
            try {
              await downloadWith(
                "/api/maintainer/export",
                token,
                "picpeak-usage-reporter.ndjson",
                signal,
                { installation_id: reporter.id },
              );
            } catch {
              if (!signal.aborted) setError(true);
            } finally {
              if (!signal.aborted) setBusy(false);
            }
          }}
        >
          {t.downloadReporter}
        </button>
      </div>
      <p className="mono preserve section">{reporter.id}</p>
      <p className="caption">
        {t.firstReport}: {reporter.first_report || "—"} · {t.lastReport}:{" "}
        {reporter.last_report || "—"} · {t.consent}: {reporter.consent_version}
      </p>
      <details>
        <summary>{t.metadata}</summary>
        <pre>{JSON.stringify(reporter, null, 2)}</pre>
      </details>
      {error && (
        <div className="notice error" role="alert">
          {t.error}
          <button className="btn" disabled={busy} onClick={() => void load()}>
            {t.reload}
          </button>
        </div>
      )}
      {!result && !error && <p role="status">{t.loading}</p>}
      {result?.packets.map((packet) => (
        <details key={packet.envelope.packet.packet_id}>
          <summary>
            {packet.envelope.packet.payload.report_date} · {t.received}:{" "}
            {stamp(packet.received_at)}
          </summary>
          <pre>{JSON.stringify(packet, null, 2)}</pre>
        </details>
      ))}
      {result?.packets.length === 0 && <p className="notice">{t.noPackets}</p>}
      {result?.next && (
        <button
          className="btn"
          disabled={busy}
          onClick={() => void load(result.next!)}
        >
          {t.moreReports}
        </button>
      )}
    </section>
  );
}
