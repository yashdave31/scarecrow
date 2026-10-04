importScripts("defaults.js", "config.js");

// Make test mode impossible to miss: an orange TEST badge on the toolbar icon.
if (FF_MOCK) {
  chrome.action.setBadgeText({ text: "TEST" });
  chrome.action.setBadgeBackgroundColor({ color: "#E8590C" });
} else {
  chrome.action.setBadgeText({ text: "" });
}

// Pipeline per tweet:
//   1. A vision model turns each image / GIF / video frame into a short factual description.
//   2. Jev gets the tweet text + those descriptions as `state`, and each filter as a yes/no (noul) question.
//   3. If any filter's probability is at or above the threshold, the tweet is hidden.
const MAX_CONCURRENT = 4;
const MAX_MEDIA_PER_TWEET = 4;

const VISION_PROMPT = `You describe images from social media posts so a separate filter can decide whether to hide them.
In 2-4 plain sentences, state:
- what is shown;
- whether there is nudity or sexual content, and how explicit;
- whether there is violence, gore, injury, or weapons;
- any visible text, captions, logos, or written names, transcribed exactly.
Do not identify real people from their faces or appearance. Only name a person if their name is written in the image.
Be factual and neutral. If something is too explicit to describe, say so plainly (for example "explicit sexual image").`;

let hadError = false;
let lastErrorMessage = "";
let active = 0;
const waiting = [];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p, key) => p.then(
    (v) => sendResponse({ [key]: v }),
    (err) => sendResponse({ error: String(err?.message || err) })
  );
  if (msg?.type === "classify") { reply(classify(msg.tweets), "results"); return true; }
  if (msg?.type === "frame") { reply(classifyFrame(msg.tweet, msg.frame), "result"); return true; }
  if (msg?.type === "test") {
    const images = msg.imageUrl ? [{ url: msg.imageUrl, kind: "photo" }] : [];
    const tweet = { id: "test", author: "", text: msg.text || "", quoted: "", images };
    reply(classify([tweet], { useCache: false }).then((r) => r[0]), "result");
    return true;
  }
});

// ---------- main entry points ----------

async function loadContext() {
  const s = await chrome.storage.local.get(FF_DEFAULTS);
  const provider = FF_PROVIDERS[s.provider] || FF_PROVIDERS.openrouter;
  return {
    s,
    provider,
    jevModel: provider.models[s.model] || s.model || provider.models.pinned,
    rules: ffRules(s).filter((r) => r.enabled && r.type === "ai" && r.text.trim()),
    wantMedia: s.reviewMedia && !!s.apiKey && s.rules.some((r) => r.enabled)
  };
}

async function classify(tweets, { useCache = true } = {}) {
  const ctx = await loadContext();
  if (FF_MOCK) return mockClassify(tweets, ctx);
  const { s, rules, wantMedia } = ctx;
  const empty = (t) => ({ id: t.id, hide: false, scores: [], media: [] });
  if (!rules.length && !wantMedia) return tweets.map(empty);
  if (!s.apiKey) throw new Error("No API key set. Add one in Scarecrow settings.");

  const version = ffHash([s.provider, ctx.jevModel, wantMedia && s.visionModel, ...rules.map((r) => r.id + ":" + r.text)].join("\n"));
  const keyFor = (id) => `p:${version}:${id}`;
  const cached = useCache ? await chrome.storage.session.get(tweets.map((t) => keyFor(t.id))) : {};

  const results = await Promise.all(tweets.map(async (t) => {
    try {
      const media = wantMedia ? await describeAll(ctx, t.images || [], useCache) : [];
      if (!rules.length) return { ...empty(t), media };
      let probs = cached[keyFor(t.id)];
      if (!probs) {
        probs = await limited(() => askJev(ctx, t, media));
        if (useCache) chrome.storage.session.set({ [keyFor(t.id)]: probs }).catch(() => {});
      }
      return { ...decide(t.id, rules, probs, s.threshold), media };
    } catch (err) {
      reportError(err);
      return { ...empty(t), failed: true, error: String(err?.message || err) };
    }
  }));

  settleErrors(results);
  return results;
}

