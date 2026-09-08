// Contract fixture for script loading and browser integration. Local QA can
// also run the same tests with UMAMI_TRACKER_FIXTURE pointing at Umami's tracker.
module.exports = `(() => {
  const script = document.currentScript;
  const originalReferrer = document.referrer;
  const track = input => {
    let payload = { website: script.dataset.websiteId, hostname: location.hostname,
      language: navigator.language, screen: screen.width + "x" + screen.height,
      title: document.title, url: location.href, referrer: originalReferrer };
    if (typeof input === "function") payload = input(payload);
    else if (typeof input === "string") payload.name = input;
    payload = window[script.dataset.beforeSend]("event", payload);
    if (!payload) return Promise.resolve();
    return fetch(new URL("/api/send", script.src), { method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "event", payload }) });
  };
  window.umami = { track };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function(...args) {
      const result = original.apply(this, args);
      setTimeout(() => track(), 0);
      return result;
    };
  }
  track();
})();`;
