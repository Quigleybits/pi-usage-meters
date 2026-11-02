// Headless weekly meters. pi alone reads, refreshes and stores OAuth credentials.
import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchAnthropic, fetchCodex, fetchXai, LoginFailed, NotConnected, PROVIDER_DEADLINE_MS, withDeadline } from "../extensions/core.js";

const PROVIDERS = [["Claude", fetchAnthropic, "Week (all models)"], ["Codex", fetchCodex, "Week"], ["Grok", fetchXai, "Week (credits)"]];
// A login lookup that failed for a reason other than an expiry gets the same plain words as /usage.
const LOGIN_WORDS = { network: "network error", provider: "provider error", "rate-limited": "rate limited", timeout: "timed out" };
const safeError = (error) => error instanceof NotConnected ? "not connected"
  : error instanceof LoginFailed ? (error.expired ? "login expired" : LOGIN_WORDS[error.kind] ?? "login check failed")
  : ({ 401: "login expired", 402: "no credits left", 403: "access denied", 429: "rate limited" })[error?.status]
    ?? (error?.status >= 500 ? "provider error" : /^timed out after \d+ms$/.test(error?.message) ? "timed out" : "usage unavailable");

// deadlineMs: the same per-provider deadline as /usage, login lookup included; tests shorten it.
export async function usageJson(modelRegistry, { deadlineMs = PROVIDER_DEADLINE_MS } = {}) {
  const providers = await Promise.all(PROVIDERS.map(async ([name, fetcher, label]) => {
    try {
      const lines = (await withDeadline(fetcher({ modelRegistry }), deadlineMs)).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
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

// The npm global root, looked up from this script's own folder: cmd.exe searches the current folder
// before PATH, so an npm.cmd planted in the caller's folder must never be in reach.
const npmGlobalRoot = () => execSync("npm root -g", {
  cwd: dirname(fileURLToPath(import.meta.url)),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

// pi's SDK, imported only by absolute file URL from the npm global root. A bare import would also
// search node_modules in every parent folder up to the drive root, where any local user can create one.
export async function loadPiSdk({ globalRoot = npmGlobalRoot } = {}) {
  const root = realpathSync(globalRoot());
  const entry = realpathSync(join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js"));
  const inside = relative(root, entry);
  if (!inside || isAbsolute(inside) || inside.split(/[\\/]/)[0] === "..") throw new Error("pi is not under the npm global root");
  return import(pathToFileURL(entry).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Exit as soon as the output is written: a provider call that outlived its deadline must not
  // keep the runner (and so `cos usage`) alive.
  const finish = (stream, text) => stream.write(text, () => process.exit());
  try {
    const sdk = await loadPiSdk();
    const registry = new sdk.ModelRegistry(await sdk.ModelRuntime.create({ allowModelNetwork: false }));
    finish(process.stdout, JSON.stringify(await usageJson(registry)) + "\n");
  } catch {
    process.exitCode = 1;
    finish(process.stderr, "usage runner setup failed (pi unavailable or login storage unreadable)\n");
  }
}
