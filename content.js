(() => {
  const BATCH_SIZE = 8;     // tweets per classify message
  const BATCH_DELAY = 30;   // ms to collect a batch; short so tweets are decided before you reach them
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  let settings = { ...FF_DEFAULTS };
  let keywordMatchers = [];
  let generation = 0;            // bumps when rules change, so stale responses are ignored

  const decisions = new Map();   // tweetId -> { hide, reason, meta, ruleId, scores, media }
  const inflight = new Set();    // tweetIds queued or awaiting a response
  const revealed = new Set();    // tweetIds the user chose to show anyway
  const hiddenIds = new Set();   // tweets hidden on this page (counted once each)
  let queue = [];
  let flushTimer = null;
  let scanQueued = false;

  // ---------- settings ----------

  async function loadSettings() {
    settings = await chrome.storage.local.get(FF_DEFAULTS);
    buildKeywordMatchers();
  }

  function buildKeywordMatchers() {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    keywordMatchers = settings.rules
      .filter((r) => r.enabled && r.type === "keyword")
      .map((rule) => {
        const terms = rule.text.split(",").map((t) => t.trim()).filter(Boolean);
        if (!terms.length) return null;
        // Whole-word, case-insensitive, unicode-aware.
        const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${terms.map(esc).join("|")})(?=$|[^\\p{L}\\p{N}_])`, "iu");
        return { rule, re };
      })
      .filter(Boolean);
  }

  const hasAiRules = () => FF_MOCK ||
    !!settings.apiKey && ffRules(settings).some((r) => r.enabled && r.type === "ai" && r.text.trim());
  const wantsMedia = () => settings.reviewMedia && !!settings.apiKey && settings.rules.some((r) => r.enabled);

  function keywordHit(haystack) {
    for (const { rule, re } of keywordMatchers) {
      const m = haystack.match(re);
      if (m) return { term: m[2], rule };
    }
    return null;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(changes).some((k) => FF_KEYS.includes(k))) return;
    const rulesChanged = ["rules", "hideAiSlop", "model", "provider", "apiKey", "threshold", "reviewMedia", "visionModel"].some((k) => k in changes);
    loadSettings().then(() => {
      if (rulesChanged) {
        generation++;
        decisions.clear();
        inflight.clear();
        hiddenIds.clear();
        queue = [];
      }
      scan();
    });
  });

  // ---------- reading tweets ----------

  // X marks promoted tweets with a small "Ad" label. English only for now; other
  // languages use a different word (see the open issues).
  const AD_LABELS = new Set(["Ad", "Promoted"]);
  function isAd(article) {
    for (const s of article.querySelectorAll("span")) {
      if (s.childElementCount === 0 && AD_LABELS.has(s.textContent.trim()) && !s.closest('a, [data-testid="tweetText"]')) return true;
    }
    return false;
  }

  function extract(article) {
    const timeLink = article.querySelector('a[href*="/status/"] time')?.closest("a");
    const idMatch = timeLink?.getAttribute("href")?.match(/status\/(\d+)/);
    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')].map((el) => el.innerText.trim());
    const author = (article.querySelector('[data-testid="User-Name"]')?.innerText || "").replace(/\s+/g, " ").trim();

    // Photos, plus the thumbnail frame of every video and GIF.
    const images = [];
    const seen = new Set();
    for (const el of article.querySelectorAll('[data-testid="tweetPhoto"] img, video[poster]')) {
      let url = el.tagName === "VIDEO" ? el.poster : el.src;
      if (!url || !url.startsWith("https://pbs.twimg.com/")) continue;
      url = url.replace(/([?&]name=)\w+/, "$1small");
      if (seen.has(url)) continue;
      seen.add(url);
      const kind = el.tagName !== "VIDEO" ? "photo" : url.includes("tweet_video_thumb") ? "gif" : "video thumbnail";
      images.push({ url, kind });
    }

    return {
      id: idMatch ? idMatch[1] : "h" + ffHash(author + "|" + texts.join("|")),
      author,
      text: texts[0] || "",
      quoted: texts[1] || "",
      images
    };
  }

  // ---------- states and the hide animation ----------

  function setCellRemoved(article, removed) {
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    if (!cell) return;
    if (removed) cell.dataset.ffRemove = "1";
    else delete cell.dataset.ffRemove;
  }

  function setState(article, state) {
    if (article.dataset.ff !== state) article.dataset.ff = state;
    if (state !== "hidden") {
      delete article.dataset.ffReason;
      delete article.dataset.ffMeta;
      setCellRemoved(article, false);
    }
  }

  function applyHidden(article, info) {
    article.dataset.ffReason = info.label;
    if (info.meta) article.dataset.ffMeta = info.meta;
    else delete article.dataset.ffMeta;
    article.dataset.ff = "hidden";
    setCellRemoved(article, settings.displayMode === "remove");
  }

  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  }

  function hide(article, id, info) {
    const prev = article.dataset.ff;
    if (prev === "hiding") return; // animation already running
    if (prev === "hidden" && article.dataset.ffReason === info.label) return;

    if (!hiddenIds.has(id)) {
      hiddenIds.add(id);
      recordHide(info);
    }
    seenWatcher.observe(article); // the toast waits until the note is actually on screen

    const animate = settings.animateHides && !reduceMotion.matches &&
      (prev === "shown" || prev === "pending") && inView(article);
    if (animate) animateHide(article, info);
    else applyHidden(article, info);
  }

  // The height changes in a single step: X positions every tweet itself, so animating
  // the height makes it re-place everything below on every frame, which flickers.
  // Motion is limited to opacity and the note's flash, which don't affect layout.
  //   pending → hidden: the tweet was never shown, so it goes straight to the note.
  //   shown   → hidden: (e.g. a video frame matched) the tweet fades out first.
  function animateHide(article, info) {
    const id = article.dataset.ffId;
    const finish = () => {
      if (article.dataset.ffId !== id) return;
      applyHidden(article, info);
      if (settings.displayMode !== "remove") {
        article.dataset.ffFresh = "1";
        setTimeout(() => delete article.dataset.ffFresh, 1400);
      }
    };
    if (article.dataset.ff === "pending") return finish();
    article.dataset.ff = "hiding";
    setTimeout(finish, 220);
  }

  // ---------- counter toast and stats ----------

  let toast = null;
  let toastTimer = null;
  let lastBump = 0;
  let recentToasts = 0;
  let todayCount = 0;
  let pendingStats = { n: 0, byRule: {} };
  let statsTimer = null;

  const today = () => new Date().toLocaleDateString("en-CA");
  const STATS_KEY = FF_MOCK ? "testStats" : "stats"; // test hides never touch real stats

  async function loadStats() {
    const { [STATS_KEY]: stats } = await chrome.storage.local.get(STATS_KEY);
    todayCount = stats?.day === today() ? stats.today : 0;
  }

  function recordHide(info) {
    todayCount++;
    pendingStats.n++;
    if (info.ruleId) pendingStats.byRule[info.ruleId] = (pendingStats.byRule[info.ruleId] || 0) + 1;
    clearTimeout(statsTimer);
    statsTimer = setTimeout(saveStats, 800);
  }

  // Toast only for filtered tweets the person actually scrolls to. X builds tweets
  // ahead of the viewport and most are filtered before they're reached, so toasting
  // at decision time flashed messages about tweets nobody saw.
  const toastedIds = new Set();
  const seenWatcher = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const a = e.target;
      if (!e.isIntersecting || a.dataset.ff !== "hidden") continue;
      const id = a.dataset.ffId;
      if (toastedIds.has(id)) continue;
      toastedIds.add(id);
      showToast({ label: a.dataset.ffReason || "a filter" });
    }
  }, { threshold: 0.6 });

  async function saveStats() {
    const add = pendingStats;
    pendingStats = { n: 0, byRule: {} };
    try {
      let { [STATS_KEY]: stats } = await chrome.storage.local.get(STATS_KEY);
      if (!stats || stats.day !== today()) stats = { day: today(), today: 0, total: stats?.total || 0, byRule: {} };
      stats.today += add.n;
      stats.total += add.n;
      for (const [k, v] of Object.entries(add.byRule)) stats.byRule[k] = (stats.byRule[k] || 0) + v;
      await chrome.storage.local.set({ [STATS_KEY]: stats });
    } catch { /* extension reloaded */ }
  }

  function showToast(info) {
    if (!settings.showToast) return;
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "ff-toast";
      toast.setAttribute("role", "status");
      toast.innerHTML = '<span class="ff-toast-icon"></span><span class="ff-toast-text"><span class="ff-toast-title"></span><span class="ff-toast-sub"></span></span>';
      document.body.appendChild(toast);
    }
    recentToasts = toast.dataset.show ? recentToasts + 1 : 1;
    toast.querySelector(".ff-toast-title").textContent =
      recentToasts > 1 ? `Filtered ${recentToasts} tweets just now` : `Filtered: ${info.label}`;
    toast.querySelector(".ff-toast-sub").textContent =
      `${todayCount} tweet${todayCount === 1 ? "" : "s"} kept out of your feed today` + (FF_MOCK ? " (test mode)" : "");
    // While it's already up, later hides just update the text. The icon bumps at most
    // once every 1.2 s, so scrolling past several filtered tweets doesn't make it jitter.
    const now = performance.now();
    if (!toast.dataset.show || now - lastBump > 1200) {
      lastBump = now;
      toast.classList.remove("ff-bump");
      void toast.offsetWidth;
      toast.classList.add("ff-bump");
    }
    toast.dataset.show = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => delete toast.dataset.show, 3200);
  }

  // ---------- deciding ----------

  function infoFromKeyword(hit, where = "") {
    return { label: `"${ffShort(hit.term, 30)}"${where}`, meta: "keyword", ruleId: hit.rule.id };
  }

  function process(article) {
    if (!settings.enabled) return setState(article, "off");

    const t = extract(article);
    if (article.dataset.ffId !== t.id) {
      article.dataset.ffId = t.id; // X recycles DOM nodes, so always re-key
      if (article.dataset.ff === "hidden" || article.dataset.ff === "hiding") setState(article, "pending");
    }
    if (article.dataset.ff === "hiding") return;

    if (revealed.has(t.id)) return setState(article, "revealed");

    // 0. Ads: no model needed.
    if (settings.hideAds && isAd(article)) return hide(article, t.id, { label: "an ad", meta: "promoted", ruleId: "ads" });

    // 1. Keyword rules: instant, free, local.
    const kw = keywordHit(`${t.author}\n${t.text}\n${t.quoted}`);
    if (kw) return hide(article, t.id, infoFromKeyword(kw));

    // 2. Vision model describes media, then Jev decides on word-described filters.
    const needsCheck = hasAiRules() || (wantsMedia() && t.images.length);
    if (!needsCheck || (!t.text && !t.quoted && !t.images.length)) return setState(article, "shown");

    const d = decisions.get(t.id);
    if (d) {
      // Diagnostic: the verdict, readable from DevTools.
      article.dataset.ffDebug = d.failed
        ? "failed: " + (d.error || "")
        : JSON.stringify({ scores: (d.scores || []).map((x) => Math.round(x.p * 100)), media: (d.media || []).length });
      // Keyword filters also apply to text found inside images.
      const mediaKw = d.media?.length && keywordHit(d.media.map((m) => m.description).join("\n"));
      if (mediaKw) return hide(article, t.id, infoFromKeyword(mediaKw, " in media"));
      if (d.hide) return hide(article, t.id, { label: d.reason, meta: d.meta, ruleId: d.ruleId });
      return setState(article, "shown");
    }

    setState(article, settings.blurPending ? "pending" : "shown");
    if (!inflight.has(t.id)) {
      inflight.add(t.id);
      queue.push(t);
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, queue.length >= BATCH_SIZE ? 0 : BATCH_DELAY);
  }

  async function flush() {
    flushTimer = null;
    const batch = queue.splice(0, BATCH_SIZE);
    if (queue.length) scheduleFlush();
    if (!batch.length) return;

    const gen = generation;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "classify", tweets: batch });
    } catch (e) {
      res = { error: e.message }; // e.g. extension was reloaded
    }
    if (gen !== generation) return; // rules changed while we waited

    if (res?.results) {
      // Don't let a thumbnail verdict undo a hide that came from a video frame.
      for (const r of res.results) if (r && !decisions.get(r.id)?.hide) decisions.set(r.id, r);
    } else {
      // Fail open: if the model can't be reached, show the tweets.
      console.warn("[Scarecrow]", res?.error);
      document.documentElement.dataset.ffLastError = String(res?.error || "unknown error");
      for (const t of batch) decisions.set(t.id, { id: t.id, hide: false, failed: true, error: res?.error });
    }
    for (const t of batch) inflight.delete(t.id);
    scan();
  }

  // ---------- video frames ----------
  // The thumbnail is checked up front. While a video plays, a few more frames are
  // captured and checked, so content that appears mid-video still gets caught.
  const FRAME_TIMES = [2, 6, 15, 30]; // seconds into playback
  const videoState = new WeakMap();    // <video> -> { id, taken, dead, busy }

  function onVideoTime(e) {
    const video = e.target;
    if (!(video instanceof HTMLVideoElement) || !settings.enabled || !settings.sampleVideo || !wantsMedia()) return;
    const article = video.closest('article[data-testid="tweet"]');
    const id = article?.dataset.ffId;
    if (!id || revealed.has(id) || article.dataset.ff === "hidden" || article.dataset.ff === "hiding") return;

    let st = videoState.get(video);
    if (!st || st.id !== id) videoState.set(video, (st = { id, taken: 0, dead: false, busy: false }));
    if (st.dead || st.busy || st.taken >= FRAME_TIMES.length || video.currentTime < FRAME_TIMES[st.taken]) return;
    st.taken++;

    const frame = grabFrame(video);
    if (!frame) { st.dead = true; return; } // frame not readable (e.g. protected stream)
    st.busy = true;
    const gen = generation;
    chrome.runtime.sendMessage({ type: "frame", tweet: extract(article), frame })
      .then((res) => {
        if (gen !== generation || !res?.result) return;
        const r = res.result;
        const kw = r.media?.length && keywordHit(r.media.map((m) => m.description).join("\n"));
        if (r.hide || kw) {
          video.pause();
          decisions.set(id, kw ? { ...r, hide: true, ...relabel(infoFromKeyword(kw, " in video")) } : r);
          scan();
        }
      })
      .catch(() => {})
      .finally(() => { st.busy = false; });
  }

  const relabel = (info) => ({ reason: info.label, meta: info.meta, ruleId: info.ruleId });

  function grabFrame(video) {
    if (!video.videoWidth || video.readyState < 2) return null;
    try {
      const w = 448, h = Math.round((w * video.videoHeight) / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(video, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.7);
    } catch {
      return null;
    }
  }

  // Media events don't bubble, but a capture listener on document still sees them.
  document.addEventListener("timeupdate", onVideoTime, true);

  // ---------- page wiring ----------

  function scan() {
    scanQueued = false;
    document.querySelectorAll('article[data-testid="tweet"]').forEach(process);
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  // Click a filtered note to reveal the tweet (captured before X's own click handler).
  document.addEventListener(
    "click",
    (e) => {
      const article = e.target.closest?.('article[data-ff="hidden"]');
      if (!article) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      revealed.add(article.dataset.ffId);
      setState(article, "revealed");
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "stats") sendResponse({ hidden: hiddenIds.size });
  });

  Promise.all([loadSettings(), loadStats()]).then(() => {
    // Runs before the browser lays out and paints, so X never measures a tweet in a
    // stale state. That matters because X reuses tweet elements: it swaps a new
    // tweet's content into an element we had collapsed. If we waited, X would record
    // the 52px note height, the tweet would then grow back, and the next tweet would
    // be drawn on top of it.
    new MutationObserver((mutations) => {
      const touched = new Set();
      for (const m of mutations) {
        const host = m.target.nodeType === 1 ? m.target.closest('article[data-testid="tweet"]') : null;
        if (host) touched.add(host); // content changed inside an existing (possibly reused) tweet
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches('article[data-testid="tweet"]')) touched.add(node);
          else node.querySelectorAll('article[data-testid="tweet"]').forEach((a) => touched.add(a));
        }
      }
      touched.forEach(process);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
  });
})();
