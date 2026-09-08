type AnalyticsConfig = { scriptUrl: string; websiteId: string; domains: string[] };
declare global {
  interface Window {
    picpeakAnalyticsAllowed?: (domains: string[]) => boolean;
  }
}

function loadScript(id: string, src: string, attributes: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.defer = true;
    script.referrerPolicy = "no-referrer";
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Analytics unavailable"));
    document.head.append(script);
  });
}

export async function initializeAnalytics() {
  try {
    const response = await fetch("/api/public/analytics-config", { credentials: "omit" });
    if (!response.ok) return;
    const config: AnalyticsConfig | null = await response.json();
    if (!config || document.getElementById("picpeak-analytics-privacy")) return;
    await loadScript("picpeak-analytics-privacy", "/analytics-privacy.js", { "data-site": "usage" });
    if (!window.picpeakAnalyticsAllowed?.(config.domains)) return;
    await loadScript("picpeak-umami", config.scriptUrl, {
      "data-website-id": config.websiteId,
      "data-domains": config.domains.join(","),
      "data-do-not-track": "true",
      "data-exclude-hash": "true",
      "data-before-send": "picpeakUmamiBeforeSend",
    });
  } catch {
    // Analytics must never block reading the portal, even when filtered offline.
  }
}
