import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Always a test-owned state file, even when PI_USAGE_METERS_STATE is inherited; restore it afterwards.
const inheritedStatePath = process.env.PI_USAGE_METERS_STATE;
const testStateDir = mkdtempSync(join(tmpdir(), "usage-json-"));
process.env.PI_USAGE_METERS_STATE = join(testStateDir, "state.json");
after(() => {
  if (inheritedStatePath === undefined) delete process.env.PI_USAGE_METERS_STATE;
  else process.env.PI_USAGE_METERS_STATE = inheritedStatePath;
  rmSync(testStateDir, { recursive: true, force: true });
});
const NOW = Date.parse("2026-11-02T10:00:00Z");
const iso = (hours) => new Date(NOW + hours * 3600000).toISOString();
const secret = "synthetic-credential-must-never-appear";

async function collect({ auth, usage = {}, codex = {}, grok = {}, status = {}, deadlineMs } = {}) {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  Date.now = () => NOW;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const bodies = {
      "/api/oauth/usage": { seven_day: { utilization: 41, resets_at: iso(122) }, ...usage },
      "/api/oauth/profile": {},
      "/backend-api/wham/usage": {
        rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: 79, reset_at: (NOW / 1000) + 230400 } },
        rate_limit_reset_credits: { available_count: 2 },
        ...codex,
      },
      "/backend-api/wham/rate-limit-reset-credits": {
        credits: [{ expires_at: "2026-11-06T10:00:00Z" }, { expires_at: "2026-11-30T10:00:00Z" }],
      },
      "/v1/billing": { config: { creditUsagePercent: 16, currentPeriod: { start: iso(-111), end: iso(57), type: "USAGE_PERIOD_TYPE_WEEKLY" }, ...grok } },
      "/v1/settings": {},
    };
    assert.ok(Object.hasOwn(bodies, path), `unexpected request: ${path}`);
    return new Response(JSON.stringify(bodies[path]), { status: status[path] ?? 200 });
  };
  try {
    const { usageJson } = await import("../scripts/usage-json.mjs");
    const modelRegistry = { getProviderAuth: auth ?? (async () => ({ source: "OAuth", auth: { apiKey: secret } })) };
    return await usageJson(modelRegistry, deadlineMs === undefined ? undefined : { deadlineMs });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
}

test("JSON carries only the three weekly meters and Codex banked resets", async () => {
  const data = await collect();
  assert.deepEqual(data, {
    fetchedAt: "2026-11-02T10:00:00.000Z",
    providers: [
      { name: "Claude", left: 59, reset: "5d 2h", reset_s: 439200, banked: null },
      { name: "Codex", left: 21, reset: "2d 16h", reset_s: 230400, banked: "2 banked resets, use by 6 Nov, 30 Nov" },
      { name: "Grok", left: 84, reset: "2d 9h", reset_s: 205200, banked: null },
    ],
  });
  assert.ok(!JSON.stringify(data).includes(secret));
});

test("a failed login is safe and does not hide the other providers", async () => {
  const data = await collect({ auth: async (provider) => {
    if (provider === "anthropic") throw new Error(`refresh expired ${secret}`);
    return { source: "OAuth", auth: { apiKey: secret } };
  } });
  assert.deepEqual(data.providers[0], { name: "Claude", error: "login expired" });
  assert.equal(data.providers[1].left, 21);
  assert.equal(data.providers[2].left, 84);
  assert.ok(!JSON.stringify(data).includes(secret));
});

test("provider failures and missing weekly meters are explicit", async () => {
  const data = await collect({ usage: { seven_day: null }, status: { "/v1/billing": 503 } });
  assert.deepEqual(data.providers[0], { name: "Claude", error: "weekly usage not shown" });
  assert.deepEqual(data.providers[2], { name: "Grok", error: "provider error" });
});

test("missing logins still produce a complete serializable JSON document", async () => {
  const data = await collect({ auth: async () => undefined });
  assert.deepEqual(JSON.parse(JSON.stringify(data)).providers, [
    { name: "Claude", error: "not connected" },
    { name: "Codex", error: "not connected" },
    { name: "Grok", error: "not connected" },
  ]);
});

for (const [offset, reset] of [[5000, "<1m"], [0, "soon"]]) {
  test(`a weekly reset ${reset} keeps its real percentage`, async () => {
    const data = await collect({ usage: { seven_day: { utilization: 41, resets_at: new Date(NOW + offset).toISOString() } } });
    assert.deepEqual(data.providers[0], { name: "Claude", left: 59, reset, reset_s: 0, banked: null });
  });
}

test("banked resets remain visible when the optional expiry lookup fails", async () => {
  const data = await collect({ status: { "/backend-api/wham/rate-limit-reset-credits": 503 } });
  assert.equal(data.providers[1].banked, "2 banked resets");
});

test("a missing weekly percentage is an error, never a full or empty meter", async () => {
  const data = await collect({
    usage: { seven_day: { utilization: null, resets_at: iso(122) } },
    codex: { rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: null, reset_at: (NOW / 1000) + 230400 } } },
    grok: { creditUsagePercent: null },
  });
  assert.deepEqual(data.providers, [
    { name: "Claude", error: "weekly usage not shown" },
    { name: "Codex", error: "weekly usage not shown" },
    { name: "Grok", error: "weekly usage not shown" },
  ]);
});

