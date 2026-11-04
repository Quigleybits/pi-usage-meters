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

async function withUsageFixtures({ auth, usage = {}, codex = {}, grok = {}, expiry, expiryDelayMs = 0, status = {} } = {}, run) {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = NOW;
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/backend-api/wham/rate-limit-reset-credits") now += expiryDelayMs;
    const bodies = {
      "/api/oauth/usage": { seven_day: { utilization: 41, resets_at: iso(122) }, ...usage },
      "/api/oauth/profile": {},
      "/backend-api/wham/usage": {
        rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: 79, reset_at: (NOW / 1000) + 230400 } },
        rate_limit_reset_credits: { available_count: 2 },
        ...codex,
      },
      "/backend-api/wham/rate-limit-reset-credits": expiry ?? {
        credits: [{ expires_at: "2026-11-06T10:00:00Z" }, { expires_at: "2026-11-30T10:00:00Z" }],
      },
      "/v1/billing": { config: { creditUsagePercent: 16, currentPeriod: { start: iso(-111), end: iso(57), type: "USAGE_PERIOD_TYPE_WEEKLY" }, ...grok } },
      "/v1/settings": {},
    };
    assert.ok(Object.hasOwn(bodies, path), `unexpected request: ${path}`);
    return new Response(JSON.stringify(bodies[path]), { status: status[path] ?? 200 });
  };
  try {
    const modelRegistry = { getProviderAuth: auth ?? (async () => ({ source: "OAuth", auth: { apiKey: secret } })) };
    return await run(modelRegistry);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
}

async function collect(options = {}) {
  return withUsageFixtures(options, async (registry) => {
    const { usageJson } = await import("../scripts/usage-json.mjs");
    return usageJson(registry, options.deadlineMs === undefined ? undefined : { deadlineMs: options.deadlineMs });
  });
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
  assert.equal(JSON.stringify(data), '{"providers":[{"name":"Claude","left":59,"reset":"5d 2h","reset_s":439200,"banked":null},{"name":"Codex","left":21,"reset":"2d 16h","reset_s":230400,"banked":"2 banked resets, use by 6 Nov, 30 Nov"},{"name":"Grok","left":84,"reset":"2d 9h","reset_s":205200,"banked":null}],"fetchedAt":"2026-11-02T10:00:00.000Z"}');
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
  assert.equal(JSON.stringify(data), '{"providers":[{"name":"Claude","error":"weekly usage not shown"},{"name":"Codex","left":21,"reset":"2d 16h","reset_s":230400,"banked":"2 banked resets, use by 6 Nov, 30 Nov"},{"name":"Grok","error":"provider error"}],"fetchedAt":"2026-11-02T10:00:00.000Z"}');
});

test("missing logins still produce a complete serializable JSON document", async () => {
  const data = await collect({ auth: async () => undefined });
  assert.deepEqual(JSON.parse(JSON.stringify(data)).providers, [
    { name: "Claude", error: "not connected" },
    { name: "Codex", error: "not connected" },
    { name: "Grok", error: "not connected" },
  ]);
  assert.equal(JSON.stringify(data), '{"providers":[{"name":"Claude","error":"not connected"},{"name":"Codex","error":"not connected"},{"name":"Grok","error":"not connected"}],"fetchedAt":"2026-11-02T10:00:00.000Z"}');
});