// A single frame captured from a playing video. Not cached: each frame is new.
async function classifyFrame(tweet, frameDataUrl) {
  const ctx = await loadContext();
  if (FF_MOCK) return { id: tweet.id, hide: false, scores: [], media: [] }; // thumbnails already decided
  if (!ctx.wantMedia) return { id: tweet.id, hide: false, scores: [], media: [] };
  try {
    const description = await limited(() => describeImage(ctx, frameDataUrl));
    const media = [{ kind: "video frame", description }];
    if (!ctx.rules.length) return { id: tweet.id, hide: false, scores: [], media };
    const probs = await limited(() => askJev(ctx, tweet, media));
    return { ...decide(tweet.id, ctx.rules, probs, ctx.s.threshold), media };
  } catch (err) {
    reportError(err);
    throw err;
  }
}

function decide(id, rules, probs, threshold) {
  const scores = rules.map((r, i) => ({ rule: r.label || r.text, ruleId: r.id, p: probs[i] ?? 0, at: Math.max(threshold, r.minThreshold || 0) }));
  // A rule can ask for more certainty than the global setting, so compare each to its own bar.
  const top = scores.reduce((a, b) => (b.p - b.at > a.p - a.at ? b : a), { p: -1, at: 0 });
  const hide = top.p >= top.at;
  return {
    id,
    hide,
    scores,
    reason: hide ? ffShort(top.rule, 50) : "",
    meta: hide ? `${Math.round(top.p * 100)}% match` : "",
    ruleId: hide ? top.ruleId : null
  };
}

// ---------- test mode (development only) ----------
// Fake Jev: no network calls. Hides about FF_CONFIG.mockHideRate of tweets, chosen
// from a hash of the tweet ID so results are stable while scrolling.
async function mockClassify(tweets, ctx) {
  const [lo, hi] = FF_CONFIG.mockLatencyMs;
  const rules = ctx.rules.length ? ctx.rules : [{ id: "test", text: "test mode" }];
  return Promise.all(tweets.map(async (t) => {
    const key = t.id === "test" ? t.text : t.id; // the settings "Try it" box hashes the text
    await new Promise((r) => setTimeout(r, lo + ffMockRandom(key + ":ms") * (hi - lo)));
    const hide = ffMockRandom(key) < FF_CONFIG.mockHideRate;
    const pick = Math.floor(ffMockRandom(key + ":rule") * rules.length);
    const scores = rules.map((r, i) => ({
      rule: r.label || r.text,
      ruleId: r.id,
      p: hide && i === pick ? 0.72 + 0.27 * ffMockRandom(key + ":p") : 0.03 + 0.3 * ffMockRandom(key + ":q" + i)
    }));
    const top = scores[pick];
    return {
      id: t.id,
      hide,
      scores,
      media: [],
      reason: hide ? ffShort(top.rule, 50) : "",
      meta: hide ? `${Math.round(top.p * 100)}% match (test)` : "",
      ruleId: hide && top.ruleId !== "test" ? top.ruleId : null
    };
  }));
}

// ---------- vision step ----------

async function describeAll(ctx, images, useCache) {
  const items = images.slice(0, MAX_MEDIA_PER_TWEET);
  return Promise.all(items.map(async ({ url, kind }) => {
    const key = `m:${ffHash(ctx.s.visionModel)}:${url}`;
    if (useCache) {
      const hit = (await chrome.storage.session.get(key))[key];
      if (hit) return { kind, description: hit };
    }
    const description = await limited(() => describeImage(ctx, url));
    if (useCache) chrome.storage.session.set({ [key]: description }).catch(() => {});
    return { kind, description };
  }));
}

