// Dev probe: dump the raw GLM/Z.ai quota payload shape (key never printed).
// Usage: node scripts/probe-glm-quota.mjs
// Reads ZAI_API_KEY from <home>/git_projects/coop-light/.env in-process,
// calls the undocumented monitor endpoint, prints sanitized JSON.
// Not shipped: excluded via package.json "files".

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ENV_FILE = join(homedir(), "git_projects", "coop-light", ".env");

function readDotenvValue(text, variable) {
  const matches = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [name, ...rest] = line.split("=");
    if (name.trim() !== variable) continue;
    let value = rest.join("=").trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    if (value) matches.push(value);
  }
  if (matches.length !== 1) throw new Error(`expected exactly one ${variable} entry in ${ENV_FILE}`);
  return matches[0];
}

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

const key = readDotenvValue(await readFile(ENV_FILE, "utf8"), "ZAI_API_KEY");
const url = "https://api.z.ai/api/monitor/usage/quota/limit";
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${key}`, "Accept-Language": "en-US,en" },
});
console.log(`HTTP ${res.status}`);
const body = await res.text();
try {
  console.log(JSON.stringify(sanitize(JSON.parse(body)), null, 2));
} catch {
  console.log(`non-JSON response (${body.length}B):`);
  console.log(body.slice(0, 500));
}
