// Shared by the content script, background worker, popup and options page.
const FF_DEFAULTS = {
  enabled: true,
  provider: "openrouter",   // "openrouter" | "nanogpt"
  apiKey: "",
  model: "pinned",          // Jev version: "pinned" (jev-1.13) | "latest"
  threshold: 0.7,           // hide when Jev's yes-probability for any filter is at or above this
  // Each rule: { id, type: "ai" | "keyword", text, enabled }
  rules: [],
  reviewMedia: true,        // describe images, GIFs and video thumbnails with a vision model
  sampleVideo: true,        // keep checking frames while a video plays
  visionModel: "anthropic/claude-haiku-4.5",
  blurPending: true,        // blur tweets while they're being checked
  animateHides: true,       // play the fade-and-collapse animation when a tweet is filtered
  showToast: true,          // show a small counter at the bottom of the screen
  hideAds: false,           // also fold promoted tweets (the ones X labels "Ad")
  hideAiSlop: false,        // also fold posts that read like generic AI filler (judged by Jev)
  displayMode: "collapse"   // "collapse" = one-line stub, "remove" = gone entirely
};
const FF_KEYS = Object.keys(FF_DEFAULTS);

// Built-in described filter behind the "AI slop" setting. The text finishes the
// sentence "Don't show me tweets ...". It has its own floor on the threshold because
// style is a fuzzier call than a topic, and a wrong hide is worse than a missed one.
const FF_SLOP_RULE = {
  id: "ai-slop",
  type: "ai",
  enabled: true,
  label: "AI slop",
  minThreshold: 0.8,
  text: "that read like generic AI-written filler: padded advice, formulaic hooks, listicles with a tidy moral, invented personal stories, or buzzword-heavy takes with no specific detail"
};

// The user's own rules plus the built-in ones that are switched on.
function ffRules(s) {
  return s.hideAiSlop ? [...s.rules, FF_SLOP_RULE] : s.rules;
}

const FF_PROVIDERS = {
  openrouter: {
    name: "OpenRouter",
    decisionsUrl: "https://openrouter.ai/api/alpha/decisions",
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    models: { pinned: "typesafe/jev-1.13", latest: "~typesafe/jev-latest" },
    keyHint: "Create one at openrouter.ai/settings/keys",
    modelsHint: "Any vision model ID from openrouter.ai/models"
  },
  nanogpt: {
    name: "NanoGPT",
    decisionsUrl: "https://nano-gpt.com/api/v1/decisions",
    chatUrl: "https://nano-gpt.com/api/v1/chat/completions",
    models: { pinned: "typesafe/jev-1.13", latest: "typesafe/jev-latest" },
    keyHint: "Create one in your NanoGPT account settings",
    modelsHint: "Any vision model ID from NanoGPT's model list"
  }
};

function ffHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function ffShort(text, n = 60) {
  text = String(text || "").replace(/\s+/g, " ").trim();
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}
