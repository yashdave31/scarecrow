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
  displayMode: "collapse"   // "collapse" = one-line stub, "remove" = gone entirely
};
const FF_KEYS = Object.keys(FF_DEFAULTS);

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
