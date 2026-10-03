const $ = (id) => document.getElementById(id);
const today = () => new Date().toLocaleDateString("en-CA");

(async () => {
  const STATS_KEY = FF_MOCK ? "testStats" : "stats";
  const s = await chrome.storage.local.get({ ...FF_DEFAULTS, [STATS_KEY]: null });
  s.stats = s[STATS_KEY];
  $("testBanner").hidden = !FF_MOCK;
  const stats = s.stats?.day === today() ? s.stats : { today: 0, total: s.stats?.total || 0, byRule: {} };

  // On/off
  $("enabled").checked = s.enabled;
  const renderPaused = () => {
    $("paused").hidden = $("enabled").checked;
    $("hero").classList.toggle("dim", !$("enabled").checked);
  };
  renderPaused();
  $("enabled").onchange = (e) => { chrome.storage.local.set({ enabled: e.target.checked }); renderPaused(); };
  $("openOptions").onclick = () => chrome.runtime.openOptionsPage();
  $("finishSetup").onclick = () => chrome.runtime.openOptionsPage();

  // Today's count, animated up from zero.
  countUp($("today"), stats.today);
  $("todayLabel").textContent = stats.today === 1 ? "tweet kept out of your feed today" : "tweets kept out of your feed today";
  $("sub").textContent = stats.total ? `${stats.total.toLocaleString()} since you started` : "Nothing scared off yet.";

  // Setup problems
  const active = s.rules.filter((r) => r.enabled);
  const needsKey = active.some((r) => r.type === "ai") && !s.apiKey;
  if (!FF_MOCK && (!s.rules.length || needsKey)) {
    $("setup").hidden = false;
    $("setupText").textContent = !s.rules.length
      ? "Add a filter and Scarecrow gets to work."
      : "Your described filters need an API key before they can run.";
  }

  // Per-filter breakdown
  const rows = Object.entries(stats.byRule || {})
    .map(([id, n]) => ({ rule: s.rules.find((r) => r.id === id), n }))
    .filter((x) => x.rule)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  if (rows.length) {
    $("breakdown").hidden = false;
    const max = rows[0].n;
    $("byRule").replaceChildren(...rows.map(({ rule, n }) => {
      const li = document.createElement("li");
      li.innerHTML = '<span class="bar-label"></span><span class="bar-n"></span><span class="bar"><span></span></span>';
      li.querySelector(".bar-label").textContent = rule.text;
      li.querySelector(".bar-n").textContent = n;
      li.querySelector(".bar span").style.width = `${Math.max(6, (n / max) * 100)}%`;
      return li;
    }));
  }

  const { lastError } = await chrome.storage.session.get("lastError");
  if (lastError) { $("error").hidden = false; $("error").textContent = lastError; }

  // This page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "stats" });
    if (res.hidden) $("sub").textContent = `${res.hidden} on this page, ${stats.total.toLocaleString()} since you started`;
  } catch { /* not on X */ }
})();

function countUp(el, target) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || target < 2) { el.textContent = target; return; }
  const start = performance.now(), dur = Math.min(900, 300 + target * 20);
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
