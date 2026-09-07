import { useLocale } from "./Locale";
import { linkedFeature } from "./maintainerLinks";
import { useState } from "react";
import type { Summary } from "./api";
import { catalog, featureText, configurationKind } from "./catalog";
import { messages, type Language } from "./historyLocale";

export type FeatureSelection = { feature: string };
type View = "all" | "majority" | "unused" | "configuration" | "historical";
const PREVIEW_SIZE = 8;

export function FeatureAdoption({
  data, onExplore,
}: {
  data: Summary;
  onExplore: (selection: FeatureSelection) => void;
}) {
  const { language, t } = useLocale();
  const [search, setSearch] = useState(linkedFeature);
  const [view, setView] = useState<View>("all");
  const [showAll, setShowAll] = useState(false);
  const allEntries = Object.entries(data.features).map(([key, value]) => ({
    key, ...value, text: featureText(key, language),
  }));
  const entries = allEntries.filter(entry => Object.hasOwn(catalog.features, entry.key));
  const matches = (entry: typeof entries[number], filter: View) => {
    if (filter === "historical") return !Object.hasOwn(catalog.features, entry.key);
    if (filter === "majority") return !!entry.text.used && entry.used_reported > 0 && entry.used / entry.used_reported > 0.5;
    if (filter === "unused") return !!entry.text.used && entry.used_reported > 0 && entry.used === 0;
    if (filter === "configuration") return !entry.text.used;
    return true;
  };
  const share = (entry: typeof entries[number]) => {
    const count = view === "configuration" ? entry.configured : entry.used;
    const reported = view === "configuration" ? entry.reported : entry.used_reported;
    return reported ? count / reported : -1;
  };
  const filtered = (view === "historical" || (view === "all" && search.trim()) ? allEntries : entries).filter(entry => matches(entry, view))
    .filter(entry => `${entry.key} ${entry.text.name}`.toLocaleLowerCase(language).includes(search.trim().toLocaleLowerCase(language)))
    .sort((a, b) => share(b) - share(a)
      || (view === "configuration" ? b.reported - a.reported : b.used_reported - a.used_reported)
      || a.text.name.localeCompare(b.text.name, language));
  // Searching and quick views should never conceal matching features behind
  // the compact default preview.
  const visible = showAll || search.trim() || view !== "all" ? filtered : filtered.slice(0, PREVIEW_SIZE);
  const viewLabels = { all: t.adoptionAll, majority: t.adoptionMajority, unused: t.adoptionUnused, configuration: t.adoptionConfiguration, historical: t.adoptionHistorical };
  return <section className="panel section adoption-overview" id="adoption" aria-label={t.adoptionTitle}>
    <div className="section-heading">
      <div>
        <p className="eyebrow">{t.adoptionEyebrow}</p>
        <h2>{t.adoptionTitle}</h2>
      </div>
    </div>
    <p className="small muted section">{t.adoptionIntro}</p>
    <dl className="adoption-stats">
      <div><dt>{t.reporters}</dt><dd>{data.installations.toLocaleString(language)}</dd></div>
      <div><dt>{t.adoptionUsedSomewhere}</dt><dd>{entries.filter(entry => entry.text.used && entry.used > 0).length.toLocaleString(language)}</dd></div>
      <div><dt>{t.adoptionMajorityFeatures}</dt><dd>{entries.filter(entry => matches(entry, "majority")).length.toLocaleString(language)}</dd></div>
    </dl>
    <p className="caption">{t.adoptionSemantics}</p>
    {!data.installations ? <p className="notice">{t.adoptionEmpty}</p> : <>
      <div className="adoption-toolbar">
        <div className="adoption-views" role="group" aria-label={t.adoptionViews}>
          {(["all", "majority", "unused", "configuration", "historical"] as const).map(filter => <button
            key={filter} className="btn" aria-pressed={view === filter}
            onClick={() => { setView(filter); setShowAll(false); }}
          >{viewLabels[filter]} <span>{(filter === "historical" ? allEntries : entries).filter(entry => matches(entry, filter)).length.toLocaleString(language)}</span></button>)}
        </div>
        <label>{t.adoptionSearch}<input type="search" placeholder={t.adoptionSearchPlaceholder}
          value={search} onChange={e => setSearch(e.target.value)} /></label>
      </div>
      <div className="adoption-result-summary caption" role="status">
        {t.adoptionShowing.replace("{shown}", String(visible.length)).replace("{total}", String(filtered.length))}
        {" · "}{view === "configuration" ? t.adoptionSortConfigured : t.adoptionSortUsed}
      </div>
      <div className="adoption-features">
        {visible.map(entry => <article className="adoption-feature" key={entry.key} aria-label={entry.text.name}>
          <div className="adoption-feature-name">
            <h3>{entry.text.name}</h3>
            {!Object.hasOwn(catalog.features, entry.key) && <span className="badge">{t.adoptionLegacy}</span>}
            <details>
              <summary>{t.adoptionDefinition}</summary>
              <p><strong>{t.adoptionConfigured}:</strong> {entry.text.configured}</p>
              <p><strong>{t.adoptionUsed}:</strong> {entry.text.used || t.adoptionUseNotCollected}</p>
            </details>
          </div>
          {configurationKind(entry.key) === "builtin"
            ? <div className="adoption-signal"><strong>{t.adoptionBuiltin}</strong><p className="caption">{t.adoptionAvailabilityOnly}</p></div>
            : <AdoptionSignal label={["flag", "capability"].includes(configurationKind(entry.key)) ? t.adoptionEnabled : t.adoptionConfigured} yes={entry.configured} reported={entry.reported} total={data.installations} language={language} />}
          {entry.text.used
            ? <AdoptionSignal label={t.adoptionUsed} yes={entry.used} reported={entry.used_reported} total={data.installations} language={language} />
            : <div className="adoption-signal"><span className="small">{t.adoptionUsed}</span><p className="caption">{t.adoptionUseNotCollected}</p></div>}
          <button className="btn adoption-trend" onClick={() => onExplore({ feature: entry.key })}
            aria-label={`${t.adoptionTrend}: ${entry.text.name}`}>{t.adoptionTrend} <span aria-hidden="true">↗</span></button>
        </article>)}
      </div>
      {!filtered.length && <p className="notice">{t.adoptionNoMatches}</p>}
      {view === "all" && !search.trim() && filtered.length > PREVIEW_SIZE && <button className="btn section"
        onClick={() => setShowAll(value => !value)}>{showAll ? t.adoptionShowLess : t.adoptionShowAll.replace("{count}", String(filtered.length))}</button>}
    </>}
  </section>;
}

function AdoptionSignal({ label, yes, reported, total, language }: {
  label: string; yes: number; reported: number; total: number; language: Language;
}) {
  const t = messages[language];
  const percent = reported ? yes / reported * 100 : null;
  const format = (value: number) => value.toLocaleString(language);
  const counts = `${format(yes)} ${t.adoptionYes} · ${format(reported - yes)} ${t.adoptionNo} · ${format(total - reported)} ${t.adoptionUnknown}`;
  return <div className="adoption-signal" aria-label={label}>
    <div className="adoption-signal-heading"><span>{label}</span><strong>{percent === null ? "—" : `${percent.toLocaleString(language, { maximumFractionDigits: 1 })}%`}</strong></div>
    {percent !== null && <div className="bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent} aria-valuetext={counts}><span style={{ width: `${percent}%` }} /></div>}
    <p className="caption">{percent === null ? `${t.unknown} · ${counts}` : counts}</p>
  </div>;
}
