import { useState } from "react";
import { catalog } from "./catalog";
import { messages } from "./historyLocale";

export function FeatureCatalog() {
  const [lang, setLang] = useState<"en" | "de">("en");
  const [search, setSearch] = useState("");
  const german = lang === "de";
  const entries = Object.entries(catalog.features).filter(([key, value]) =>
    `${key} ${value.name[lang]}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel section" id="feature-catalog" lang={lang}>
    <h2>{german ? "Alle 86 Funktionssignale" : "All 86 capability signals"}</h2>
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
      ? "usage.v4: 63 Konfiguriert/Genutzt-Paare, 23 reine Konfigurationswerte und zwei Bestandszahlen. Funktionsmarker enthalten keine Person, Aktionshistorie oder Besucherbeobachtung. Integriert bedeutet verfügbar, nicht benutzt. Angenommene Aufträge gelten als gestartet, nicht zwingend abgeschlossen."
      : "usage.v4: 63 configured/used pairs, 23 configuration-only booleans and two inventory totals. Capability markers contain no person, action history or visitor observation. Built-in means available, not used. Accepted jobs count as initiated, not necessarily completed."}</p>
    <p>{german
      ? "v1/v2/v3 behalten ihren bisherigen Umfang unverändert. Erst die ausdrückliche v4-Zustimmung ersetzt die Frage nach erlaubten Downloads durch die Frage nach gesperrten Downloads. Dabei beginnt der lokale Genutzt-Zeitraum neu. Nicht gemeldete Felder sind unbekannt. Rohberichte behalten ihre ursprüngliche Version."
      : "v1/v2/v3 keep their previous scope unchanged. Only explicit v4 consent replaces the question about allowed downloads with the question about restricted downloads, restarting the local used observation period. Unreported fields are unknown. Raw reports retain their original version."}</p>
    <p>{messages[lang].downloadSignals}</p>
    <p className="notice">{messages[lang].accessDisclosure}</p>
    <section className="section">
      <h3>{messages[lang].inventoryTitle}</h3>
      <p>{messages[lang].inventoryCatalog}</p>
      {Object.entries(catalog.inventory).map(([key, value]) => <p key={key}>
        <strong>{value.name[lang]}</strong> · <code>inventory.{key}</code>: {value.description[lang]}
      </p>)}
    </section>
    {entries.map(([key, value]) => <details className="catalog-entry" key={key}>
      <summary>{value.name[lang]} <small><code>{key}</code> · {value.since}</small></summary>
      <p><strong>{german ? "Konfiguriert" : "Configured"}:</strong> {value.configured[lang]}</p>
      <p>{value.used
        ? <><strong>{german ? "Genutzt" : "Used"}:</strong> {value.used[lang]}</>
        : german ? "Nur Konfiguration — tatsächliche Nutzung wird nicht erfasst." : "Configuration only — actual use is not collected."}</p>
    </details>)}
    {!entries.length && <p>{german ? "Keine passenden Funktionen." : "No matching capabilities."}</p>}
    <p><a className="textlink ink" href="/schema/features.v4.json">JSON: features.v4</a></p>
  </section>;
}
