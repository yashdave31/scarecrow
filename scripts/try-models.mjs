// Tries decision models against the real OpenRouter Decisions API, using the same
// request shape as the extension. The key is read from the environment and never saved.
//
//   OPENROUTER_API_KEY=... node scripts/try-models.mjs                     every free decision model
//   OPENROUTER_API_KEY=... node scripts/try-models.mjs jev inception/mercury-decide:free
//
// "jev" is shorthand for typesafe/jev-1.13. Node 18+, no dependencies.

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error("Set OPENROUTER_API_KEY first, for example:\n  OPENROUTER_API_KEY=... node scripts/try-models.mjs");
  process.exit(1);
}

const FILTERS = [
  "about Taylor Swift, including nicknames and fan accounts",
  "that read like generic AI-written filler: padded advice, formulaic hooks, listicles with a tidy moral, invented personal stories, or buzzword-heavy takes with no specific detail"
];
// What each post should score high on: index into FILTERS, or null for neither.
const POSTS = [
  { text: "Taylor Swift just announced a new tour and the fans are losing it", expect: 0 },
  { text: "Here are 7 lessons I learned scaling to 1M users. Number 4 will surprise you.", expect: 1 },
  { text: "Fixed the flaky test. It was a timezone assumption, as always.", expect: null }
];

async function decide(model, post) {
  const questions = {};
  FILTERS.forEach((text, i) => {
    questions[`rule_${i}`] = {
      type: "noul",
      instructions:
        `The user wrote a feed filter: "Don't show me tweets ${text}". ` +
        "Does this tweet match that filter? Consider its text, quoted tweet, author, and the descriptions of its images and videos. " +
        "Judge by the filter's intent, including indirect references and nicknames.",
      criteria: {
        true: "The tweet or its media clearly matches the filter and should be hidden",
        false: "Neither the tweet nor its media matches the filter, or only touches it tangentially"
      }
    };
  });
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, state: { author: "someone", text: post.text }, questions })
  });
  const ms = Date.now() - t0;
  const body = await res.text();
  if (!res.ok) return { ms, error: `${res.status} ${body.slice(0, 140)}` };
  try {
    const answers = JSON.parse(body).answers || {};
    const probs = FILTERS.map((_, i) => answers[`rule_${i}`]?.noul);
    if (!probs.some((p) => typeof p === "number")) return { ms, error: "no yes/no answers in reply" };
    return { ms, probs };
  } catch {
    return { ms, error: "reply was not JSON" };
  }
}

let models = process.argv.slice(2).map((m) => (m === "jev" ? "typesafe/jev-1.13" : m));
if (!models.length) {
  const res = await fetch("https://openrouter.ai/api/v1/models?output_modalities=all");
  const list = (await res.json()).data || [];
  models = list
    .filter((m) => m.architecture?.output_modalities?.includes("decisions") && m.pricing?.prompt === "0")
    .map((m) => m.id);
  console.log(`Free decision models: ${models.join(", ") || "none found"}\n`);
}

for (const model of models) {
  console.log(model);
  let separates = true;
  for (const post of POSTS) {
    const r = await decide(model, post);
    if (r.error) {
      console.log(`  error: ${r.error}`);
      separates = false;
      break;
    }
    const shown = r.probs.map((p) => (typeof p === "number" ? Math.round(p * 100) + "%" : "-")).join(" / ");
    const hit = post.expect === null ? Math.max(...r.probs.map((p) => p ?? 0)) < 0.3 : (r.probs[post.expect] ?? 0) >= 0.7;
    if (!hit) separates = false;
    console.log(`  ${hit ? "ok " : "off"} ${shown.padEnd(12)} ${String(r.ms).padStart(5)}ms  ${post.text.slice(0, 56)}`);
  }
  console.log(separates ? "  -> separates the three posts as expected\n" : "  -> did not separate them cleanly, or failed\n");
}
