const $ = (id) => document.getElementById(id);
const todayStr = () => new Date().toLocaleDateString("en-CA");
let s;
let stats = { byRule: {} };

const EXAMPLES = {
  ai: [
    "with sexual or explicit content",
    "about [celebrity name], including nicknames and fan accounts",
    "spoiling [TV show], including plot details and reactions",
    "that are rage bait or engagement farming",
    "showing graphic violence or injuries",
    "promoting crypto giveaways or get-rich-quick schemes"
  ],
  keyword: ["nsfw, onlyfans", "#spoilers, finale", "giveaway, airdrop"]
};
const HINTS = {
  ai: "Describe it like you would to a friend. Jev understands context, so it also catches paraphrases, nicknames and images.",
  keyword: "Separate words or phrases with commas. Matched instantly as whole words, also inside images. No key needed."
};
const PLACEHOLDERS = { ai: "with sexual or explicit content", keyword: "nsfw, onlyfans" };

const ruleType = () => document.querySelector('input[name="ruleType"]:checked').value;

let savedTimer;
async function save(patch) {
  Object.assign(s, patch);
  await chrome.storage.local.set(patch);
  $("saved").dataset.show = "1";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => delete $("saved").dataset.show, 1200);
  renderSetup();
}

// ---------- composer ----------

function renderComposer() {
  const type = ruleType();
  $("typeHint").textContent = HINTS[type];
  $("ruleText").placeholder = PLACEHOLDERS[type];
  $("examples").replaceChildren(...EXAMPLES[type].map((ex) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = ex;
    b.onclick = () => {
      $("ruleText").value = ex;
      $("ruleText").focus();
      const i = ex.indexOf("[");
      if (i >= 0) $("ruleText").setSelectionRange(i, ex.indexOf("]") + 1); // select the placeholder to overwrite
    };
    return b;
  }));
}

$("addRule").onclick = async () => {
  const text = $("ruleText").value.trim();
  if (!text) return $("ruleText").focus();
  const rule = { id: crypto.randomUUID(), type: ruleType(), text, enabled: true };
  await save({ rules: [...s.rules, rule] });
  $("ruleText").value = "";
  renderRules(rule.id);
};
$("ruleText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("addRule").click(); }
});
document.querySelectorAll('input[name="ruleType"]').forEach((r) => (r.onchange = renderComposer));

// ---------- rules list ----------

function updateRule(id, patch) {
  return save({ rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
}

function renderRules(newId) {
  $("rules").replaceChildren(...s.rules.map((rule) => {
    const li = document.createElement("li");
    li.className = (rule.enabled ? "" : "off") + (rule.id === newId ? " new" : "");

    const toggle = document.createElement("label");
    toggle.className = "toggle small";
    toggle.title = rule.enabled ? "Turn this filter off" : "Turn this filter on";
    toggle.innerHTML = '<input type="checkbox"><span class="track"><span class="thumb"></span></span>';
    const box = toggle.querySelector("input");
    box.checked = rule.enabled;
    box.setAttribute("aria-label", "Filter on");
    box.onchange = () => updateRule(rule.id, { enabled: box.checked }).then(() => renderRules());

    const body = document.createElement("div");
    body.className = "rule-body";
    const text = document.createElement("span");
    text.className = "text";
    text.contentEditable = "plaintext-only";
    text.spellcheck = false;
    text.title = "Click to edit";
    text.textContent = rule.text;
    text.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); text.blur(); } };
    text.onblur = () => {
      const v = text.textContent.trim();
      if (!v) text.textContent = rule.text;
      else if (v !== rule.text) updateRule(rule.id, { text: v });
    };
    const meta = document.createElement("span");
    meta.className = "rule-meta";
    const n = stats.byRule?.[rule.id] || 0;
    meta.textContent = (rule.type === "ai" ? "Described" : "Keywords") + (n ? `, hid ${n} today` : "");
    body.append(text, meta);

    const del = document.createElement("button");
    del.className = "quiet";
    del.textContent = "Remove";
    del.onclick = () => save({ rules: s.rules.filter((r) => r.id !== rule.id) }).then(() => renderRules());

    li.append(toggle, body, del);
    return li;
  }));
  $("emptyRules").hidden = s.rules.length > 0;
  const on = s.rules.filter((r) => r.enabled).length;
  $("rulesSummary").textContent = s.rules.length ? `${on} of ${s.rules.length} on` : "";
}

// ---------- setup checklist ----------