async function describeImage(ctx, src) {
  const dataUrl = src.startsWith("data:") ? src : await toDataUrl(src);
  const res = await fetch(ctx.provider.chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.s.apiKey}` },
    body: JSON.stringify({
      model: ctx.s.visionModel,
      max_tokens: 220,
      temperature: 0,
      messages: [
        { role: "system", content: VISION_PROMPT },
        { role: "user", content: [
          { type: "text", text: "Describe this image." },
          { type: "image_url", image_url: { url: dataUrl } }
        ] }
      ]
    })
  });
  if (!res.ok) throw new Error(`Vision model ${res.status}: ${await errorMessage(res)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  return (Array.isArray(text) ? text.map((p) => p.text || "").join(" ") : text || "").trim() || "(no description)";
}

// Fetch from the worker so the provider never has to reach X's CDN itself.
async function toDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load image (${res.status})`);
  const type = res.headers.get("content-type") || "image/jpeg";
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

// ---------- decision step (Jev) ----------

// Some models (Respan's, for one) only accept `state` as a plain string. Once a model
// has refused the object form, it gets the string form from then on.
const stringStateModels = new Set();

function stateAsText(state) {
  return Object.entries(state)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

async function askJev(ctx, t, media) {
  const state = { author: t.author || "unknown", text: t.text || "(no text)" };
  if (t.quoted) state.quoted_tweet = t.quoted;
  if (media.length) state.attached_media = media.map((m) => ({ type: m.kind, description: m.description }));
  else if (t.images?.length) state.attached_media = `${t.images.length} item(s), not analysed`;

  const questions = {};
  ctx.rules.forEach((r, i) => {
    questions[`rule_${i}`] = {
      type: "noul",
      instructions:
        `The user wrote a feed filter: "Don't show me tweets ${r.text.trim()}". ` +
        "Does this tweet match that filter? Consider its text, quoted tweet, author, and the descriptions of its images and videos. " +
        "Judge by the filter's intent, including indirect references and nicknames.",
      criteria: {
        true: "The tweet or its media clearly matches the filter and should be hidden",
        false: "Neither the tweet nor its media matches the filter, or only touches it tangentially"
      }
    };
  });

  const send = (asText) => fetch(ctx.provider.decisionsUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.s.apiKey}` },
    body: JSON.stringify({ model: ctx.jevModel, state: asText ? stateAsText(state) : state, questions })
  });
  let res = await send(stringStateModels.has(ctx.jevModel));
  if (res.status === 400 && !stringStateModels.has(ctx.jevModel)) {
    const msg = await res.clone().text();
    if (/state/i.test(msg)) {
      stringStateModels.add(ctx.jevModel);
      res = await send(true);
    }
  }
  if (!res.ok) {
    const msg = await errorMessage(res);
    if (res.status === 429 && ctx.jevModel.endsWith(":free")) {
      throw new Error("Free model limit reached. OpenRouter allows 20 requests a minute and 50 a day on free models (1,000 a day with $10 in credits). Try again later or pick another model.");
    }
    throw new Error(`${ctx.jevModel} ${res.status}: ${msg}`);
  }
  const data = await res.json();
  const probs = ctx.rules.map((_, i) => data.answers?.[`rule_${i}`]?.noul);
  // Other decision models may not answer yes/no questions the way Jev does.
  if (!probs.some((p) => typeof p === "number")) throw new Error(`${ctx.jevModel} returned no yes/no answers. Try a different model.`);
  return probs.map((p) => (typeof p === "number" ? p : 0));
}

// ---------- helpers ----------

async function errorMessage(res) {
  const body = await res.text();
  try { return JSON.parse(body).error.message; } catch { return body.slice(0, 200); }
}

function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try { resolve(await fn()); } catch (e) { reject(e); }
      finally { active--; if (waiting.length) waiting.shift()(); }
    };
    active < MAX_CONCURRENT ? run() : waiting.push(run);
  });
}

function reportError(err) {
  hadError = true;
  lastErrorMessage = String(err?.message || err);
  chrome.storage.session.set({ lastError: lastErrorMessage, lastErrorAt: Date.now() });
}

function settleErrors(results) {
  if (hadError && results.length && results.every((r) => !r.failed)) {
    hadError = false;
    chrome.storage.session.remove("lastError");
  }
  if (results.length && results.every((r) => r.failed)) throw new Error(lastErrorMessage);
}
