// Dev probe: inspect the SuperGrok billing payload shape without printing values.
// Usage: node scripts/probe-grok-billing.mjs [--settings]
// Reads XAI_ACCESS_TOKEN or pi's stored xai OAuth login through pi's credential API.
// Not shipped: this file is excluded via package.json "files".

import { pathToFileURL } from "node:url";
import { describeShape } from "./probe-glm-quota.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--settings")) throw new Error();
    let token = process.env.XAI_ACCESS_TOKEN?.trim();
    if (!token) {
      // Reuse the runner's validated npm global-root import, inside this error boundary.
      const { loadPiSdk } = await import("./usage-json.mjs");
      const { readStoredCredential } = await loadPiSdk();
      const credential = await readStoredCredential("xai");
      token = credential?.type === "oauth" && typeof credential.access === "string" ? credential.access.trim() : "";
    }
    if (!token) {
      console.error("no xai OAuth login available; use /login xai in pi or XAI_ACCESS_TOKEN");
      process.exitCode = 1;
    } else {
      const urls = ["https://cli-chat-proxy.grok.com/v1/billing?format=credits"];
      if (process.argv.includes("--settings")) urls.push("https://cli-chat-proxy.grok.com/v1/settings");
      for (const url of urls) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
        console.log(`\n=== ${url} → HTTP ${res.status} ===`);
        const headers = Object.fromEntries([...res.headers.entries()].filter(([name]) => /rate|limit|reset|credit|usage/i.test(name)));
        if (Object.keys(headers).length) console.log("headers:", JSON.stringify(describeShape(headers, [token])));
        console.log(JSON.stringify(describeShape(JSON.parse(await res.text()), [token]), null, 2));
      }
    }
  } catch {
    console.error("billing probe failed (check arguments, credentials and provider response)");
    process.exitCode = 1;
  }
}
