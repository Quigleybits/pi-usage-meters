import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bar,
  clean,
  clampPct,
  codexAccountId,
  createUsageLoader,
  fetchAnthropic,
  fetchCodex,
  fetchGlm,
  fetchKimi,
  fetchXai,
  getJson,
  line,
  pie,
  renderContent,
  STAMP,
  tokenFor,
} from "../extensions/core.js";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// All stateful Grok-detection tests must hit a throwaway state file, never the user's.
process.env.PI_USAGE_METERS_STATE ||= join(mkdtempSync(join(tmpdir(), "pum-tests-")), "state.json");

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return Promise.resolve(run()).finally(() => { globalThis.fetch = original; });
}

const authContext = (entries = {}) => ({
  modelRegistry: { getProviderAuth: async (provider) => entries[provider] },
});
const oauth = (token = "oauth-token") => ({ source: "OAuth", auth: { apiKey: token } });

function jwt(accountId = "account-123") {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

test("clean strips terminal and bidi controls and truncates", () => {
  assert.equal(clean(" safe\x1b[31m\u202eBAD ", 7), "safe[31");
});

test("bars, percentages, and pies stay within bounds", () => {
  assert.equal(clampPct(500), 100);
  assert.equal(clampPct(-1), 0);
  assert.equal(clampPct(NaN), 0);
  assert.equal(bar(500), "██████████");
  assert.match(line("Test", 500), /██████████\s+100%/);
  assert.equal(pie(0, Date.now()), "○");
  assert.equal(pie(3600e3, NaN), "○");
});

test("renderer sanitizes crafted persisted entries", () => {
  const rendered = renderContent({
    blocks: [{ name: "Claude", lines: ["safe\x1b[31mINJECTED"] }],
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assert.doesNotMatch(rendered, /\x1b\[31mINJECTED/);
  assert.match(rendered, /safe\[31mINJECTED/);
});

test("renderer leaves the terminal background transparent", async () => {
  const sources = await Promise.all([
    readFile(new URL("../extensions/core.js", import.meta.url), "utf8"),
    readFile(new URL("../extensions/index.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(sources.join("\n"), /ON_BLACK|\\x1b\[(?:4[0-9]|10[0-7]|48[;:])/);
});

test("only OAuth credentials are returned, including bearer-header OAuth", async () => {
  assert.equal(await tokenFor(authContext({ anthropic: oauth("ok") }), "anthropic"), "ok");
  assert.equal(await tokenFor(authContext({ "kimi-coding": { source: "OAuth", auth: { headers: { Authorization: "Bearer kimi-token" } } } }), "kimi-coding"), "kimi-token");
  assert.equal(await tokenFor(authContext({ anthropic: { source: "ANTHROPIC_API_KEY", auth: { apiKey: "secret" } } }), "anthropic"), undefined);
});

test("Codex account id is decoded without reading auth.json", async () => {
  assert.equal(codexAccountId(jwt("acct-456")), "acct-456");
  assert.equal(codexAccountId("not-a-jwt"), undefined);
  const sources = await Promise.all([
    readFile(new URL("../extensions/core.js", import.meta.url), "utf8"),
    readFile(new URL("../extensions/index.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(sources.join("\n"), /auth\.json|readFileSync/);
});

test("HTTP failures never include remote error bodies", async () => {
  const token = "oauth-sensitive-token";
  await withFetch(
    async () => json({ error: { message: `Bearer ${token}` } }, { status: 401 }),
    async () => {
      await assert.rejects(getJson("https://example.test", token), /^Error: HTTP 401$/);
    },
  );
});

test("oversized responses are rejected", async () => {
  await withFetch(
    async () => json({}, { headers: { "content-length": "2000000" } }),
    async () => assert.rejects(getJson("https://example.test", "token"), /response too large/),
  );
});

test("chunked oversized responses are cancelled at the byte cap", async () => {
  let chunksRead = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (chunksRead === 5) return controller.close();
      chunksRead += 1;
      controller.enqueue(new Uint8Array(400_000));
    },
    cancel() {
      cancelled = true;
    },
  });
  await withFetch(
    async () => new Response(stream, { headers: { "content-type": "application/json" } }),
    async () => assert.rejects(getJson("https://example.test", "token"), /response too large/),
  );
  assert.equal(cancelled, true);
  assert.ok(chunksRead < 5);
});

test("Claude money honours currency exponent", async () => {
  const ctx = authContext({ anthropic: oauth() });
  await withFetch(async (url) => {
    if (String(url).endsWith("/profile")) return json({});
    return json({
      extra_usage: { credits_ever_enabled: true, is_enabled: true, currency: "JPY", decimal_places: 0, used_credits: 123, monthly_limit: 456 },
    });
  }, async () => {
    const lines = await fetchAnthropic(ctx);
    assert.match(lines.join("\n"), /JPY 123\/456/);
  });
});

test("Codex derives window labels, omits absent plan, and keeps one expiry per reset", async () => {
  const token = jwt();
  const ctx = authContext({ "openai-codex": oauth(token) });
  await withFetch(async (url) => {
    if (String(url).endsWith("rate-limit-reset-credits")) {
      return json({ credits: [
        { status: "available", expires_at: "2026-08-11T00:00:00Z" },
        { status: "available", expires_at: "2026-08-11T00:00:00Z" },
      ] });
    }
    return json({
      rate_limit: {
        primary_window: { limit_window_seconds: 5400, used_percent: 21, reset_at: 1786500000 },
        secondary_window: { limit_window_seconds: 86400, used_percent: 7, reset_at: 1786500000 },
      },
      rate_limit_reset_credits: { available_count: 2 },
    });
  }, async () => {
    const lines = await fetchCodex(ctx);
    assert.equal(lines[0], "Codex");
    assert.match(lines.join("\n"), /Session \(90m\)/);
    assert.match(lines.join("\n"), /Session \(1d\)/);
    assert.match(lines.join("\n"), /●● use by: 11 Aug, 11 Aug/);
  });
});

test("GLM parses API-key auth and splits credit windows by reset horizon", async () => {
  const ctx = authContext({
    zai: { source: "apiKey", auth: { apiKey: "zai-key" } },
    "zai-coding-cn": { source: "apiKey", auth: { apiKey: "zai-cn-key" } },
  });
  await withFetch(async (url, init) => {
    assert.equal(String(url), "https://api.z.ai/api/monitor/usage/quota/limit");
    assert.equal(init.headers.Authorization, "Bearer zai-key");
    assert.equal(init.headers["Accept-Language"], "en-US,en");
    return json({
      code: 200,
      data: {
        level: "lite",
        limits: [
          { type: "CREDIT_LIMIT", usage: 2000, currentValue: 716, percentage: 35, nextResetTime: Date.now() + 4 * 3600e3 },
          { type: "CREDIT_LIMIT", usage: 10000, currentValue: 3440, percentage: 34, nextResetTime: Date.now() + 80 * 3600e3 },
        ],
      },
    });
  }, async () => {
    const lines = await fetchGlm(ctx);
    assert.equal(lines[0], "GLM (lite plan)");
    assert.match(lines[1], /Session \(credits\).*35%.*716\/2,000/);
    assert.match(lines[2], /Month \(credits\).*34%.*3,440\/10,000/);
  });
});

test("GLM supports China-region API-key auth and quota endpoint", async () => {
  const ctx = authContext({
    "zai-coding-cn": { source: "apiKey", auth: { apiKey: "zai-cn-key" } },
  });
  await withFetch(async (url, init) => {
    assert.equal(String(url), "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    assert.equal(init.headers.Authorization, "zai-cn-key");
    assert.equal(init.headers["Accept-Language"], "en-US,en");
    return json({
      code: 200,
      data: {
        level: "pro",
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25, nextResetTime: Date.now() + 4 * 3600e3 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: Date.now() + 20 * 86400e3 },
        ],
      },
    });
  }, async () => {
    const lines = await fetchGlm(ctx);
    assert.equal(lines[0], "GLM (pro plan)");
    assert.match(lines[1], /Session \(5h\).*25%/);
    assert.match(lines[2], /Month \(tokens\).*40%/);
  });
});

test("GLM classifies credit windows via unit/number when nextResetTime is absent", async () => {
  const ctx = authContext({ zai: { source: "apiKey", auth: { apiKey: "zai-key" } } });
  await withFetch(async () => json({
    code: 200,
    data: {
      level: "lite",
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 4343, remaining: 5656, percentage: 43, nextResetTime: Date.now() + 62 * 3600e3 },
      ],
    },
  }), async () => {
    const lines = await fetchGlm(ctx);
    assert.match(lines[1], /Session \(5h\).*0%.*0\/2,000/);
    assert.match(lines[2], /Month \(credits\).*43%.*4,343\/10,000/);
  });
});

test("GLM handles legacy limit shapes and reports a missing API key", async () => {
  const noKey = authContext({
    zai: { source: "none", auth: {} },
    "zai-coding-cn": { source: "none", auth: {} },
  });
  await assert.rejects(
    fetchGlm(noKey),
    (error) => error.name === "NotConnected" && /set ZAI_API_KEY or ZAI_CODING_CN_API_KEY/.test(error.hint),
  );

  const ctx = authContext({ zai: { source: "apiKey", auth: { apiKey: "zai-key" } } });
  await withFetch(async () => json({
    data: {
      limits: [
        { type: "TOKENS_LIMIT", percentage: 42 },
        { type: "TIME_LIMIT", percentage: 10, currentValue: 3, usage: 100, nextResetTime: Date.now() + 10 * 86400e3 },
      ],
    },
  }), async () => {
    const lines = await fetchGlm(ctx);
    assert.equal(lines[0], "GLM");
    assert.match(lines[1], /Session \(tokens\).*42%/);
    assert.match(lines[2], /MCP \(month\).*10%.*3\/100/);
  });
});

test("Kimi parses bearer-auth membership and session and weekly quotas", async () => {
  const ctx = authContext({
    "kimi-coding": { source: "OAuth", auth: { headers: { Authorization: "Bearer kimi-token" } } },
  });
  await withFetch(async (url, init) => {
    assert.equal(String(url), "https://api.kimi.com/coding/v1/usages");
    assert.equal(init.headers.Authorization, "Bearer kimi-token");
    return json({
      user: { membership: { level: "LEVEL_MAX" } },
      limits: [{
        window: { timeUnit: "TIME_UNIT_MINUTE", duration: 90 },
        detail: { used: 30, limit: 120, resetTime: "2030-08-11T12:00:00Z" },
      }],
      usage: { used: 45, limit: 300, resetTime: "2030-08-15T12:00:00Z" },
    });
  }, async () => {
    const lines = await fetchKimi(ctx);
    assert.equal(lines[0], "Kimi (max)");
    assert.match(lines.join("\n"), /Session \(90m\).*25%/);
    assert.match(lines.join("\n"), /Week.*15%/);
  });
});

test("Grok parses weekly credits, monthly fallback, and product split", async () => {
  const ctx = authContext({ xai: oauth("grok-token") });
  let mode = "weekly";
  await withFetch(async (url) => {
    const href = String(url);
    if (href.endsWith("/settings")) return json({ subscription_tier_display: "SuperGrok" });
    assert.equal(href, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    if (mode === "weekly") {
      return json({
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2030-08-05T00:00:00Z",
            end: "2030-08-12T00:00:00Z",
          },
          creditUsagePercent: 17,
          isUnifiedBillingUser: true,
          productUsage: [
            { product: "GrokBuild", usagePercent: 10 },
            { product: "GrokImagine", usagePercent: 6 },
            { product: "GrokChat", usagePercent: 1 },
          ],
          onDemandCap: { val: 100 },
          onDemandUsed: { val: 25 },
          prepaidBalance: { val: 12 },
          billingPeriodStart: "2030-08-05T00:00:00Z",
          billingPeriodEnd: "2030-08-12T00:00:00Z",
        },
      });
    }
    if (mode === "monthly") {
      return json({
        config: {
          monthlyLimit: { val: 1000 },
          used: { val: 250 },
          billingPeriodStart: "2030-08-01T00:00:00Z",
          billingPeriodEnd: "2030-09-01T00:00:00Z",
        },
      });
    }
    return json({ config: { used: { val: 42 } } });
  }, async () => {
    const weekly = await fetchXai(ctx);
    assert.equal(weekly[0], "Grok (SuperGrok)");
    assert.match(weekly.join("\n"), /Week \(credits\).*17%/);
    assert.match(weekly.join("\n"), /Build.*10%/);
    assert.match(weekly.join("\n"), /Imagine.*\s+6%/);
    assert.match(weekly.join("\n"), /Chat.*\s+1%/);
    assert.match(weekly.join("\n"), /On-demand.*25%/);
    assert.match(weekly.join("\n"), /Prepaid balance.*12/);

    mode = "monthly";
    const monthly = await fetchXai(ctx);
    assert.match(monthly.join("\n"), /Month \(credits\).*25%/);

    mode = "unbounded";
    const noLimit = await fetchXai(ctx);
    assert.match(noLimit.join("\n"), /42 used \(no limit reported\)/);
  });
});

test("unexpected auth errors cannot persist secret text", async () => {
  const load = createUsageLoader();
  const data = await load({
    modelRegistry: { getProviderAuth: async () => { throw new Error("oauth-secret-value"); } },
  });
  assert.doesNotMatch(JSON.stringify(data), /oauth-secret-value/);
  assert.match(JSON.stringify(data), /usage unavailable/);
});

test("HTTP 401 from a usage endpoint prompts re-login for that provider", async () => {
  const load = createUsageLoader();
  const ctx = authContext({ xai: oauth() });
  await withFetch(async () => json({}, { status: 401 }), async () => {
    const data = await load(ctx);
    const grok = data.blocks.find((block) => block.name === "Grok");
    assert.equal(grok.status, "rejected");
    assert.equal(grok.lines, undefined);
    const rendered = renderContent(data);
    assert.match(rendered, /Grok: login expired \(\/login xai\)/);
    assert.doesNotMatch(rendered, /OAuth token rejected/);
  });
});

test("network failures surface as network error with system code", async () => {
  const load = createUsageLoader();
  const ctx = authContext({
    anthropic: oauth(),
    "openai-codex": oauth(),
    "kimi-coding": oauth(),
    xai: oauth(),
  });
  await withFetch(async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  }, async () => {
    const text = JSON.stringify(await load(ctx));
    assert.match(text, /network error \(ECONNREFUSED\)/);
    assert.doesNotMatch(text, /usage unavailable/);
  });
});

test("fetches refuse redirects and a stalled provider reports the 8 s budget", async () => {
  let init;
  await withFetch(async (_url, options) => {
    init = options;
    return json({});
  }, () => getJson("https://example.test", "token"));
  assert.equal(init.redirect, "error");

  const load = createUsageLoader();
  await withFetch(async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }, async () => {
    const data = await load(authContext({ anthropic: oauth() }));
    assert.match(JSON.stringify(data), /timed out \(8s\)/);
    assert.doesNotMatch(JSON.stringify(data), /8000ms/);
  });
});

test("Codex block uses the terminal's default foreground", () => {
  const rendered = renderContent({ blocks: [{ name: "Codex", lines: ["Codex"] }] });
  assert.doesNotMatch(rendered, /38;2;255;255;255/);
  assert.match(renderContent({ blocks: [{ name: "Claude", lines: ["Claude"] }] }), /38;2;215;119;87/);
});

test("unconnected and failing providers collapse into dim footer lines", () => {
  const data = {
    blocks: [
      { name: "Claude", lines: ["Claude (Max x5)", "  Session (5h)   ████░░░░░░  42%"] },
      { name: "Codex", status: "unconnected", hint: "/login openai-codex" },
      { name: "Kimi", status: "unconnected", hint: "/login kimi-coding" },
      { name: "Grok", status: "nodata" },
      { name: "GLM", status: "error", detail: "timed out (8s)" },
    ],
    fetchedAt: "2026-01-01T00:00:00Z",
  };
  const lines = renderContent(data).split("\n");
  assert.equal(lines.length, 6);
  assert.match(lines[0], /Claude \(Max x5\)/);
  assert.match(lines[2], /Grok: no plan data/);
  assert.match(lines[3], /GLM: timed out \(8s\)/);
  assert.match(lines[4], /not connected: Codex · Kimi/);
  assert.match(lines[5], /fetched/);
  for (const footer of lines.slice(2)) assert.ok(footer.startsWith(STAMP), `dim footer: ${footer}`);
  assert.doesNotMatch(renderContent(data), /not logged in|API key not set/);

  const all = renderContent({ ...data, all: true });
  assert.match(all, /Codex.*\n.*not connected \(\/login openai-codex\)/);
  assert.match(all, /Kimi.*\n.*not connected \(\/login kimi-coding\)/);
  assert.doesNotMatch(all, /not connected: /);
});

test("nothing connected renders a single hint line", () => {
  const data = {
    blocks: [
      { name: "Claude", status: "unconnected", hint: "/login anthropic" },
      { name: "GLM", status: "unconnected", hint: "set ZAI_API_KEY or ZAI_CODING_CN_API_KEY" },
    ],
    fetchedAt: "2026-01-01T00:00:00Z",
  };
  const lines = renderContent(data).split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /no providers connected — Claude: \/login anthropic · GLM: set ZAI_API_KEY or ZAI_CODING_CN_API_KEY/);
});

test("loader marks header-only providers as no plan data and missing logins as unconnected", async () => {
  const load = createUsageLoader();
  await withFetch(async () => json({}), async () => {
    const data = await load(authContext({ anthropic: oauth() }));
    const claude = data.blocks.find((block) => block.name === "Claude");
    assert.equal(claude.status, "nodata");
    const codex = data.blocks.find((block) => block.name === "Codex");
    assert.equal(codex.status, "unconnected");
    assert.equal(codex.hint, "/login openai-codex");
    const glm = data.blocks.find((block) => block.name === "GLM");
    assert.equal(glm.status, "unconnected");
    assert.match(glm.hint, /ZAI_API_KEY/);
    assert.doesNotMatch(JSON.stringify(data), /not logged in|API key not set/);
    assert.match(renderContent(data), /Claude: no plan data/);
    assert.match(renderContent(data), /no providers connected|not connected: Codex · Kimi · Grok · GLM/);
  });
});

test("Grok without a plan reports no meters", async () => {
  await withFetch(async (url) => json(String(url).endsWith("/settings") ? {} : { config: {} }), async () => {
    const lines = await fetchXai(authContext({ xai: oauth("grok-token") }));
    assert.deepEqual(lines, ["Grok"]);
  });
});

test("loader caches sequential calls and deduplicates concurrent calls", async () => {
  let resolutions = 0;
  const ctx = {
    modelRegistry: {
      getProviderAuth: async () => {
        resolutions++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return undefined;
      },
    },
  };
  const load = createUsageLoader();
  const [a, b] = await Promise.all([load(ctx), load(ctx)]);
  assert.equal(a, b);
  assert.equal(resolutions, 6);
  assert.equal(await load(ctx), a);
  assert.equal(resolutions, 6);
});

test("package manifest limits files and includes community metadata", () => {
  assert.deepEqual(pkg.files, ["extensions", "README.md", "LICENSE"]);
  assert.equal(pkg.scripts?.test, "node --test");
  assert.match(pkg.repository?.url ?? "", /github\.com\/Quigleybits\/pi-usage-meters/);
  assert.equal(pkg.publishConfig?.access, "public");
});

test("publish workflow is OIDC-only", async () => {
  const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

// --- Grok reset detection (stateful inference) ---

function withState(run) {
  const dir = mkdtempSync(join(tmpdir(), "pum-state-"));
  const prev = process.env.PI_USAGE_METERS_STATE;
  process.env.PI_USAGE_METERS_STATE = join(dir, "state.json");
  return Promise.resolve(run(join(dir, "state.json"))).finally(() => {
    if (prev === undefined) delete process.env.PI_USAGE_METERS_STATE;
    else process.env.PI_USAGE_METERS_STATE = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

const grokBilling = (periodStart, periodEnd, creditUsagePercent, extra = {}) => ({
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: periodStart,
      end: periodEnd,
    },
    creditUsagePercent,
    isUnifiedBillingUser: true,
    ...extra,
  },
});

const PERIOD_A = ["2026-08-19T22:08:22Z", "2026-08-26T22:08:22Z"];
const PERIOD_B = ["2026-08-26T22:08:22Z", "2026-09-02T22:08:22Z"];

function grokCtx() {
  return authContext({ xai: oauth("grok-token") });
}

async function runGrokFetch(body, statePath, seed) {
  if (seed !== undefined) writeFileSync(statePath, JSON.stringify(seed));
  let lines;
  await withFetch(async (url) => {
    if (String(url).endsWith("/settings")) return json({});
    return json(body);
  }, async () => {
    lines = await fetchXai(grokCtx());
  });
  return lines;
}

test("Grok: same-week usage drop is reported as a redeemed reset", () => withState(async (statePath) => {
  const lines = await runGrokFetch(
    grokBilling(PERIOD_A[0], PERIOD_A[1], 5),
    statePath,
    { xai: { periodStart: PERIOD_A[0], periodEnd: PERIOD_A[1], pct: 35, seenAt: "2026-08-21T10:00:00Z" } },
  );
  assert.match(lines.join("\n"), /Reset used.*\d{1,2} [A-Z][a-z]{2} \(35% → 5%\)/);
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.xai.pct, 5);
}));

test("Grok: rising usage updates state without a reset line", () => withState(async (statePath) => {
  const lines = await runGrokFetch(
    grokBilling(PERIOD_A[0], PERIOD_A[1], 15),
    statePath,
    { xai: { periodStart: PERIOD_A[0], periodEnd: PERIOD_A[1], pct: 5, seenAt: "2026-08-21T10:00:00Z" } },
  );
  assert.doesNotMatch(lines.join("\n"), /Reset used/);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).xai.pct, 15);
}));

test("Grok: new weekly period never fires a reset line", () => withState(async (statePath) => {
  const lines = await runGrokFetch(
    grokBilling(PERIOD_B[0], PERIOD_B[1], 3),
    statePath,
    { xai: { periodStart: PERIOD_A[0], periodEnd: PERIOD_A[1], pct: 100, seenAt: "2026-08-25T10:00:00Z" } },
  );
  assert.doesNotMatch(lines.join("\n"), /Reset used/);
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.xai.periodStart, PERIOD_B[0]);
}));

test("Grok: missing or corrupt state seeds a baseline without errors", () => withState(async (statePath) => {
  const first = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 10), statePath);
  assert.doesNotMatch(first.join("\n"), /Reset used/);
  assert.ok(existsSync(statePath));
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).xai.pct, 10);

  writeFileSync(statePath, "{not json");
  const second = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 12), statePath);
  assert.doesNotMatch(second.join("\n"), /Reset used/);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).xai.pct, 12);
}));

test("Grok: explicit reset-count fields are rendered when xAI ever exposes them", () => withState(async (statePath) => {
  const lines = await runGrokFetch(
    grokBilling(PERIOD_A[0], PERIOD_A[1], 40, { resetsRemaining: 2 }),
    statePath,
  );
  assert.match(lines.join("\n"), /Resets\s+2 available/);
  assert.doesNotMatch(lines.join("\n"), /Reset used/);
}));