function renderSetup() {
  const hasFilter = s.rules.some((r) => r.enabled) || s.hideAds || s.hideAiSlop;
  const needsKey = ffRules(s).some((r) => r.enabled && r.type === "ai") || s.reviewMedia;
  const hasKey = !!s.apiKey;
  $("stepFilter").classList.toggle("done", hasFilter);
  $("stepKey").classList.toggle("done", hasKey);
  $("setup").hidden = FF_MOCK || (hasFilter && (hasKey || !needsKey));
}

// ---------- settings ----------

// ---------- model lists ----------
// OpenRouter lists decision models (output type "decisions") only when asked for all
// output types. The list is public and needs no key. Other providers type the ID in.

let modelList = null;
async function loadModels() {
  if (modelList) return modelList;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models?output_modalities=all");
    modelList = res.ok ? (await res.json()).data || [] : [];
  } catch {
    modelList = [];
  }
  return modelList;
}

// Tried against the real API with three sample posts and did not tell matches from
// non-matches, so they are left out of the picker. A typed ID still works.
const NOT_RECOMMENDED = ["respan/"];
const notRecommended = (id) => NOT_RECOMMENDED.some((p) => id.startsWith(p));

const isFree = (m) => m.pricing?.prompt === "0" && m.pricing?.completion === "0";
const outputs = (m) => m.architecture?.output_modalities || [];

function priceNote(m) {
  if (isFree(m)) return "free";
  const perMillion = Number(m.pricing?.prompt) * 1e6;
  return perMillion > 0 ? `$${perMillion < 1 ? perMillion.toFixed(3).replace(/0+$/, "") : perMillion.toFixed(2)} per million tokens in` : "";
}

const OTHER = "__other__";
const jevIds = (provider) => Object.values(provider.models);

async function renderModelLists() {
  const provider = FF_PROVIDERS[s.provider] || FF_PROVIDERS.openrouter;
  const current = provider.models[s.model] || s.model;
  const free = $("freeOnly").checked;
  const onOpenRouter = s.provider === "openrouter";
  const all = onOpenRouter ? await loadModels() : [];

  // Jev is always listed first, whatever the free filter says, because it is the default.
  const entries = jevIds(provider).map((id) => {
    const m = all.find((x) => x.id === id);
    const label = id === provider.models.pinned ? "Jev 1.13 (default)" : id.includes("latest") ? "Jev latest (updates automatically)" : id;
    return { id, label: m && priceNote(m) ? `${label}, ${priceNote(m)}` : label };
  });
  for (const m of all) {
    if (!outputs(m).includes("decisions") || entries.some((e) => e.id === m.id) || notRecommended(m.id)) continue;
    if (free && !isFree(m) && m.id !== current) continue;
    entries.push({ id: m.id, label: [m.name, priceNote(m)].filter(Boolean).join(", ") });
  }
  const choose = entries.some((e) => e.id === current) ? current : OTHER;
  $("model").replaceChildren(...[...entries, { id: OTHER, label: "Other model (type an ID)" }].map(({ id, label }) => {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = label;
    return o;
  }));
  $("model").value = choose;
  $("modelOther").hidden = choose !== OTHER;
  if (choose === OTHER) $("modelOther").value = current;

  const fillVision = (models) => $("visionModels").replaceChildren(...models.map((m) => {
    const o = document.createElement("option");
    o.value = m.id;
    o.label = [m.name, priceNote(m)].filter(Boolean).join(", ");
    return o;
  }));
  fillVision(all.filter((m) => outputs(m).includes("text") && m.architecture?.input_modalities?.includes("image") && (!free || isFree(m))));

  const notes = [];
  if (onOpenRouter && !all.length) notes.push("Couldn't load the model list, but you can still type an ID.");
  if (!onOpenRouter) notes.push("Type a decision model ID from your NanoGPT model list.");
  if (notRecommended(current)) notes.push("This model did not tell matching posts from non-matching ones in our test, so it is not recommended.");
  else if (current && !/jev|mercury-decide/.test(current)) notes.push("Only Jev and Mercury Decide have been tried against the real API. This model may score differently, so adjust strictness if too much or too little is hidden.");
  if (current.endsWith(":free")) notes.push("Free models allow 20 requests a minute and 50 a day (1,000 with $10 in credits), so heavy scrolling can hit the cap.");
  $("modelHint").textContent = notes.join(" ");
}

function renderProvider() {
  const p = FF_PROVIDERS[$("provider").value];
  $("apiKeyLabel").textContent = `${p.name} API key`;
  $("keyHint").textContent = `${p.keyHint}. Your key stays in this browser.`;
  $("visionHint").textContent = `${p.modelsHint}. It must accept images.`;
}

