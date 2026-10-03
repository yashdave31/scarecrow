// Production build: copies the extension into dist/ with test mode removed.
// Usage: node scripts/build.mjs   (Node 16.7+; no dependencies)
import { cpSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const SKIP = new Set(["dist", "scripts", "README.md", "package.json", "node_modules", "LICENSE", "docs", "site"]);

const PROD_CONFIG = `// Production build. Test mode is off and cannot be turned on.
const FF_CONFIG = Object.freeze({ mockDecisions: false, mockHideRate: 0, mockLatencyMs: [0, 0] });
const FF_IS_DEV_INSTALL = false;
const FF_MOCK = false;
function ffMockRandom() { return 1; }
`;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const name of readdirSync(root)) {
  if (SKIP.has(name) || name.startsWith(".") || name.endsWith(".zip")) continue;
  cpSync(join(root, name), join(dist, name), { recursive: true });
}
writeFileSync(join(dist, "config.js"), PROD_CONFIG);

// Verify: fail loudly if anything could still switch test mode on.
const cfg = readFileSync(join(dist, "config.js"), "utf8");
if (!/mockDecisions: false/.test(cfg) || !/const FF_MOCK = false;/.test(cfg)) {
  console.error("✗ Build check failed: test mode is not disabled in dist/config.js");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const loadsConfig = manifest.content_scripts.every((c) => c.js.includes("config.js"));
if (!loadsConfig) {
  console.error("✗ Build check failed: manifest content scripts don't load config.js");
  process.exit(1);
}

console.log(`✓ Production build ready in dist/ (v${manifest.version}). Test mode: off.`);
console.log("  Zip the contents of dist/ to upload to the Chrome Web Store.");
