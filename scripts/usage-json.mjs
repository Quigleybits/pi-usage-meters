// Headless weekly meters. pi alone reads, refreshes and stores OAuth credentials.
import { execSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchAnthropic, fetchCodex, fetchXai, LoginFailed, NotConnected } from "../extensions/core.js";

const PROVIDERS = [["Claude", fetchAnthropic, "Week (all models)"], ["Codex", fetchCodex, "Week"], ["Grok", fetchXai, "Week (credits)"]];
const safeError = (error) => error instanceof NotConnected ? "not connected"
  : error instanceof LoginFailed ? (error.expired ? "login expired" : "login check failed")
  : ({ 401: "login expired", 402: "no credits left", 403: "access denied", 429: "rate limited" })[error?.status]
    ?? (error?.status >= 500 ? "provider error" : /^timed out after \d+ms$/.test(error?.message) ? "timed out" : "usage unavailable");

export async function usageJson(modelRegistry) {
  const providers = await Promise.all(PROVIDERS.map(async ([name, fetcher, label]) => {
    try {
      const lines = (await fetcher({ modelRegistry })).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
      const row = lines.find(line => line.trimStart().startsWith(label + " "));
      const meter = row?.match(/(\d+)%\s+reset\s+\S\s+(\d+d(?:\s+\d+h)?|\d+h(?:\s+\d+m)?|\d+m|<1m|soon)\s*$/);
      if (!meter) return { name, error: "weekly usage not shown" };
      const reset_s = /^(<1m|soon)$/.test(meter[2]) ? 0 : [...meter[2].matchAll(/(\d+)([dhm])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * ({ d: 86400, h: 3600, m: 60 })[unit], 0);
      const banked = name === "Codex" && lines.find(line => line.trimStart().startsWith("Banked resets "))?.match(/(●+)(?:\+(\d+))?(?: use by: (.+))?$/);
      return { name, left: 100 - Number(meter[1]), reset: meter[2], reset_s,
        banked: banked ? `${banked[1].length + Number(banked[2] || 0)} banked resets${banked[3] ? `, use by ${banked[3]}` : ""}` : null };
    } catch (error) {
      return { name, error: safeError(error) };
    }
  }));
  return { providers, fetchedAt: new Date(Date.now()).toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let sdk;
    try { sdk = await import("@earendil-works/pi-coding-agent"); }
    catch {
      const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      sdk = await import(pathToFileURL(join(root, "@earendil-works/pi-coding-agent/dist/index.js")).href);
    }
    const registry = new sdk.ModelRegistry(await sdk.ModelRuntime.create({ allowModelNetwork: false }));
    process.stdout.write(JSON.stringify(await usageJson(registry)) + "\n");
  } catch {
    process.stderr.write("usage runner setup failed (pi unavailable or login storage unreadable)\n");
    process.exitCode = 1;
  }
}