function renderThreshold() {
  const v = Number($("threshold").value);
  $("thresholdOut").textContent = Math.round(v * 100) + "%";
  document.querySelectorAll('input[name="preset"]').forEach((r) => (r.checked = Math.abs(Number(r.value) - v) < 0.001));
}

function bindSettings() {
  $("enabled").checked = s.enabled;
  $("apiKey").value = s.apiKey;
  $("freeOnly").checked = s.freeOnly;
  $("provider").value = s.provider;
  $("threshold").value = s.threshold;
  $("visionModel").value = s.visionModel;
  $("displayMode").value = s.displayMode;
  for (const id of ["blurPending", "reviewMedia", "sampleVideo", "animateHides", "showToast", "hideAds", "hideAiSlop"]) $(id).checked = s[id];
  $("sampleVideo").disabled = !s.reviewMedia;
  renderProvider();
  renderThreshold();
  renderModelLists();

  for (const id of ["enabled", "blurPending", "sampleVideo", "animateHides", "showToast", "hideAds", "hideAiSlop"]) $(id).onchange = (e) => save({ [id]: e.target.checked });
  $("reviewMedia").onchange = (e) => { $("sampleVideo").disabled = !e.target.checked; save({ reviewMedia: e.target.checked }); };
  $("displayMode").onchange = (e) => save({ displayMode: e.target.value });
  $("model").onchange = (e) => {
    if (e.target.value === OTHER) { $("modelOther").hidden = false; $("modelOther").focus(); return; }
    save({ model: e.target.value }).then(renderModelLists);
  };
  $("modelOther").onchange = (e) => save({ model: e.target.value.trim() || FF_DEFAULTS.model }).then(renderModelLists);
  $("freeOnly").onchange = (e) => save({ freeOnly: e.target.checked }).then(renderModelLists);
  $("provider").onchange = (e) => save({ provider: e.target.value }).then(() => { renderProvider(); renderModelLists(); });
  $("apiKey").onchange = (e) => save({ apiKey: e.target.value.trim() });
  $("visionModel").onchange = (e) => save({ visionModel: e.target.value.trim() || FF_DEFAULTS.visionModel });
  $("threshold").oninput = renderThreshold;
  $("threshold").onchange = (e) => save({ threshold: Number(e.target.value) });
  document.querySelectorAll('input[name="preset"]').forEach((r) => (r.onchange = () => {
    $("threshold").value = r.value;
    renderThreshold();
    save({ threshold: Number(r.value) });
  }));
  $("toggleKey").onclick = () => {
    const show = $("apiKey").type === "password";
    $("apiKey").type = show ? "text" : "password";
    $("toggleKey").textContent = show ? "Hide" : "Show";
  };
}

// ---------- test ----------

$("runTest").onclick = async () => {
  const text = $("testText").value.trim();
  const imageUrl = $("testImage").value.trim();
  const out = $("testResult");
  if (!text && !imageUrl) return $("testText").focus();
  $("testMedia").textContent = "";
  $("testScores").replaceChildren();
  out.className = "result";
  out.textContent = "Checking…";
  $("runTest").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "test", text, imageUrl });
  $("runTest").disabled = false;
  if (res.error) { out.className = "result bad"; out.textContent = res.error; return; }
  if (res.result.media?.length) $("testMedia").textContent = "What the image shows: " + res.result.media[0].description;
  if (!FF_MOCK && !ffRules(s).some((r) => r.enabled && r.type === "ai")) { out.textContent = "Add a described filter to see match scores."; return; }
  out.className = "result " + (res.result.hide ? "hit" : "miss");
  out.textContent = res.result.hide ? `Would be filtered: ${res.result.reason}` : "Would be shown";
  $("testScores").replaceChildren(...res.result.scores.map(({ rule, p, at }) => {
    const li = document.createElement("li");
    const bar = document.createElement("span");
    bar.className = "bar" + (p >= (at ?? s.threshold) ? " over" : "");
    bar.style.setProperty("--p", p);
    const label = document.createElement("span");
    label.textContent = `${Math.round(p * 100)}%  ${rule}`;
    li.append(bar, label);
    return li;
  }));
};

// ---------- init ----------

const STATS_KEY = FF_MOCK ? "testStats" : "stats";
chrome.storage.local.get({ ...FF_DEFAULTS, [STATS_KEY]: null }).then((v) => {
  s = v;
  $("testBanner").hidden = !FF_MOCK;
  if (v[STATS_KEY]?.day === todayStr()) stats = v[STATS_KEY];
  bindSettings();
  renderComposer();
  renderRules();
  renderSetup();
});
