import { useEffect, useId, useRef, useState } from "react";
import { api, download, type Summary } from "./api";
import { useRequestScope } from "./useRequestScope";
import { LanguageSelect, messages, type Language } from "./historyLocale";
import { featureText, historicalFeatures } from "./catalog";
import type { FeatureSelection } from "./FeatureAdoption";

type Point = Pick<
  Summary,
  "features" | "versions" | "layouts" | "schema_versions" | "inventory" | "versions_reported" | "layouts_reported"
> & {
  date: string;
  from: string;
  to: string;
  reports: number;
  reporters: number;
};
type HistoryData = {
  revision: string;
  from: string;
  to: string;
  interval: string;
  available: { from: string | null; to: string | null };
  points: Point[];
};
type Metric =
  | "reporters"
  | "reports"
  | "galleries"
  | "photos"
  | "configured"
  | "used"
  | "versions"
  | "layouts"
  | "schema_versions";
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) =>
  new Date(Date.parse(`${today()}T00:00:00Z`) - (days - 1) * 86400000)
    .toISOString()
    .slice(0, 10);

export function History({
  token,
  maintainer = false,
  reporter,
  language: parentLanguage,
  selection,
}: {
  token: string;
  maintainer?: boolean;
  reporter?: string;
  language?: Language;
  selection?: FeatureSelection;
}) {
  const signal = useRequestScope();
  const [localLanguage, setLanguage] = useState<Language>("en");
  const language = parentLanguage || localLanguage;
  const t = messages[language];
  const chartId = useId();
  const section = useRef<HTMLElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const [chartWidth, setChartWidth] = useState(1000);
  const [showTable, setShowTable] = useState(false);
  const [scope, setScope] = useState("all");
  const [range, setRange] = useState("30");
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [interval, setInterval] = useState("day");
  const [metric, setMetric] = useState<Metric>("reporters");
  const [feature, setFeature] = useState("crm");
  const [category, setCategory] = useState("");
  const [percent, setPercent] = useState(true);
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!selection) return;
    setFeature(selection.feature);
    setMetric(featureText(selection.feature, "en").used ? "used" : "configured");
    setScope("all");
    setPercent(true);
    section.current?.scrollIntoView({ block: "start" });
    section.current?.focus({ preventScroll: true });
  }, [selection]);
  useEffect(() => {
    const request = new AbortController();
    const cancel = () => request.abort();
    signal.addEventListener("abort", cancel, { once: true });
    setData(null);
    setError("");
    api<HistoryData>(
      `/api/${maintainer ? "maintainer" : "participant"}/history`,
      {
        token,
        method: "POST",
        signal: request.signal,
        body: {
          from: range === "all" ? "all" : from,
          to,
          interval,
          ...(!maintainer
            ? { scope }
            : reporter
              ? { installation_id: reporter }
              : {}),
        },
      },
    )
      .then(setData)
      .catch((e) => {
        if (!request.signal.aborted) setError(e.message);
      });
    return () => {
      request.abort();
      signal.removeEventListener("abort", cancel);
    };
  }, [
    token,
    maintainer,
    reporter,
    range,
    from,
    to,
    interval,
    scope,
    reload,
    signal,
  ]);

  const featureMetric = metric === "configured" || metric === "used";
  const distribution =
    metric === "versions" ||
    metric === "layouts" ||
    metric === "schema_versions"
      ? metric
      : null;
  const categories = distribution
    ? [
        ...new Set(
          data?.points.flatMap((point) => Object.keys(point[distribution])) ||
            [],
        ),
      ].sort()
    : [];
  const chosen = categories.includes(category) ? category : categories[0] || "";
  const inventoryMetric = metric === "galleries" || metric === "photos";
  const counted = metric === "reports" || metric === "reporters" || inventoryMetric;
  const usesPercent = !counted && percent;
  const label = featureMetric
    ? `${t[metric]} · ${featureText(feature, language).name}`
    : distribution
      ? `${t[metric]} · ${chosen}`
      : t[metric];
  const values = (data?.points || []).map((point) => {
    let value: number, denominator: number;
    if (featureMetric) {
      const signal = point.features[feature];
      value = signal[metric];
      denominator = metric === "used" ? signal.used_reported : signal.reported;
    } else if (distribution) {
      value = point[distribution][chosen] || 0;
      denominator = distribution === "schema_versions" ? point.reporters
        : point[`${distribution}_reported`] ?? point.reporters;
    } else if (inventoryMetric) {
      value = point.inventory?.[metric]?.total || 0;
      denominator = point.inventory?.[metric]?.reported || 0;
    } else {
      value = point[metric as "reporters" | "reports"];
      denominator = point.reporters;
    }
    return {
      point,
      count: value,
      denominator,
      value:
        (!counted || inventoryMetric) && !denominator
          ? null
          : usesPercent
            ? (value / denominator) * 100
            : value,
    };
  });
  const hasReports = values.some(({ point }) => point.reports > 0);
  const max = usesPercent
    ? 100
    : Math.max(1, ...values.map(({ value }) => value || 0));
  const x = (i: number) =>
    55 +
    (values.length > 1 ? i / (values.length - 1) : 0.5) * (chartWidth - 100);
  const y = (value: number) => 230 - (value / max) * 195;
  const segments: string[][] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i].value;
    if (value === null) {
      if (segments.at(-1)?.length) segments.push([]);
    } else {
      if (!segments.length) segments.push([]);
      segments.at(-1)!.push(`${x(i)},${y(value)}`);
    }
  }
  const format = (value: number | null) =>
    value === null
      ? t.unknown
      : `${value.toLocaleString(language, { maximumFractionDigits: 1 })}${usesPercent ? "%" : ""}`;
  const featureInfo =
    historicalFeatures[feature as keyof typeof historicalFeatures];
  const configOnly = metric === "used" && featureInfo.used === null;
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setChartWidth(Math.max(240, entry.contentRect.width)),
    );
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, [data, configOnly]);

  return (
    <section ref={section} tabIndex={-1} className="panel section usage-history" aria-label={t.history}>
      <div className="section-heading">
        <h2>{t.history}</h2>
        {!parentLanguage && (
          <LanguageSelect language={language} setLanguage={setLanguage} />
        )}
      </div>
      <p className="caption section">{t.historyIntro}</p>
      <p className="small history-context">{maintainer ? reporter ? t.selected : t.all : scope === "own" ? t.own : t.all} · {range === "all" ? data?.from || t.allTime : from} – {to} (UTC) · {t[interval as "day" | "week" | "month"]}</p>
      <details className="history-options">
        <summary>{t.historyFilters}</summary>
      <div className="history-controls">
        {!maintainer && (
          <label>
            {t.scope}
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">{t.all}</option>
              <option value="own">{t.own}</option>
            </select>
          </label>
        )}
        {maintainer && (
          <p className="caption">{reporter ? t.selected : t.all}</p>
        )}
        <label>
          {t.range}
          <select
            value={range}
            onChange={(e) => {
              const value = e.target.value;
              setRange(value);
              if (value === "all") {
                setInterval("month");
                setTo(today());
              } else if (value !== "custom") {
                setFrom(daysAgo(Number(value)));
                setTo(today());
              }
            }}
          >
            <option value="30">{t.last30}</option>
            <option value="90">{t.last90}</option>
            <option value="365">{t.last365}</option>
            <option value="all">{t.allTime}</option>
            <option value="custom">{t.custom}</option>
          </select>
        </label>
        <label>
          {t.interval}
          <select
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          >
            <option value="day">{t.day}</option>
            <option value="week">{t.week}</option>
            <option value="month">{t.month}</option>
          </select>
        </label>
        {range === "custom" && (
          <>
            <label>
              {t.from}
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              {t.to}
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </>
        )}
        <label>
          {t.metric}
          <select
            value={metric}
            onChange={(e) => {
              setMetric(e.target.value as Metric);
              setCategory("");
            }}
          >
            {(
              [
                "reporters",
                "reports",
                "galleries",
                "photos",
                "configured",
                "used",
                "versions",
                "layouts",
                "schema_versions",
              ] as const
            ).map((key) => (
              <option key={key} value={key}>
                {t[key]}
              </option>
            ))}
          </select>
        </label>
        {featureMetric && (
          <label>
            {t.feature}
            <select
              value={feature}
              onChange={(e) => setFeature(e.target.value)}
            >
              {Object.keys(historicalFeatures).map((key) => (
                <option key={key} value={key}>
                  {featureText(key, language).name}
                </option>
              ))}
            </select>
          </label>
        )}
        {distribution && (
          <label>
            {t.value}
            <select
              value={chosen}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        )}
        {!counted && (
          <label>
            {t.display}
            <select
              value={percent ? "percent" : "count"}
              onChange={(e) => setPercent(e.target.value === "percent")}
            >
              <option value="percent">{t.percent}</option>
              <option value="count">{t.count}</option>
            </select>
          </label>
        )}
      </div>
      </details>
      {featureMetric && <p className="caption">{t.semantics}</p>}
      {featureMetric && ["gallery_downloads", "gallery_downloads_restricted"].includes(feature) && <p className="caption">{t.downloadSignals}</p>}
      {distribution && <p className="caption">{t.distributionSemantics}</p>}
      {inventoryMetric && <p className="caption">{t.inventorySemantics}</p>}
      {error ? (
        <div className="notice error" role="alert">
          {error.startsWith("INVALID_HISTORY") ||
          error === "HISTORY_RANGE_TOO_LARGE"
            ? t.rangeError
            : t.error}
          <button
            className="btn"
            onClick={() => setReload((value) => value + 1)}
          >
            {t.retry}
          </button>
        </div>
      ) : !data ? (
        <p role="status">{t.loading}</p>
      ) : (
        <>
          <div className="section-heading section">
            <h3>{label}</h3>
            <button
              className="btn"
              onClick={() => download(data, "picpeak-usage-history.json")}
            >
              {t.downloadHistory}
            </button>
          </div>
          {!hasReports ? (
            <p className="notice">{t.empty}</p>
          ) : configOnly ? (
            <p className="notice">{t.notCollected}</p>
          ) : (
            <>
              <svg
                ref={svg}
                className="trend-chart"
                viewBox={`0 0 ${chartWidth} 285`}
                role="img"
                aria-labelledby={chartId}
              >
                <title id={chartId}>
                  {label}: {data.from} – {data.to}
                </title>
                {[0, max / 2, max].map((value) => (
                  <g key={value}>
                    <line
                      x1="55"
                      x2={chartWidth - 45}
                      y1={y(value)}
                      y2={y(value)}
                      className="chart-grid"
                    />
                    <text x="46" y={y(value) + 5} textAnchor="end">
                      {format(value)}
                    </text>
                  </g>
                ))}
                {segments.map(
                  (segment, i) =>
                    segment.length > 0 && (
                      <polyline
                        key={i}
                        points={segment.join(" ")}
                        className="chart-line"
                      />
                    ),
                )}
                {values.map(
                  ({ point, value, count, denominator }, i) =>
                    value !== null && (
                      <circle
                        key={point.date}
                        cx={x(i)}
                        cy={y(value)}
                        r="3"
                        className="chart-point"
                      >
                        <title>
                          {point.from} – {point.to}: {format(value)}
                          {!counted ? ` (${count}/${denominator})` : ""}
                          {inventoryMetric ? ` · ${t.inventoryReported}: ${denominator}` : ""}
                        </title>
                      </circle>
                    ),
                )}
                <text x="55" y="265">
                  {data.from}
                </text>
                <text x={chartWidth - 45} y="265" textAnchor="end">
                  {data.to}
                </text>
              </svg>
            </>
          )}
          <details
            open={showTable}
            onToggle={(e) => setShowTable(e.currentTarget.open)}
          >
            <summary>{t.table}</summary>
            <div className="table-scroll" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th>{t.period}</th>
                    <th>{t.reporters}</th>
                    <th>{t.reports}</th>
                    <th>{label}</th>
                    {inventoryMetric && <th>{t.inventoryReported}</th>}
                  </tr>
                </thead>
                <tbody>
                  {values.map(({ point, value, count, denominator }) => (
                    <tr key={point.date}>
                      <td>
                        {point.from}
                        {point.from !== point.to && ` – ${point.to}`}
                      </td>
                      <td>{point.reporters}</td>
                      <td>{point.reports}</td>
                      <td>
                        {format(value)}
                        {!counted &&
                          denominator > 0 &&
                          ` (${count}/${denominator})`}
                      </td>
                      {inventoryMetric && <td>{denominator}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