test("weekly JSON ignores display labels, percentages, pies and banked decoration", async () => {
  await withUsageFixtures({}, async (modelRegistry) => {
    const { fetchAnthropic, fetchCodex, fetchXai } = await import("../extensions/core.js");
    const { weeklyUsage } = await import("../scripts/usage-json.mjs");
    for (const [name, fetcher, expected] of [
      ["Claude", fetchAnthropic, '{"name":"Claude","left":59,"reset":"5d 2h","reset_s":439200,"banked":null}'],
      ["Codex", fetchCodex, '{"name":"Codex","left":21,"reset":"2d 16h","reset_s":230400,"banked":"2 banked resets, use by 6 Nov, 30 Nov"}'],
      ["Grok", fetchXai, '{"name":"Grok","left":84,"reset":"2d 9h","reset_s":205200,"banked":null}'],
    ]) {
      const lines = await fetcher({ modelRegistry });
      assert.ok(lines.every((line) => typeof line === "string"));
      assert.deepEqual(lines, [...lines], "metadata must stay non-enumerable");
      assert.equal(JSON.stringify(lines), JSON.stringify([...lines]));
      assert.equal(typeof weeklyUsage, "function", "weekly conversion must consume structured provider lines");
      assert.equal(JSON.stringify(weeklyUsage(name, lines)), expected);
      for (let i = 0; i < lines.length; i++) lines[i] = `Changed display ${i}: 99% reset ◇ 1m ★★`;
      assert.equal(JSON.stringify(weeklyUsage(name, lines)), expected);
    }
  });
});

test("a scoped Claude week cannot stand in for the aggregate week", async () => {
  const data = await collect({ usage: { seven_day: null, limits: [
    { group: "weekly", scope: { model: { display_name: "all models" } }, percent: 7, resets_at: iso(72) },
  ] } });
  assert.deepEqual(data.providers[0], { name: "Claude", error: "weekly usage not shown" });
});

test("weekly percentages round the used share before subtracting from 100", async () => {
  for (const [used, left] of [[0.5, 99], [41.5, 58], [99.5, 0], [-2, 100], [101, 0], ["41.5", 58]]) {
    const data = await collect({
      usage: { seven_day: { utilization: used, resets_at: iso(122) } },
      codex: { rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: used, reset_at: NOW / 1000 + 230400 } } },
      grok: { creditUsagePercent: used },
    });
    assert.deepEqual(data.providers.map((row) => row.left), [left, left, left], String(used));
  }
});

test("weekly reset seconds use the same rounded units as the display", async () => {
  for (const [offset, reset, reset_s] of [
    [-1, "soon", 0], [0, "soon", 0], [1, "<1m", 0], [29999, "<1m", 0],
    [30000, "1m", 60], [89999, "1m", 60], [90000, "2m", 120],
    [3569999, "59m", 3540], [3570000, "1h", 3600],
    [86370000, "1d", 86400], [88140000, "1d", 86400], [91740000, "1d 1h", 90000],
  ]) {
    const data = await collect({ usage: { seven_day: { utilization: 41, resets_at: new Date(NOW + offset).toISOString() } } });
    assert.deepEqual(data.providers[0], { name: "Claude", left: 59, reset, reset_s, banked: null }, String(offset));
  }
});

test("Codex captures reset rounding before a delayed optional expiry lookup", async () => {
  await withUsageFixtures({
    codex: { rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: 79, reset_at: NOW / 1000 + 30.5 } } },
    expiryDelayMs: 1000,
  }, async (modelRegistry) => {
    const { fetchCodex } = await import("../extensions/core.js");
    const { weeklyUsage } = await import("../scripts/usage-json.mjs");
    const lines = await fetchCodex({ modelRegistry });
    assert.match(lines[1], /reset \S 1m$/);
    assert.equal(Date.now(), NOW + 1000);
    assert.equal(typeof weeklyUsage, "function", "weekly conversion must retain the row's reset snapshot");
    assert.deepEqual(weeklyUsage("Codex", lines), {
      name: "Codex", left: 21, reset: "1m", reset_s: 60, banked: "2 banked resets, use by 6 Nov, 30 Nov",
    });
  });
});

