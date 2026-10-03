// ─────────────────────────────────────────────────────────────────────────────
// Development config.
//
// mockDecisions: true  → Test mode. No API calls, no key needed. About half of
//                         tweets are hidden at random (the same tweet always gets
//                         the same result), with fake match scores and a short
//                         fake delay so the blur and hide animation are visible.
//
// The production build (`node scripts/build.mjs`) replaces this whole file with
// mockDecisions: false. As a second lock, test mode never runs in an install from
// the Chrome Web Store, even if this file says true.
// ─────────────────────────────────────────────────────────────────────────────
const FF_CONFIG = {
  mockDecisions: false,
  mockHideRate: 0.5,          // share of tweets to hide (0.5 = about every second tweet)
  mockLatencyMs: [80, 450]    // fake response time, similar to Jev's real ~70–500 ms
};

// Web Store installs always have an update_url; unpacked developer installs don't.
const FF_IS_DEV_INSTALL = !("update_url" in chrome.runtime.getManifest());
const FF_MOCK = FF_CONFIG.mockDecisions === true && FF_IS_DEV_INSTALL;

// Deterministic 0–1 value from a string, so a tweet's fake verdict is stable.
function ffMockRandom(str) {
  return (parseInt(ffHash(String(str)), 36) % 10007) / 10007;
}
