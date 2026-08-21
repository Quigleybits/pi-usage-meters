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

// Connect-RPC probe: the grok.com web app reads usage-reset tokens via
// prod_mc_billing.ConsumerUiSvc/GetRemainingResets (see repo notes). Try it with
// the pi OAuth Bearer on both hosts to see if the method is reachable for the plugin.
if (process.argv.includes("--resets")) {
  for (const base of [
    "https://grok.com/api",
    "https://grok.com",
    "https://cli-chat-proxy.grok.com",
  ]) {
    for (const method of ["GetRemainingResets", "GetGrokUsageInfo", "NoSuchMethodXyz"]) {
      const url = `${base}/prod_mc_billing.ConsumerUiSvc/${method}`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: "{}",
        });
        const text = await res.text();
        console.log(`\n=== POST ${url} → HTTP ${res.status} (${text.length}B) ===`);
        try {
          console.log(JSON.stringify(sanitize(JSON.parse(text)), null, 2).slice(0, 2000));
        } catch {
          console.log(text.slice(0, 300));
        }
      } catch (error) {
        console.log(`\n=== POST ${url} → ${error?.cause?.code ?? error?.message} ===`);
      }
    }
  }
  // Distinguish a real handler from an edge stub: compare no-auth vs Bearer vs Connect header.
  const resetUrl = "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets";
  for (const [label, headers] of [
    ["no-auth", { "Content-Type": "application/json" }],
    ["bearer", { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }],
    ["bearer+connect-v1", { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" }],
  ]) {
    try {
      const res = await fetch(resetUrl, { method: "POST", headers, body: "{}" });
      const text = await res.text();
      const www = res.headers.get("www-authenticate") ?? "";
      console.log(`\n=== ${label} → HTTP ${res.status} (${text.length}B) ${www} ===`);
      if (text) console.log(text.slice(0, 300));
    } catch (error) {
      console.log(`\n=== ${label} → ${error?.cause?.code ?? error?.message} ===`);
    }
  }
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
