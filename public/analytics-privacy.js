/* Umami's before-send hook keeps visitor statistics separate from private data. */
(() => {
  const usage = document.currentScript?.getAttribute("data-site") === "usage";
  const publicPaths = usage
    ? ["/", "/packets", "/requests", "/transparency", "/maintainer"]
    : ["", "features", "compare", "faq", "whats-new", "impressum", "privacy",
       "vs-picdrop", "vs-pikd", "vs-piwigo", "vs-pixieset"]
        .flatMap(page => ["de", "en"].map(locale => `/${locale}/${page}`.replace(/\/$/, "")));
  const campaigns = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  const events = ["Open website", "Open GitHub", "Open demo", "Read documentation", "Download source", "Read schema"];
  let previousPageview;

  function blocked() {
    if (navigator.globalPrivacyControl || ["1", "yes"].includes(String(navigator.doNotTrack || window.doNotTrack))) return true;
    try { return Boolean(localStorage.getItem("umami.disabled")); } catch { return false; }
  }

  window.picpeakAnalyticsAllowed = domains => !blocked() && domains.includes(location.hostname);

  function trackCurrent(name) {
    if (blocked() || !window.umami?.track) return;
    try {
      Promise.resolve(window.umami.track(props => ({
        ...props, url: location.href,
        ...(name ? { name } : { referrer: previousPageview || document.referrer }),
      }))).catch(() => {});
    } catch { /* optional analytics */ }
  }

  // Never delay links or downloads while waiting for the analytics server.
  document.addEventListener("click", event => {
    const name = event.target?.closest?.("[data-analytics-event]")?.getAttribute("data-analytics-event");
    if (events.includes(name)) trackCurrent(name);
  }, true);
  // Umami observes pushState/replaceState. Browser back/forward also needs a
  // current-URL payload; its internal URL can still refer to the page we left.
  window.addEventListener("popstate", () => setTimeout(() => trackCurrent(), 0));

  function pagePath(value) {
    const path = value.replace(/\/$/, "") || "/";
    return publicPaths.includes(path) ? path : null;
  }

  function referrer(value) {
    if (!value) return "";
    try {
      const url = new URL(value, location.origin);
      if (!["https:", "http:"].includes(url.protocol)) return "";
      return url.origin === location.origin ? pagePath(url.pathname) || "" : url.origin;
    } catch { return ""; }
  }

  window.picpeakUmamiBeforeSend = (type, payload) => {
    if (blocked() || type !== "event" || !payload || (payload.name && !events.includes(payload.name))) return false;
    try {
      const url = new URL(payload.url, location.origin);
      const path = pagePath(url.pathname);
      if (!path || url.origin !== location.origin) return false;
      const query = new URLSearchParams();
      for (const key of campaigns) {
        const value = url.searchParams.get(key);
        if (value) query.set(key, value.slice(0, 100));
      }
      const cleanUrl = path + (query.size ? `?${query}` : "");
      // Auth handoffs, filters and anchor changes must not duplicate a pageview.
      if (!payload.name && previousPageview === cleanUrl) return false;
      const previous = previousPageview;
      if (!payload.name) previousPageview = cleanUrl;
      return {
        website: payload.website,
        hostname: payload.hostname,
        language: payload.language,
        screen: payload.screen,
        title: payload.title,
        url: cleanUrl,
        referrer: referrer(!payload.name && previous ? previous : payload.referrer),
        ...(payload.name ? { name: payload.name } : {}),
      };
    } catch { return false; }
  };
})();
