// Dev probe: dump the raw GLM/Z.ai quota payload shape (key never printed).
// Usage: node scripts/probe-glm-quota.mjs
// Reads ZAI_API_KEY or ZAI_CODING_CN_API_KEY from the environment only,
// calls the matching undocumented monitor endpoint, and prints sanitized JSON.
// Not shipped: excluded via package.json "files".

function sanitize(value, depth = 0) {
  if (depth > 8) return "…";
  if (typeof value === "string") {
    // Keep ISO timestamps; redact anything else longer than an id.
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
    return value.length > 40 ? `<redacted ${value.length} chars>` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, depth + 1)]));
  }
  return String(value);
}

const providers = [
  {
    variable: "ZAI_API_KEY",
    url: "https://api.z.ai/api/monitor/usage/quota/limit",
    authorization: (key) => `Bearer ${key}`,
  },
  {
    variable: "ZAI_CODING_CN_API_KEY",
    url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    authorization: (key) => key,
  },
];
let selected;
for (const provider of providers) {
  const key = process.env[provider.variable]?.trim();
  if (key) {
    selected = { ...provider, key };
    break;
  }
}
if (!selected) throw new Error("ZAI_API_KEY or ZAI_CODING_CN_API_KEY is required");

const { key, url } = selected;
const res = await fetch(url, {
  headers: { Authorization: selected.authorization(key), "Accept-Language": "en-US,en" },
});
console.log(`HTTP ${res.status}`);
const body = await res.text();
try {
  console.log(JSON.stringify(sanitize(JSON.parse(body)), null, 2));
} catch {
  console.log(`non-JSON response (${body.length}B):`);
  console.log(body.slice(0, 500));
}
