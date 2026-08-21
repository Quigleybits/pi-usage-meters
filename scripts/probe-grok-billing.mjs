// Dev probe: dump the Grok SuperGrok billing payload shape (token never printed).
// Usage: node scripts/probe-grok-billing.mjs [--settings]
// Reads the xai OAuth token from pi's auth store, calls the undocumented
// cli-chat-proxy endpoints, and prints the JSON with long strings redacted.
// Not shipped: this file is excluded via package.json "files".

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

function findToken(value, keyHint = "") {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      typeof child === "string" && child.length > 20
      && /^(access|access[_-]?token|api[_-]?key|id[_-]?token|token|bearer)$/i.test(lower)
      && !/refresh|expires|secret/.test(lower)
    ) return child;
    const nested = findToken(child, lower);
    if (nested) return nested;
  }
  return undefined;
}

function sanitize(value, depth = 0) {
  if (depth > 8) return "…";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value; // keep ISO dates
    return value.length > 40 ? `<redacted ${value.length} chars>` : value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.length > 4
      ? [...value.slice(0, 4).map((v) => sanitize(v, depth + 1)), `<…${value.length - 4} more>`]
      : value.map((v) => sanitize(v, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, sanitize(v, depth + 1)]),
  );
}

const auth = JSON.parse(await readFile(AUTH_PATH, "utf8"));
const xai = auth.xai;
if (!xai) {
  console.error("no xai entry in auth store — run /login xai in pi first");
  process.exit(1);
}
const token = findToken(xai);
if (!token) {
  console.error("no access-token-looking string under auth.xai; keys:", Object.keys(xai));
  process.exit(1);
}

const urls = ["https://cli-chat-proxy.grok.com/v1/billing?format=credits"];
if (process.argv.includes("--settings")) urls.push("https://cli-chat-proxy.grok.com/v1/settings");
if (process.argv.includes("--explore")) {
  urls.push(
    "https://cli-chat-proxy.grok.com/v1/settings",
    "https://cli-chat-proxy.grok.com/v1/usage",
    "https://cli-chat-proxy.grok.com/v1/billing/resets",
    "https://cli-chat-proxy.grok.com/v1/resets",
    "https://cli-chat-proxy.grok.com/v1/reset-credits",
    "https://cli-chat-proxy.grok.com/v1/rate-limits",
    "https://cli-chat-proxy.grok.com/v1/billing?format=usage",
  );
}

for (const url of urls) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  console.log(`\n=== ${url} → HTTP ${res.status} ===`);
  const interesting = [...res.headers.entries()].filter(([k]) => /rate|limit|reset|credit|usage/i.test(k));
  if (interesting.length) console.log("headers:", JSON.stringify(Object.fromEntries(interesting)));
  const text = await res.text();
  try {
    console.log(JSON.stringify(sanitize(JSON.parse(text)), null, 2).slice(0, 4000));
  } catch {
    console.log(text.slice(0, 500));
  }
}
