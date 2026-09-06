import { useState } from "react";
import catalog from "../protocol/features.v2.json";
import { messages } from "./historyLocale";

export function FeatureCatalog() {
  const [lang, setLang] = useState<"en" | "de">("en");
  const [search, setSearch] = useState("");
  const german = lang === "de";
  const entries = Object.entries(catalog.features).filter(([key, value]) =>
    `${key} ${value.name[lang]}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel section" id="feature-catalog" lang={lang}>
    <h2>{german ? "Alle 73 Funktionssignale" : "All 73 capability signals"}</h2>
    <div className="controls">
      <label>Language / Sprache
        <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "de")}>
          <option value="en">English</option><option value="de">Deutsch</option>
        </select>
      </label>
      <label>{german ? "Funktionsname oder Schlüssel suchen" : "Search capability name or key"}
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
    </div>
    <p>{german
      ? "usage.v2: 56 Konfiguriert/Genutzt-Paare und 17 reine Konfigurationswerte. Ein Bit pro Installation, keine Person, Aktion, Anzahl oder Besucherbeobachtung. Integriert bedeutet verfügbar, nicht benutzt. Angenommene Aufträge gelten als gestartet, nicht zwingend abgeschlossen."
      : "usage.v2: 56 configured/used pairs and 17 configuration-only booleans. One bit per installation, no person, action history, counts or visitor observation. Built-in means available, not used. Accepted jobs count as initiated, not necessarily completed."}</p>
    <p>{german
      ? "v1 behält die bisherigen 19 Signale. Neue Signale werden erst nach ausdrücklicher v2-Zustimmung erfasst. Dabei beginnt der lokale Genutzt-Zeitraum neu; v1 misst seit Teilnahme. Nicht gemeldete Felder sind unbekannt, nicht false. Rohberichte behalten ihre ursprüngliche Version."
      : "v1 keeps the original 19 signals. New signals require explicit v2 consent, restarting the local used observation period; v1 measures since joining. Unreported fields are unknown, not false. Raw reports retain their original version."}</p>
    <p className="notice">{messages[lang].accessDisclosure}</p>
    {entries.map(([key, value]) => <details className="catalog-entry" key={key}>
      <summary>{value.name[lang]} <small><code>{key}</code> · {value.since}</small></summary>
      <p><strong>{german ? "Konfiguriert" : "Configured"}:</strong> {value.configured[lang]}</p>
      <p>{value.used
        ? <><strong>{german ? "Genutzt" : "Used"}:</strong> {value.used[lang]}</>
        : german ? "Nur Konfiguration — tatsächliche Nutzung wird nicht erfasst." : "Configuration only — actual use is not collected."}</p>
    </details>)}
    {!entries.length && <p>{german ? "Keine passenden Funktionen." : "No matching capabilities."}</p>}
    <p><a className="textlink ink" href="/schema/features.v2.json">JSON: features.v2</a></p>
  </section>;
}