test("a stalled login lookup times out without holding the other providers", { timeout: 3000 }, async () => {
  const data = await collect({
    deadlineMs: 50,
    auth: async (provider) => provider === "anthropic" ? new Promise(() => {}) : { source: "OAuth", auth: { apiKey: secret } },
  });
  assert.deepEqual(data.providers[0], { name: "Claude", error: "timed out" });
  assert.equal(data.providers[1].left, 21);
  assert.equal(data.providers[2].left, 84);
});

test("login refresh failures that are not an expiry use the same plain words as /usage", async () => {
  const networkCause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const failures = {
    anthropic: new Error("OAuth refresh failed for anthropic: fetch failed", { cause: networkCause }),
    "openai-codex": new Error("OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (429): Too Many Requests"),
    xai: new Error("OAuth refresh failed for xai: xAI OAuth token refresh failed (HTTP 503)"),
  };
  const data = await collect({ auth: async (provider) => { throw failures[provider]; } });
  assert.deepEqual(data.providers, [
    { name: "Claude", error: "network error" },
    { name: "Codex", error: "rate limited" },
    { name: "Grok", error: "provider error" },
  ]);
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const again = await collect({ auth: async () => { throw new Error("OAuth refresh failed for anthropic: aborted", { cause: timeout }); } });
  assert.deepEqual(again.providers[0], { name: "Claude", error: "timed out" });
  assert.ok(!JSON.stringify([data, again]).includes(secret));
});

// pi loading. Offline: a stub pi package whose registry holds no logins, so no provider is called.
const REPO = new URL("..", import.meta.url);
const PI_STUB = [
  "export class ModelRuntime { static async create() { return {}; } }",
  "export class ModelRegistry { async getProviderAuth() { return undefined; } }",
].join("\n");

// A stub pi package at <root>/@earendil-works/pi-coding-agent. `extra` runs when it is imported.
function writePi(root, extra = "") {
  const dir = join(root, "@earendil-works", "pi-coding-agent");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: "./dist/index.js" }));
  writeFileSync(join(dir, "dist", "index.js"), `${extra}\n${PI_STUB}\n`);
  return dir;
}

// A copy of the runner (and core.js) in a temp tree, plus an npm prefix whose global root holds a stub pi.
function runnerSandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "usage-json-load-")));
  const app = join(base, "app");
  mkdirSync(join(app, "scripts"), { recursive: true });
  mkdirSync(join(app, "extensions"), { recursive: true });
  copyFileSync(new URL("scripts/usage-json.mjs", REPO), join(app, "scripts", "usage-json.mjs"));
  copyFileSync(new URL("extensions/core.js", REPO), join(app, "extensions", "core.js"));
  const prefix = join(base, "prefix");
  writePi(process.platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules"));
  const caller = join(base, "caller");
  mkdirSync(caller);
  return { base, runner: join(app, "scripts", "usage-json.mjs"), prefix, caller };
}

// Runs the runner as `cos usage` would, from `cwd`, with Windows' default search of the current folder.
function runRunner({ runner, prefix }, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "nodefaultcurrentdirectoryinexepath"));
  env.npm_config_prefix = prefix;
  return spawnSync(process.execPath, [runner], { cwd, env, encoding: "utf8", timeout: 30_000 });
}

const NOT_CONNECTED = ["Claude", "Codex", "Grok"].map((name) => ({ name, error: "not connected" }));

test("a pi package planted in a parent node_modules folder is never imported", { timeout: 40_000 }, () => {
  const sandbox = runnerSandbox();
  try {
    const marker = join(sandbox.base, "planted-pi-imported");
    writePi(join(sandbox.base, "node_modules"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`);
    const result = runRunner(sandbox, sandbox.caller);
    assert.equal(existsSync(marker), false, "the runner imported the planted package");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).providers, NOT_CONNECTED);
  } finally {
    rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test("an npm.cmd planted in the caller's folder never runs", { skip: process.platform !== "win32" && "cmd.exe current-folder search is Windows only", timeout: 40_000 }, () => {
  const sandbox = runnerSandbox();
  try {
    const marker = join(sandbox.caller, "planted-npm-ran");
    writeFileSync(join(sandbox.caller, "npm.cmd"), `@echo off\r\necho x> "${marker}"\r\necho %~dp0\r\n`);
    const result = runRunner(sandbox, sandbox.caller);
    assert.equal(existsSync(marker), false, "the runner ran the planted npm.cmd");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).providers, NOT_CONNECTED);
  } finally {
    rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test("a pi entry that resolves outside the npm global root is refused, not imported", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "usage-json-root-")));
  try {
    const marker = join(base, "outside-pi-imported");
    const outside = writePi(join(base, "outside"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`);
    const root = join(base, "root");
    mkdirSync(join(root, "@earendil-works"), { recursive: true });
    symlinkSync(outside, join(root, "@earendil-works", "pi-coding-agent"), "junction");
    const { loadPiSdk } = await import("../scripts/usage-json.mjs");
    await assert.rejects(loadPiSdk({ globalRoot: () => root }));
    assert.equal(existsSync(marker), false, "the outside entry was imported");
    const inside = join(base, "inside");
    writePi(inside);
    const sdk = await loadPiSdk({ globalRoot: () => inside });
    assert.equal(typeof sdk.ModelRegistry, "function");
    assert.equal((await import(pathToFileURL(join(inside, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href)), sdk);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