test("Codex selects the first rounded-minute weekly window without falling through missing data", async () => {
  const first = { limit_window_seconds: 604770, used_percent: 12, reset_at: NOW / 1000 + 3600 };
  const second = { limit_window_seconds: 604800, used_percent: 79, reset_at: NOW / 1000 + 230400 };
  for (const [primary, expected] of [
    [first, { name: "Codex", left: 88, reset: "1h", reset_s: 3600, banked: null }],
    [{ ...first, limit_window_seconds: 604829 }, { name: "Codex", left: 88, reset: "1h", reset_s: 3600, banked: null }],
    [{ ...first, limit_window_seconds: 604830 }, { name: "Codex", left: 21, reset: "2d 16h", reset_s: 230400, banked: null }],
    [{ ...first, used_percent: null }, { name: "Codex", error: "weekly usage not shown" }],
    [{ ...first, reset_at: undefined }, { name: "Codex", error: "weekly usage not shown" }],
    [{ ...first, reset_at: null }, { name: "Codex", left: 88, reset: "soon", reset_s: 0, banked: null }],
  ]) {
    const data = await collect({ codex: { rate_limit: { primary_window: primary, secondary_window: second }, rate_limit_reset_credits: null } });
    assert.deepEqual(data.providers[1], expected);
  }
});

test("Grok's weekly branch stays weekly when the reported period is shorter than seven days", async () => {
  const data = await collect({ grok: { currentPeriod: { start: iso(-15), end: iso(57), type: "USAGE_PERIOD_TYPE_WEEKLY" } } });
  assert.deepEqual(data.providers[2], { name: "Grok", left: 84, reset: "2d 9h", reset_s: 205200, banked: null });
});

test("missing and nonfinite weekly percentages or resets stay unavailable", async () => {
  for (const value of [undefined, null, "", "n/a", "Infinity", "1e309"]) {
    const data = await collect({
      usage: { seven_day: { utilization: value, resets_at: iso(122) } },
      codex: { rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: value, reset_at: NOW / 1000 + 230400 } } },
      grok: { creditUsagePercent: value },
    });
    assert.deepEqual(data.providers.map((row) => row.error), Array(3).fill("weekly usage not shown"), String(value));
  }
  for (const value of [undefined, "n/a", "Infinity"]) {
    const data = await collect({
      usage: { seven_day: { utilization: 41, resets_at: value } },
      codex: { rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: 79, reset_at: value } } },
      grok: { currentPeriod: { start: iso(-111), end: value, type: "USAGE_PERIOD_TYPE_WEEKLY" } },
    });
    assert.deepEqual(data.providers.map((row) => row.error), Array(3).fill("weekly usage not shown"), String(value));
  }
});

test("banked resets preserve overflow, malformed and scientific-notation count behavior", async () => {
  for (const [count, expected] of [
    [25, "25 banked resets"], ["2e1", "20 banked resets"], ["2.9", "2 banked resets"],
    ["1e20", "100000000000000000000 banked resets"], ["1e21", null], ["Infinity", null],
    ["n/a", null], [null, null], [-1, null],
  ]) {
    const data = await collect({ codex: { rate_limit_reset_credits: { available_count: count } }, expiry: { credits: [] } });
    assert.equal(data.providers[1].banked, expected, String(count));
  }
});

test("banked expiries filter available entries, preserve order and duplicates, and slice before invalid dates", async () => {
  const data = await collect({ codex: { rate_limit_reset_credits: { available_count: 4 } }, expiry: { credits: [
    { status: "used", expires_at: "2026-11-01T10:00:00Z" },
    { status: "available", expires_at: "invalid" },
    { expires_at: "2026-11-30T10:00:00Z" },
    { status: "available", expiresAt: "2026-11-06T10:00:00Z" },
    { status: "available", expires_at: 1793959200 },
    { status: "available", expires_at: "2026-11-07T10:00:00Z" },
  ] } });
  assert.equal(data.providers[1].banked, "4 banked resets, use by 30 Nov, 6 Nov, 6 Nov");
});

test("banked expiry dates use the local calendar", async () => {
  const inheritedTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const data = await collect({ expiry: { credits: [{ expires_at: "2026-11-06T00:00:00Z" }] } });
    assert.equal(data.providers[1].banked, "2 banked resets, use by 5 Nov");
  } finally {
    if (inheritedTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = inheritedTimezone;
  }
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
