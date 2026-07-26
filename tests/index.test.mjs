import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  bar,
  clean,
  clampPct,
  codexAccountId,
  createUsageLoader,
  fetchAnthropic,
  fetchCodex,
  fetchKimi,
  fetchXai,
  getJson,
  line,
  pie,
  renderContent,
  tokenFor,
} from "../extensions/core.js";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

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

test("Grok parses bounded and unbounded monthly billing", async () => {
  const ctx = authContext({ xai: oauth("grok-token") });
  let unbounded = false;
  await withFetch(async (url) => {
    if (String(url).endsWith("/settings")) return json({ subscription_tier_display: "SuperGrok" });
    assert.equal(String(url), "https://cli-chat-proxy.grok.com/v1/billing");
    return json({
      config: unbounded
        ? { used: { val: 42 } }
        : {
            monthlyLimit: { val: 1000 },
            used: { val: 250 },
            billingPeriodStart: "2030-08-01T00:00:00Z",
            billingPeriodEnd: "2030-09-01T00:00:00Z",
          },
    });
  }, async () => {
    const bounded = await fetchXai(ctx);
    assert.equal(bounded[0], "Grok (SuperGrok)");
    assert.match(bounded.join("\n"), /Month \(credits\).*25%/);

    unbounded = true;
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
  assert.equal(resolutions, 4);
  assert.equal(await load(ctx), a);
  assert.equal(resolutions, 4);
});

test("package manifest limits files and includes community metadata", () => {
  assert.deepEqual(pkg.files, ["extensions", "README.md", "LICENSE"]);
  assert.equal(pkg.scripts?.test, "node --test");
  assert.match(pkg.repository?.url ?? "", /github\.com\/Quigleybits\/pi-usage-meters/);
  assert.equal(pkg.publishConfig?.access, "public");
});
