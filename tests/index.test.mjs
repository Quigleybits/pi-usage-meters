import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bar,
  clean,
  clampPct,
  codexAccountId,
  createUsageLoader,
  fetchAnthropic,
  fetchCodex,
  fetchCopilot,
  fetchGlm,
  fetchKimi,
  fetchMinimax,
  fetchXai,
  getJson,
  line,
  pie,
  renderContent,
  STAMP,
  tokenFor,
} from "../extensions/core.js";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// All stateful Grok-detection tests must hit a throwaway state file, never the user's,
// even when PI_USAGE_METERS_STATE is inherited. The inherited value comes back afterwards.
const inheritedStatePath = process.env.PI_USAGE_METERS_STATE;
const testStateDir = mkdtempSync(join(tmpdir(), "pum-tests-"));
process.env.PI_USAGE_METERS_STATE = join(testStateDir, "state.json");
after(() => {
  if (inheritedStatePath === undefined) delete process.env.PI_USAGE_METERS_STATE;
  else process.env.PI_USAGE_METERS_STATE = inheritedStatePath;
  rmSync(testStateDir, { recursive: true, force: true });
});

test("tests write to a test-owned state file even when the variable is inherited", () => {
  assert.ok(process.env.PI_USAGE_METERS_STATE.startsWith(join(tmpdir(), "pum-tests-")));
});

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

for (const code of [0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff]) {
  const label = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  const text = `safe${String.fromCodePoint(code)}text`;
  test(`clean removes invisible or layout character ${label}`, () => {
    assert.equal(clean(text), "safetext");
  });
  test(`renderer removes invisible or layout character ${label} from headers and indented rows`, () => {
    assert.deepEqual(renderedRows({ blocks: [{ name: "Codex", lines: [text, `  ${text}`] }] }), ["safetext", "  safetext"]);
  });
}

test("sanitizing preserves normal text, percentages, meter glyphs, and accented letters", () => {
  const text = "Normal text 50% ○◔◑◕● █░ café naïve Ångström";
  assert.equal(clean(text), text);
  assert.deepEqual(renderedRows({ blocks: [{ name: "Codex", lines: [text, `  ${text}`] }] }), [text, `  ${text}`]);
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

const claudeFetch = (usage, profile = {}) => async (url) => {
  if (String(url).endsWith("/profile")) return profile instanceof Response ? profile : json(profile);
  return json(usage);
};
const inHours = (hours) => new Date(Date.now() + hours * 3600e3).toISOString();
// A reset is present (pie + relative time); the exact time drifts with test delays.
const RESET = String.raw`reset \S (?:\d+[dhm] ?)+|reset \S <1m|reset \S soon`;
const ultra = { organization: { rate_limit_tier: "default_claude_max_20x" } };
const max5 = { organization: { rate_limit_tier: "default_claude_max_5x" } };
const pro = { account: { has_claude_pro: true } };
const week = { utilization: 25, resets_at: inHours(72) };
const session = (lines) => lines.filter((text) => /^  Session \(5h\)/.test(text));

test("Claude plan labels: max_20x is Ultra, max_5x is Max, other tiers and profile fallbacks unchanged", async () => {
  const ctx = authContext({ anthropic: oauth() });
  const cases = [
    [ultra, "Claude (Ultra)"],
    [max5, "Claude (Max)"],
    [{ organization: { rate_limit_tier: "default_claude_max_10x" } }, "Claude (Max x10)"],
    [{ account: { has_claude_max: true } }, "Claude (Max)"],
    [{ organization: { organization_type: "claude_max" } }, "Claude (Max)"],
    [{ account: { has_claude_pro: true } }, "Claude (Pro)"],
    [{ organization: { rate_limit_tier: "default_claude_ai" } }, "Claude"],
    [{}, "Claude"],
    [json({}, { status: 500 }), "Claude"],
  ];
  for (const [profile, expected] of cases) {
    await withFetch(claudeFetch({ seven_day: week }, profile), async () => {
      const lines = await fetchAnthropic(ctx);
      assert.equal(lines[0], expected);
      assert.match(lines.join("\n"), /Week \(all models\).*25%/);
    });
  }
});

test("Claude Ultra with a reported 5h window shows the real reading flagged as an API meter", async () => {
  const ctx = authContext({ anthropic: oauth() });
  await withFetch(claudeFetch({ five_hour: { utilization: 37, resets_at: inHours(2) }, seven_day: week }, ultra), async () => {
    const lines = await fetchAnthropic(ctx);
    const text = lines.join("\n");
    assert.equal(lines[0], "Claude (Ultra)");
    assert.match(session(lines)[0], new RegExp(String.raw`\s37% (?:${RESET})$`));
    assert.match(text, /API meter.*may not be an enforced limit/);
    assert.match(text, /Week \(all models\).*25%/);
    assert.doesNotMatch(text, /unlimited|verified/i);
  });
});

test("Claude Ultra with a null or missing 5h window omits the Session row and keeps the weekly window", async () => {
  const ctx = authContext({ anthropic: oauth() });
  for (const usage of [{ five_hour: null, seven_day: week }, { seven_day: week }]) {
    await withFetch(claudeFetch(usage, ultra), async () => {
      const lines = await fetchAnthropic(ctx);
      const text = lines.join("\n");
      assert.equal(lines[0], "Claude (Ultra)");
      assert.equal(session(lines).length, 0);
      assert.match(lines[1], new RegExp(String.raw`^  Week \(all models\).*\s25% (?:${RESET})$`));
      assert.equal(lines.length, 2);
      assert.doesNotMatch(text, /not reported|five_hour|unavailable|unlimited|verified|API meter|API session flag/i);
    });
  }
  // Ordinary Max without a 5h field keeps omitting the row.
  await withFetch(claudeFetch({ seven_day: week }, max5), async () => {
    assert.equal(session(await fetchAnthropic(ctx)).length, 0);
  });
});

test("Claude Pro keeps a reported 5h window with its usage and reset", async () => {
  const ctx = authContext({ anthropic: oauth() });
  await withFetch(claudeFetch({ five_hour: { utilization: 63, resets_at: inHours(4) }, seven_day: week }, pro), async () => {
    const lines = await fetchAnthropic(ctx);
    const text = lines.join("\n");
    assert.equal(lines[0], "Claude (Pro)");
    assert.equal(session(lines).length, 1);
    assert.match(session(lines)[0], new RegExp(String.raw`^  Session \(5h\)\s+█+░+\s+63% (?:${RESET})$`));
    assert.match(text, /Week \(all models\).*25%/);
    assert.doesNotMatch(text, /not reported|unavailable|API meter|API session flag/i);
  });
  // A real 0% on Pro is a reading, not an absent window.
  await withFetch(claudeFetch({ five_hour: { utilization: 0, resets_at: inHours(5) }, seven_day: week }, pro), async () => {
    const rows = session(await fetchAnthropic(ctx));
    assert.equal(rows.length, 1);
    assert.match(rows[0], new RegExp(String.raw`^  Session \(5h\)\s+░{10}\s+0% (?:${RESET})$`));
  });
});

const sessionFlag = (isActive) => ({ kind: "session", is_active: isActive });
const flagRows = (lines) => lines.filter((text) => /^  API session flag/.test(text));
const fiveHour = { utilization: 37, resets_at: inHours(2) };

test("Claude Ultra shows a single session limits entry's literal is_active beside the 5h row and API-meter note", async () => {
  const ctx = authContext({ anthropic: oauth() });
  for (const isActive of [true, false]) {
    await withFetch(claudeFetch({ five_hour: fiveHour, seven_day: week, limits: [sessionFlag(isActive)] }, ultra), async () => {
      const lines = await fetchAnthropic(ctx);
      const text = lines.join("\n");
      assert.match(session(lines)[0], new RegExp(String.raw`\s37% (?:${RESET})$`));
      assert.match(lines[2], /^\s+API meter; may not be an enforced limit$/);
      assert.deepEqual(flagRows(lines), [`  ${"API session flag".padEnd(22)} is_active: ${isActive}`]);
      assert.match(text, /Week \(all models\).*25%/);
      assert.doesNotMatch(flagRows(lines)[0], /enforc|limit|verified/i);
      assert.doesNotMatch(text, /unlimited|verified/i);
    });
  }
});

test("Claude Ultra shows no session flag when is_active is missing or not a boolean", async () => {
  const ctx = authContext({ anthropic: oauth() });
  const variants = [
    undefined,
    [],
    [{ kind: "session" }],
    [{ kind: "session", is_active: null }],
    [{ kind: "session", is_active: "true" }],
    [{ kind: "weekly", is_active: true }],
  ];
  for (const limits of variants) {
    await withFetch(claudeFetch({ five_hour: fiveHour, seven_day: week, limits }, ultra), async () => {
      const lines = await fetchAnthropic(ctx);
      assert.equal(flagRows(lines).length, 0);
      assert.match(session(lines)[0], /37%/);
      assert.match(lines.join("\n"), /API meter; may not be an enforced limit/);
    });
  }
});

test("Claude Ultra with multiple session flags lists them all and selects none", async () => {
  const ctx = authContext({ anthropic: oauth() });
  for (const [flags, values] of [[[true, false], "true, false"], [[true, true], "true, true"]]) {
    const limits = flags.map(sessionFlag);
    await withFetch(claudeFetch({ five_hour: fiveHour, seven_day: week, limits }, ultra), async () => {
      const rows = flagRows(await fetchAnthropic(ctx));
      assert.equal(rows.length, 1);
      assert.match(rows[0], new RegExp(String.raw`^  API session flag\s+2 entries \(is_active: ${values}\); none selected$`));
      assert.doesNotMatch(rows[0], /^  API session flag\s+is_active:/);
    });
  }
});

test("Claude Ultra finds a session flag after ten unrelated weekly limits entries", async () => {
  const ctx = authContext({ anthropic: oauth() });
  const weekly = Array.from({ length: 10 }, () => ({ group: "weekly", kind: "weekly", percent: 5, resets_at: inHours(72) }));
  await withFetch(claudeFetch({ five_hour: fiveHour, seven_day: week, limits: [...weekly, sessionFlag(false)] }, ultra), async () => {
    assert.deepEqual(flagRows(await fetchAnthropic(ctx)), [`  ${"API session flag".padEnd(22)} is_active: false`]);
  });
});

test("Claude Ultra with more than ten session flags reports the total, lists ten, and selects none", async () => {
  const ctx = authContext({ anthropic: oauth() });
  const limits = [...Array.from({ length: 11 }, () => sessionFlag(true)), sessionFlag(false)];
  await withFetch(claudeFetch({ five_hour: fiveHour, seven_day: week, limits }, ultra), async () => {
    const rows = flagRows(await fetchAnthropic(ctx));
    assert.equal(rows.length, 1);
    const values = Array(10).fill("true").join(", ");
    assert.equal(rows[0], `  ${"API session flag".padEnd(22)} 12 entries (is_active: ${values}, …); none selected`);
    assert.doesNotMatch(rows[0], /^  API session flag\s+is_active:/);
  });
});

test("Claude Ultra with five_hour missing omits the Session row but keeps a separately reported session flag", async () => {
  const ctx = authContext({ anthropic: oauth() });
  for (const usage of [{ five_hour: null }, {}]) {
    for (const [limits, expected] of [
      [[sessionFlag(false)], `is_active: false`],
      [[sessionFlag(true)], `is_active: true`],
      [[sessionFlag(true), sessionFlag(false)], `2 entries (is_active: true, false); none selected`],
    ]) {
      await withFetch(claudeFetch({ ...usage, seven_day: week, limits }, ultra), async () => {
        const lines = await fetchAnthropic(ctx);
        const text = lines.join("\n");
        assert.equal(lines[0], "Claude (Ultra)");
        assert.equal(session(lines).length, 0);
        assert.deepEqual(flagRows(lines), [`  ${"API session flag".padEnd(22)} ${expected}`]);
        assert.match(text, /Week \(all models\).*25%/);
        assert.equal(lines.length, 3);
        assert.doesNotMatch(text, /not reported|five_hour|unavailable|no session|API meter|unlimited|verified/i);
      });
    }
  }
});

test("Claude ordinary Max ignores session flags and keeps its output unchanged", async () => {
  const ctx = authContext({ anthropic: oauth() });
  const opus = { group: "weekly", scope: { model: { display_name: "Opus" } }, percent: 7, resets_at: inHours(72) };
  for (const base of [{ five_hour: fiveHour, seven_day: week }, { seven_day: week }]) {
    // Reset countdowns can tick between renders; compare everything else.
    const render = (limits) => withFetch(claudeFetch({ ...base, limits }, max5), async () =>
      (await fetchAnthropic(ctx)).map((text) => text.replace(new RegExp(String.raw` (?:${RESET})$`), "")));
    const plainLines = await render([opus]);
    for (const flags of [[true], [false], [true, false]]) {
      const lines = await render([opus, ...flags.map(sessionFlag)]);
      assert.deepEqual(lines, plainLines);
      assert.equal(flagRows(lines).length, 0);
      assert.doesNotMatch(lines.join("\n"), /API meter|not reported/);
    }
  }
});

test("Claude incomplete 5h data reads as unavailable, while a real 0% still renders without a reset", async () => {
  const ctx = authContext({ anthropic: oauth() });
  for (const profile of [max5, ultra, pro]) {
    for (const fiveHour of [{ utilization: null, resets_at: inHours(2) }, { resets_at: inHours(2) }, { utilization: "n/a" }, {}]) {
      await withFetch(claudeFetch({ five_hour: fiveHour, seven_day: week }, profile), async () => {
        const rows = session(await fetchAnthropic(ctx));
        assert.equal(rows.length, 1);
        assert.match(rows[0], /^  Session \(5h\)\s+window reported, reading unavailable$/);
        assert.doesNotMatch(rows[0], /%/);
      });
    }
    await withFetch(claudeFetch({ five_hour: { utilization: 0, resets_at: null }, seven_day: week }, profile), async () => {
      const rows = session(await fetchAnthropic(ctx));
      assert.equal(rows.length, 1);
      assert.match(rows[0], /^  Session \(5h\)\s+░{10}\s+0%$/);
    });
  }
});

test("Claude Max and Ultra keep 5h, weekly, model and extra-usage output; Ultra adds the API-meter note", async () => {
  const ctx = authContext({ anthropic: oauth() });
  const usage = {
    five_hour: { utilization: 42, resets_at: inHours(3) },
    seven_day: week,
    limits: [{ group: "weekly", scope: { model: { display_name: "Opus" } }, percent: 7, resets_at: inHours(72) }],
    extra_usage: { credits_ever_enabled: true, is_enabled: true, currency: "USD", decimal_places: 2, used_credits: 150, monthly_limit: 5000 },
  };
  for (const [profile, title, isUltra] of [[max5, "Claude (Max)", false], [ultra, "Claude (Ultra)", true]]) {
    await withFetch(claudeFetch(usage, profile), async () => {
      const lines = await fetchAnthropic(ctx);
      const text = lines.join("\n");
      assert.equal(lines[0], title);
      assert.match(session(lines)[0], new RegExp(String.raw`^  Session \(5h\)\s+█+░+\s+42% (?:${RESET})$`));
      assert.match(text, new RegExp(String.raw`Week \(all models\).*\s25% (?:${RESET})$`, "m"));
      assert.match(text, new RegExp(String.raw`Week \(Opus\).*\s7% (?:${RESET})$`, "m"));
      assert.match(text, /Extra usage\s+USD 1\.50\/50\.00/);
      assert.doesNotMatch(text, /not reported|unavailable|unlimited|verified/i);
      if (isUltra) {
        assert.match(lines[2], /^\s+API meter; may not be an enforced limit$/);
        assert.equal(lines.length, 6);
      } else {
        assert.doesNotMatch(text, /API meter/);
        assert.equal(lines.length, 5);
      }
    });
  }
});

test("Claude with no usage data stays no plan data, Ultra included", async () => {
  for (const profile of [{}, ultra]) {
    const load = createUsageLoader();
    await withFetch(claudeFetch({}, profile), async () => {
      const data = await load(authContext({ anthropic: oauth() }));
      assert.equal(data.blocks.find((block) => block.name === "Claude").status, "nodata");
      assert.match(renderContent(data), /Claude: no plan data/);
    });
  }
  // Ultra with only a null 5h field and no weekly window has nothing to show either.
  const load = createUsageLoader();
  await withFetch(claudeFetch({ five_hour: null }, ultra), async () => {
    const data = await load(authContext({ anthropic: oauth() }));
    assert.equal(data.blocks.find((block) => block.name === "Claude").status, "nodata");
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
    assert.doesNotMatch(lines.join("\n"), /Credits/);
  });
});

test("Codex shows the usage credit balance separately from banked resets", async () => {
  const ctx = authContext({ "openai-codex": oauth(jwt()) });
  const usage = {
    plan_type: "prolite",
    rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 46, reset_at: 1786500000 } },
    rate_limit_reset_credits: { available_count: 1 },
  };
  const respond = (credits) => async (url) => json(String(url).endsWith("rate-limit-reset-credits")
    ? { credits: [] }
    : { ...usage, credits });
  await withFetch(respond({ has_credits: true, unlimited: false, balance: "12345" }), async () => {
    const lines = await fetchCodex(ctx);
    assert.match(lines.join("\n"), /Credits\s+12,345 remaining/);
    assert.match(lines.join("\n"), /Banked resets/);
  });
  await withFetch(respond({ has_credits: true, unlimited: false, balance: 12345.6 }), async () => {
    assert.match((await fetchCodex(ctx)).join("\n"), /Credits\s+12,346 remaining/);
  });
  await withFetch(respond({ has_credits: true, unlimited: true, balance: "1" }), async () => {
    const text = (await fetchCodex(ctx)).join("\n");
    assert.match(text, /Credits\s+unlimited/);
    assert.doesNotMatch(text, /1 remaining/);
  });
  await withFetch(respond({ has_credits: true, unlimited: false, balance: "0" }), async () => {
    assert.match((await fetchCodex(ctx)).join("\n"), /Credits\s+0 remaining/);
  });
  for (const credits of [null, { has_credits: false, unlimited: false, balance: "80" }, { has_credits: true, balance: null }, { has_credits: true, balance: "n/a" }]) {
    await withFetch(respond(credits), async () => {
      assert.doesNotMatch((await fetchCodex(ctx)).join("\n"), /Credits/);
    });
  }
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

test("a non-array limits field does not blank the Claude or Kimi block", async () => {
  for (const limits of [{}, "weekly", 7]) {
    await withFetch(claudeFetch({ seven_day: { utilization: 25, resets_at: inHours(72) }, limits }), async () => {
      const lines = await fetchAnthropic(authContext({ anthropic: oauth() }));
      assert.match(lines.join("\n"), /Week \(all models\).*25%/);
    });
    await withFetch(async () => json({ limits, usage: { used: 45, limit: 300, resetTime: "2030-08-15T12:00:00Z" } }), async () => {
      const lines = await fetchKimi(authContext({ "kimi-coding": oauth() }));
      assert.match(lines.join("\n"), /Week.*15%/);
    });
  }
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
            { product: "GrokBuildPro", usagePercent: 2 },
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
    assert.match(weekly.join("\n"), /Bot\s+.*10%/);
    assert.doesNotMatch(weekly.join("\n"), /Grok Bot \(SuperGrok\)/);
    assert.doesNotMatch(weekly.join("\n"), /^  Build\b/m);
    assert.match(weekly.join("\n"), /BuildPro.*\s+2%/);
    assert.match(weekly.join("\n"), /Imagine.*\s+6%/);
    assert.match(weekly.join("\n"), /Chat.*\s+1%/);
    // Products sum to 19%, not the 17% week, so they are not slices: same 2-space indent as the week.
    for (const name of ["Bot", "BuildPro", "Imagine", "Chat"]) {
      assert.match(weekly.find((row) => row.trimStart().startsWith(`${name} `)), new RegExp(`^  ${name} `));
    }
    assert.match(weekly.find((row) => row.trimStart().startsWith("Week (credits) ")), /^  Week \(credits\) /);
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
  assert.match(JSON.stringify(data), /login check failed/);
  assert.doesNotMatch(JSON.stringify(data), /usage unavailable/);
});

test("an expired OAuth refresh token renders as login expired, never as usage unavailable", async () => {
  const load = createUsageLoader();
  const ctx = {
    modelRegistry: {
      getProviderAuth: async (provider) => {
        if (provider !== "anthropic") return undefined;
        throw new Error('OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token expired"}');
      },
    },
  };
  const data = await load(ctx);
  const claude = data.blocks.find((block) => block.name === "Claude");
  assert.equal(claude.status, "rejected");
  assert.equal(claude.hint, "login expired (/login anthropic)");
  const text = JSON.stringify(data);
  assert.doesNotMatch(text, /invalid_grant|platform\.claude\.com|usage unavailable/);
  assert.match(renderContent(data), /Claude: login expired \(\/login anthropic\)/);
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
    const data = await load(ctx);
    const text = JSON.stringify(data);
    assert.match(text, /"detail":"network error","debug":"fetch failed ECONNREFUSED"/);
    assert.doesNotMatch(text, /usage unavailable/);
    assert.match(renderContent(data), /Claude: network error\x1b\[0m/);
    assert.doesNotMatch(renderContent(data), /ECONNREFUSED/);
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
    const claude = data.blocks.find((block) => block.name === "Claude");
    assert.equal(claude.detail, "timed out");
    assert.equal(claude.debug, "timed out after 8000ms");
    assert.match(renderContent(data), /Claude: timed out\x1b\[0m/);
    assert.doesNotMatch(renderContent(data), /8000|\(8s\)/);
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
      { name: "GLM", status: "error", detail: "timed out", debug: "timed out after 8000ms" },
    ],
    fetchedAt: "2026-01-01T00:00:00Z",
  };
  const lines = renderContent(data).split("\n");
  assert.equal(lines.length, 6);
  assert.match(lines[0], /Claude \(Max x5\)/);
  assert.match(lines[2], /Grok: no plan data/);
  assert.match(lines[3], /GLM: timed out\x1b\[0m$/);
  assert.match(lines[4], /not connected: Codex · Kimi/);
  assert.doesNotMatch(renderContent(data), /8000ms/); // debug fields are persisted, never rendered
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
    assert.match(renderContent(data), /not connected: Codex · Kimi · Grok · Copilot · GLM · MiniMax\x1b/);
  });
});

// Official CLI fixture (MiniMax-AI/cli test/fixtures/quota-response.json), legacy semantics: usage_count = remaining.
const minimaxFixture = (extra = {}) => ({
  base_resp: { status_code: 0, status_msg: "success" },
  model_remains: [
    {
      model_name: "MiniMax-M*",
      start_time: Date.now() - 2 * 3600e3,
      end_time: Date.now() + 3 * 3600e3,
      remains_time: 3 * 3600e3,
      current_interval_total_count: 1500,
      current_interval_usage_count: 228,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: Date.now() - 4 * 86400e3,
      weekly_end_time: Date.now() + 3 * 86400e3,
      weekly_remains_time: 3 * 86400e3,
      ...extra,
    },
    {
      model_name: "speech-hd",
      start_time: Date.now() - 3600e3,
      end_time: Date.now() + 23 * 3600e3,
      remains_time: 23 * 3600e3,
      current_interval_total_count: 9000,
      current_interval_usage_count: 9000,
      current_weekly_total_count: 63000,
      current_weekly_usage_count: 63000,
    },
    {
      model_name: "video-01",
      current_interval_total_count: 0,
      current_weekly_total_count: 0,
      current_interval_status: 3,
      current_weekly_status: 3,
    },
  ],
});

test("MiniMax parses the official fixture with legacy remaining-count semantics", async () => {
  const ctx = authContext({ minimax: { source: "apiKey", auth: { apiKey: "mm-key" } } });
  await withFetch(async (url, init) => {
    assert.equal(String(url), "https://api.minimax.io/v1/token_plan/remains");
    assert.equal(init.headers.Authorization, "Bearer mm-key");
    return json(minimaxFixture());
  }, async () => {
    const lines = await fetchMinimax(ctx);
    assert.equal(lines[0], "MiniMax (token plan)");
    assert.match(lines[1], /Session \(5h\).*85%.*reset.*1,272\/1,500/);
    assert.match(lines[2], /speech-hd\s+░+\s+0%/);
    assert.equal(lines.length, 3); // weekly total 0 → no Week line; video-01 not in plan → skipped
  });
});

test("MiniMax uses remaining_percent to disambiguate usage_count and honours the weekly boost", async () => {
  const ctx = authContext({ "minimax-cn": { source: "apiKey", auth: { apiKey: "mm-cn-key" } } });
  await withFetch(async (url) => {
    assert.equal(String(url), "https://api.minimaxi.com/v1/token_plan/remains");
    return json(minimaxFixture({
      current_interval_remaining_percent: 84.8, // 228 now reads as *used*
      current_weekly_total_count: 10000,
      current_weekly_usage_count: 2500,
      current_weekly_remaining_percent: 75,
      weekly_boost_permille: 1200,
    }));
  }, async () => {
    const lines = await fetchMinimax(ctx);
    assert.match(lines[1], /Session \(5h\).*15%.*228\/1,500/);
    assert.match(lines[2], /Week\s+█░{9}\s+10%.*reset.*2,500\/10,000/); // 75% × 1.2 = 90% remaining → 10% used
  });
});

test("MiniMax in-band auth failure, pay-as-you-go keys, and missing keys", async () => {
  const load = createUsageLoader();
  const ctx = authContext({ minimax: { source: "apiKey", auth: { apiKey: "mm-key" } } });
  await withFetch(async () => json({ base_resp: { status_code: 1004, status_msg: "login fail: secret" } }), async () => {
    const block = (await load(ctx)).blocks.find((entry) => entry.name === "MiniMax");
    assert.equal(block.status, "rejected");
    assert.equal(block.hint, "API key rejected");
    assert.doesNotMatch(JSON.stringify(block), /secret/);
  });

  const payg = authContext({ minimax: { source: "apiKey", auth: { apiKey: "sk-api-123" } } });
  let requests = 0;
  await withFetch(async () => {
    requests += 1;
    return json({});
  }, async () => {
    await assert.rejects(fetchMinimax(payg), (error) => error.name === "NotConnected" && /pay-as-you-go key/.test(error.hint));
  });
  assert.equal(requests, 0); // a pay-as-you-go key has no plan to meter and never reaches the network

  await assert.rejects(
    fetchMinimax(authContext({})),
    (error) => error.name === "NotConnected" && /MINIMAX_API_KEY or MINIMAX_CN_API_KEY/.test(error.hint),
  );
});

test("MiniMax renders percent-only windows on zero-total time-based plans", async () => {
  const ctx = authContext({ minimax: { source: "apiKey", auth: { apiKey: "mm-key" } } });
  await withFetch(async () => json({
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: "MiniMax-M*",
      start_time: Date.now() - 3600e3,
      end_time: Date.now() + 4 * 3600e3,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      current_interval_remaining_percent: 61,
      current_interval_status: 1,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      current_weekly_remaining_percent: 92,
      current_weekly_status: 1,
      weekly_start_time: Date.now() - 86400e3,
      weekly_end_time: Date.now() + 6 * 86400e3,
    }],
  }), async () => {
    const lines = await fetchMinimax(ctx);
    assert.equal(lines.length, 3);
    assert.match(lines[1], /Session \(5h\)\s+████░{6}\s+39% reset/);
    assert.doesNotMatch(lines[1], /\//); // no counts without a usable total
    assert.match(lines[2], /Week\s+█░{9}\s+8% reset/);
  });
});

test("MiniMax marks exhausted windows as spent, rejects code 2049, and renders the general bucket first", async () => {
  const ctx = authContext({ minimax: { source: "apiKey", auth: { apiKey: "mm-key" } } });
  await withFetch(async () => json({
    base_resp: { status_code: 0 },
    model_remains: [
      {
        model_name: "video",
        start_time: Date.now() - 3600e3,
        end_time: Date.now() + 23 * 3600e3,
        current_interval_total_count: 10,
        current_interval_usage_count: 10,
        current_interval_remaining_percent: 100,
        current_interval_status: 1,
        current_weekly_total_count: 0,
        current_weekly_status: 3,
      },
      {
        model_name: "general",
        start_time: Date.now() - 3600e3,
        end_time: Date.now() + 4 * 3600e3,
        current_interval_total_count: 1500,
        current_interval_usage_count: 1500,
        current_interval_remaining_percent: 40, // stale: the server flags the window exhausted
        current_interval_status: 2,
        current_weekly_total_count: 10000,
        current_weekly_usage_count: 9000,
        current_weekly_remaining_percent: 90,
        current_weekly_status: 1,
        weekly_start_time: Date.now() - 86400e3,
        weekly_end_time: Date.now() + 6 * 86400e3,
      },
    ],
  }), async () => {
    const lines = await fetchMinimax(ctx);
    assert.match(lines[1], /Session \(5h\)\s+█{10}\s+100%/);
    assert.match(lines[2], /Week\s+█░{9}\s+10%.*1,000\/10,000/);
    assert.match(lines[3], /video\s+░{10}\s+0%/);
    assert.equal(lines.length, 4);
  });
  const load = createUsageLoader();
  await withFetch(async () => json({ base_resp: { status_code: 2049, status_msg: "invalid api key" } }), async () => {
    const block = (await load(ctx)).blocks.find((entry) => entry.name === "MiniMax");
    assert.equal(block.status, "rejected");
  });
});

test("GLM labels explicit seven-day windows as Week, not Month", async () => {
  const ctx = authContext({ zai: { source: "apiKey", auth: { apiKey: "zai-key" } } });
  await withFetch(async () => json({
    code: 200,
    data: {
      level: "pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 5, number: 1, percentage: 12, nextResetTime: Date.now() + 2 * 86400e3 },
        { type: "CREDIT_LIMIT", unit: 5, number: 1, usage: 700, currentValue: 70, percentage: 10, nextResetTime: Date.now() + 2 * 86400e3 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: Date.now() + 20 * 86400e3 },
      ],
    },
  }), async () => {
    const lines = await fetchGlm(ctx);
    assert.match(lines[1], /Week \(tokens\).*12%/);
    assert.match(lines[2], /Week \(credits\).*10%.*70\/700/);
    assert.match(lines[3], /Month \(tokens\).*40%/);
  });
});

test("Codex keeps its optional banked-reset lookup inside the provider budget", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const ctx = authContext({ "openai-codex": oauth(jwt()) });
  let optionalCalls = 0;
  let elapsedAfterPrimary = 7_900;
  const usage = {
    rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 10, reset_at: 1786500000 } },
    rate_limit_reset_credits: { available_count: 2 },
  };
  await withFetch(async (url, init) => {
    if (String(url).endsWith("rate-limit-reset-credits")) {
      optionalCalls += 1;
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }));
    }
    now += elapsedAfterPrimary; // the primary call consumed almost the whole 8 s budget
    return json(usage);
  }, async () => {
    const started = Date.now();
    const lines = await fetchCodex(ctx, { clock });
    assert.ok(Date.now() - started < 1_500, "the follow-up must be cut to the remaining budget, not its full 2.5 s");
    assert.equal(optionalCalls, 1);
    assert.match(lines.join("\n"), /Banked resets\s+●●$/m);

    elapsedAfterPrimary = 8_100; // budget already spent: the follow-up is skipped entirely
    const skipped = await fetchCodex(ctx, { clock });
    assert.equal(optionalCalls, 1);
    assert.match(skipped.join("\n"), /Banked resets\s+●●$/m);
  });
});

// --- GitHub Copilot: the one meter that reads pi's stored credential (through pi's public API) ---

const copilotCtx = authContext({ "github-copilot": { source: "OAuth", auth: { apiKey: "tid=session;exp=1" } } });
const copilotCredential = (extra = {}) => ({ type: "oauth", refresh: "gho_github_secret", access: "tid=session;exp=1", expires: 1, ...extra });
const copilotUser = {
  login: "octocat",
  copilot_plan: "individual",
  access_type_sku: "monthly_subscriber",
  quota_reset_date: "2030-09-01",
  quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 212, percent_remaining: 70.7, unlimited: false, overage_count: 0 },
    chat: { unlimited: true },
    completions: { unlimited: true },
  },
};

test("Copilot reads the GitHub token through the injected credential reader and sends it only to GitHub", async () => {
  let readFor;
  const readCredential = async (providerId) => {
    readFor = providerId;
    return copilotCredential();
  };
  await withFetch(async (url, init) => {
    assert.equal(String(url), "https://api.github.com/copilot_internal/user");
    assert.equal(init.headers.Authorization, "Bearer gho_github_secret");
    assert.match(init.headers["User-Agent"], /^GitHubCopilotChat\//);
    assert.equal(init.headers["Editor-Version"], "vscode/1.107.0");
    return json(copilotUser);
  }, async () => {
    const lines = await fetchCopilot(copilotCtx, { readCredential });
    assert.equal(readFor, "github-copilot");
    assert.equal(lines[0], "Copilot (Pro)");
    assert.match(lines[1], /Premium requests\s+███░{7}\s+29% reset.*88\/300$/);
    assert.equal(lines.length, 2); // unlimited chat/completions snapshots are skipped
  });

  await withFetch(async (url) => {
    assert.equal(String(url), "https://api.ghe.example.com/copilot_internal/user");
    return json({ ...copilotUser, copilot_plan: "enterprise", quota_snapshots: { premium_interactions: { entitlement: 1000, remaining: 100, percent_remaining: 10, overage_count: 12 } } });
  }, async () => {
    const lines = await fetchCopilot(copilotCtx, { readCredential: async () => copilotCredential({ enterpriseUrl: "https://ghe.example.com/" }) });
    assert.equal(lines[0], "Copilot (Enterprise)");
    assert.match(lines[1], /Premium requests.*90%.*900\/1,000 \(\+12 overage\)$/);
  });
});

for (const plan of ["constructor", "__proto__", "toString"]) {
  test(`Copilot treats inherited plan key ${plan} as an unknown plan label`, async () => {
    await withFetch(async () => json({ ...copilotUser, copilot_plan: plan }), async () => {
      const lines = await fetchCopilot(copilotCtx, { readCredential: async () => copilotCredential() });
      assert.equal(lines[0], `Copilot (${plan})`);
    });
  });
}

test("Copilot Free tier, lapsed subscriptions, and the loader's status mapping", async () => {
  const readCredential = async () => copilotCredential();
  await withFetch(async () => json({
    copilot_plan: "individual",
    access_type_sku: "free_limited_copilot",
    monthly_quotas: { chat: 500, completions: 4000 },
    limited_user_quotas: { chat: 370, completions: 3922 },
    limited_user_reset_date: "2030-05-26",
  }), async () => {
    const lines = await fetchCopilot(copilotCtx, { readCredential });
    assert.equal(lines[0], "Copilot (Free)");
    assert.match(lines[1], /Chat\s+███░{7}\s+26% reset.*130\/500$/);
    assert.match(lines[2], /Completions\s+░{10}\s+2% reset.*78\/4,000$/);
  });

  const load = createUsageLoader({ readCredential });
  await withFetch(async () => json({ copilot_plan: "individual", access_type_sku: "subscription_ended", chat_enabled: false }), async () => {
    const data = await load(copilotCtx);
    const block = data.blocks.find((entry) => entry.name === "Copilot");
    assert.equal(block.status, "nodata");
    assert.doesNotMatch(JSON.stringify(data), /gho_github_secret|tid=session/);
  });

  await withFetch(async () => json({ message: "Bad credentials" }, { status: 401 }), async () => {
    const block = (await createUsageLoader({ readCredential })(copilotCtx)).blocks.find((entry) => entry.name === "Copilot");
    assert.equal(block.status, "rejected");
    assert.equal(block.hint, "login expired (/login github-copilot)");
  });
});

test("Copilot never touches the credential store without a live OAuth login, and reports an unreadable one", async () => {
  let reads = 0;
  const readCredential = async () => {
    reads += 1;
    return undefined;
  };
  await assert.rejects(fetchCopilot(authContext({}), { readCredential }), (error) => error.name === "NotConnected" && error.hint === "/login github-copilot");
  await assert.rejects(
    fetchCopilot(authContext({ "github-copilot": { source: "GITHUB_TOKEN", auth: { apiKey: "ghp_x" } } }), { readCredential }),
    (error) => error.name === "NotConnected",
  );
  assert.equal(reads, 0);

  const block = (await createUsageLoader({ readCredential })(copilotCtx)).blocks.find((entry) => entry.name === "Copilot");
  assert.equal(reads, 1);
  assert.equal(block.status, "error");
  assert.equal(block.detail, "login not readable");
});

test("HTTP failures render as plain words and keep the status and code in the hidden debug field", async () => {
  const cases = [
    [429, { code: "resource_exhausted", message: "insufficient balance", details: [{ debug: { reason: "REASON_QUOTA_EXCEEDED" } }] }, "no credits left — plan used up or expired", "HTTP 429 resource_exhausted"],
    [429, { message: "slow down" }, "rate limited — try again shortly", "HTTP 429"],
    [402, { error: { code: "insufficient_balance", message: "top up" } }, "no credits left — plan used up or expired", "HTTP 402 insufficient_balance"],
    [403, {}, "access denied", "HTTP 403"],
    [404, {}, "endpoint changed — update the extension", "HTTP 404"],
    [503, "<html>bad gateway</html>", "provider error — try again later", "HTTP 503"],
    [418, { code: "Bearer secret-token-value", message: "secret-token-value" }, "request failed", "HTTP 418"],
  ];
  for (const [status, body, detail, debug] of cases) {
    const load = createUsageLoader();
    await withFetch(
      async () => (typeof body === "string" ? new Response(body, { status }) : json(body, { status })),
      async () => {
        const data = await load(authContext({ "kimi-coding": oauth() }));
        const kimi = data.blocks.find((block) => block.name === "Kimi");
        assert.equal(kimi.status, "error", `status ${status}`);
        assert.equal(kimi.detail, detail, `detail for ${status}`);
        assert.equal(kimi.debug, debug, `debug for ${status}`);
        const kimiLine = renderContent(data).split("\n").find((line) => line.includes("Kimi"));
        assert.ok(kimiLine.includes(`Kimi: ${detail}`), kimiLine);
        assert.ok(!kimiLine.includes(String(status)), `status leaked into footer: ${kimiLine}`);
        assert.doesNotMatch(JSON.stringify(data), /secret-token-value|slow down|top up|bad gateway/);
      },
    );
  }
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
  assert.equal(resolutions, 9); // 5 OAuth + zai/zai-coding-cn + minimax/minimax-cn
  assert.equal(await load(ctx), a);
  assert.equal(resolutions, 9);
});

for (const [label, age, fresh] of [
  ["fresh after 30 seconds", 30_000, true],
  ["stale after 61 seconds", 61_000, false],
  ["stale when the clock moves back one hour", -3_600_000, false],
]) {
  test(`loader cache is ${label}`, async (t) => {
    let now = 1_800_000_000_000;
    t.mock.method(Date, "now", () => now);
    const load = createUsageLoader();
    const ctx = authContext();
    const first = await load(ctx);
    now += age;
    assert.equal((await load(ctx)) === first, fresh);
  });
}

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

// ---- Grok: xAI is the only source ----

test("Grok product rows that sum to the week render as Bot and Grok API", () => withState(async () => {
  const lines = await runGrokFetch(grokBilling("2030-08-05T01:10:27.629+00:00", "2030-08-12T01:10:27.629+00:00", 28, {
    productUsage: [
      { product: "GrokBot", usagePercent: 23 },
      { product: "Api", usagePercent: 5 },
    ],
  }));
  const row = (label) => lines.find((text) => text.trimStart().startsWith(`${label} `));
  assert.match(row("Week (credits)"), /\s28% reset /);
  assert.match(row("Bot"), /\s23%$/);
  assert.match(row("Grok API"), /\s5%$/);
}));

test("the loader has no Grok Bot block and never asks for a Cursor login", async () => {
  await withFetch(async (url) => { throw new Error(`unexpected request ${url}`); }, async () => {
    const data = await createUsageLoader({})({ modelRegistry: { getProviderAuth: async () => undefined } }, true);
    assert.deepEqual(data.blocks.map((block) => block.name), ["Claude", "Codex", "Kimi", "Grok", "Copilot", "GLM", "MiniMax"]);
    for (const rendered of [renderContent(data), renderContent({ ...data, all: true })]) {
      assert.doesNotMatch(rendered, /Grok Bot|\/login cursor/i);
    }
  });
});

// ---- Missing readings are never numbers ----

const UNAVAILABLE = /window reported, reading unavailable$/;

test("missing percentages render as unavailable, never as 0% or 100%", async () => {
  for (const missing of [null, "", "  ", true, "n/a", {}]) {
    await withFetch(claudeFetch({
      seven_day: { utilization: missing, resets_at: inHours(72) },
      limits: [{ group: "weekly", scope: { model: { display_name: "Fable" } }, percent: missing, resets_at: inHours(72) }],
    }), async () => {
      const lines = await fetchAnthropic(authContext({ anthropic: oauth() }));
      assert.match(lines.find((row) => row.includes("Week (all models)")), UNAVAILABLE);
      assert.match(lines.find((row) => row.includes("Week (Fable)")), UNAVAILABLE);
    });
    await withFetch(async (url) => json(String(url).endsWith("rate-limit-reset-credits") ? { credits: [] } : {
      rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent: missing, reset_at: 1786500000 } },
    }), async () => {
      const lines = await fetchCodex(authContext({ "openai-codex": oauth(jwt()) }));
      assert.match(lines.find((row) => row.trimStart().startsWith("Week ")), UNAVAILABLE);
    });
    await withFetch(async () => json({ usage: { used: missing, limit: 300, resetTime: "2030-08-15T12:00:00Z" } }), async () => {
      const lines = await fetchKimi(authContext({ "kimi-coding": oauth() }));
      assert.match(lines.find((row) => row.trimStart().startsWith("Week ")), UNAVAILABLE);
    });
    await withFetch(async () => json({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: missing, unit: 3, number: 5 }] } }), async () => {
      const lines = await fetchGlm(authContext({ zai: { source: "apiKey", auth: { apiKey: "zai-key" } } }));
      assert.match(lines.find((row) => row.includes("Session (5h)")), UNAVAILABLE);
    });
  }
});

test("Grok without a weekly percent keeps the monthly fallback or reports the week as unavailable", () => withState(async () => {
  const monthly = await runGrokFetch({ config: {
    isUnifiedBillingUser: true,
    creditUsagePercent: null,
    monthlyLimit: { val: 100 },
    used: { val: 25 },
    billingPeriodStart: "2030-08-01T00:00:00Z",
    billingPeriodEnd: "2030-09-01T00:00:00Z",
  } });
  assert.match(monthly.join("\n"), /Month \(credits\).*25%/);
  assert.doesNotMatch(monthly.join("\n"), /Week \(credits\)/);

  const weekly = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], null, {
    productUsage: [{ product: "GrokBot", usagePercent: null }, { product: "Api", usagePercent: "" }],
  }));
  assert.match(weekly.find((row) => row.includes("Week (credits)")), UNAVAILABLE);
  assert.ok(!weekly.some((row) => /^\s*(Bot|Grok API) /.test(row)));
}));

test("missing percentages fall back to valid counts", async () => {
  await withFetch(async () => json(minimaxFixture({
    current_interval_total_count: 100,
    current_interval_usage_count: 80,
    current_interval_remaining_percent: null,
  })), async () => {
    const lines = await fetchMinimax(authContext({ minimax: { source: "apiKey", auth: { apiKey: "mm-key" } } }));
    assert.match(lines.find((row) => row.includes("Session (5h)")), /\s20% reset .* · 20\/100$/);
  });
  const user = {
    ...copilotUser,
    quota_snapshots: { ...copilotUser.quota_snapshots, premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: null } },
  };
  await withFetch(async () => json(user), async () => {
    const lines = await fetchCopilot(copilotCtx, { readCredential: async () => copilotCredential() });
    assert.match(lines.find((row) => row.includes("Premium requests")), /\s20% reset .* · 60\/300$/);
  });
  const free = {
    access_type_sku: "free_limited_copilot",
    monthly_quotas: { chat: 50, completions: 2000 },
    limited_user_quotas: { chat: null, completions: 1500 },
    limited_user_reset_date: "2030-09-01",
  };
  await withFetch(async () => json(free), async () => {
    const lines = await fetchCopilot(copilotCtx, { readCredential: async () => copilotCredential() });
    assert.match(lines.find((row) => row.trimStart().startsWith("Chat ")), UNAVAILABLE);
    assert.match(lines.find((row) => row.trimStart().startsWith("Completions ")), /\s25% reset .* · 500\/2,000$/);
  });
  await withFetch(async () => json({ data: { limits: [{ type: "TIME_LIMIT", percentage: null, currentValue: 30, usage: 100 }] } }), async () => {
    const lines = await fetchGlm(authContext({ zai: { source: "apiKey", auth: { apiKey: "zai-key" } } }));
    assert.match(lines.find((row) => row.includes("MCP (month)")), /\s30% · 30\/100$/);
  });
});

test("state writes restrict the saved file to owner read and write", { skip: process.platform === "win32" }, () => withState(async (statePath) => {
  const previousUmask = process.umask(0o022);
  try {
    await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 12), statePath);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
  }
}));

test("state writes use their own temp file, so a stray or shared .tmp cannot block or mix them", () => withState(async (statePath) => {
  mkdirSync(`${statePath}.tmp`); // the old fixed temp name, taken by another writer
  await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 12), statePath);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).xai.pct, 12);
  await Promise.all([10, 20, 30, 40].map((value) => runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], value), statePath)));
  assert.ok(Number.isFinite(JSON.parse(readFileSync(statePath, "utf8")).xai.pct));
  assert.deepEqual(readdirSync(dirname(statePath)).sort(), ["state.json", "state.json.tmp"]);
}));

test("Grok: a detected reset stays visible for the rest of its period and a new period clears it", () => withState(async (statePath) => {
  const first = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 5), statePath, {
    xai: { periodStart: PERIOD_A[0], periodEnd: PERIOD_A[1], pct: 35 },
  });
  const notice = first.find((row) => row.includes("Reset used"));
  assert.match(notice, /\(35% → 5%\)$/);
  const later = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 9), statePath);
  assert.equal(later.find((row) => row.includes("Reset used")), notice);
  const next = await runGrokFetch(grokBilling(PERIOD_B[0], PERIOD_B[1], 2), statePath);
  assert.ok(!next.some((row) => row.includes("Reset used")));
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).xai.resetUsed, undefined);
  // A damaged saved notice is dropped, never rendered.
  const damaged = await runGrokFetch(grokBilling(PERIOD_B[0], PERIOD_B[1], 3), statePath, {
    xai: { periodStart: PERIOD_B[0], periodEnd: PERIOD_B[1], pct: 2, resetUsed: { at: "\u001b[31mnot a date", from: "35", to: {} } },
  });
  assert.ok(!damaged.some((row) => row.includes("Reset used")));
}));

test("a credential lookup that never settles times out without holding the other providers", { timeout: 3000 }, async () => {
  const never = () => new Promise(() => {});
  const ctx = {
    modelRegistry: {
      getProviderAuth: async (provider) => {
        if (provider === "anthropic") return never();
        if (provider === "github-copilot") return { source: "OAuth", auth: { apiKey: "session" } };
        return undefined;
      },
    },
  };
  const data = await createUsageLoader({ readCredential: never, deadlineMs: 50 })(ctx, true);
  for (const name of ["Claude", "Copilot"]) {
    const block = data.blocks.find((entry) => entry.name === name);
    assert.equal(block.status, "error");
    assert.equal(block.detail, "timed out");
  }
  assert.equal(data.blocks.find((entry) => entry.name === "Codex").status, "unconnected");
  assert.match(renderContent(data), /Claude: timed out/);
});

// pi wraps every refresh failure as "OAuth refresh failed for <provider>: <cause>" and keeps the cause.
const refreshFailure = (provider, detail, cause) => new Error(`OAuth refresh failed for ${provider}: ${detail}`, cause && { cause });

test("a refresh failure from the network, a 5xx or a 429 is not a login expiry", async () => {
  const networkCause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const timeoutCause = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const failures = {
    anthropic: refreshFailure("anthropic", "Anthropic token refresh request failed. url=https://example.test/token; details=fetch failed", networkCause),
    "openai-codex": refreshFailure("openai-codex", "OpenAI Codex token refresh error: OpenAI Codex token refresh failed (429): Too Many Requests"),
    "kimi-coding": refreshFailure("kimi-coding", "Kimi Code token refresh failed with status 500: upstream text"),
    xai: refreshFailure("xai", "The operation was aborted due to timeout", timeoutCause),
    "github-copilot": refreshFailure("github-copilot", "503 Service Unavailable: upstream text"),
  };
  const ctx = { modelRegistry: { getProviderAuth: async (provider) => { if (failures[provider]) throw failures[provider]; } } };
  const data = await createUsageLoader()(ctx, true);
  const detail = (name) => data.blocks.find((block) => block.name === name);
  assert.deepEqual(
    ["Claude", "Codex", "Kimi", "Grok", "Copilot"].map((name) => [name, detail(name).status, detail(name).detail]),
    [
      ["Claude", "error", "network error"],
      ["Codex", "error", "rate limited — try again shortly"],
      ["Kimi", "error", "provider error — try again later"],
      ["Grok", "error", "timed out"],
      ["Copilot", "error", "provider error — try again later"],
    ],
  );
  assert.equal(detail("Claude").debug, "credential refresh failed ECONNREFUSED");
  assert.equal(detail("Codex").debug, "credential refresh failed HTTP 429");
  assert.doesNotMatch(JSON.stringify(data), /upstream text|example\.test|Too Many Requests/);
  assert.doesNotMatch(renderContent(data), /login expired/);

  const anthropic5xx = refreshFailure("anthropic", "Anthropic token refresh request failed. url=https://example.test/token; details=HTTP request failed. status=502; url=https://example.test/token; body=");
  const expired = {
    anthropic: anthropic5xx,
    xai: refreshFailure("xai", "xAI OAuth token refresh failed (HTTP 400): invalid_grant: refresh token expired"),
    "kimi-coding": refreshFailure("kimi-coding", "Kimi Code token refresh unauthorized (status 401)"),
  };
  const again = await createUsageLoader()({ modelRegistry: { getProviderAuth: async (provider) => { if (expired[provider]) throw expired[provider]; } } }, true);
  const block = (name) => again.blocks.find((entry) => entry.name === name);
  assert.equal(block("Claude").detail, "provider error — try again later");
  assert.equal(block("Grok").hint, "login expired (/login xai)");
  assert.equal(block("Kimi").hint, "login expired (/login kimi-coding)");
});

test("MiniMax skips a pay-as-you-go key and meters a China-region plan key; plan keys keep global first", async () => {
  const seen = [];
  const capture = async (url, init) => {
    seen.push([new URL(String(url)).host, init.headers.Authorization]);
    return json(minimaxFixture());
  };
  const apiKey = (key) => ({ source: "apiKey", auth: { apiKey: key } });
  await withFetch(capture, async () => {
    const lines = await fetchMinimax(authContext({ minimax: apiKey("sk-api-payg"), "minimax-cn": apiKey("cn-plan-key") }));
    assert.equal(lines[0], "MiniMax (token plan)");
    await fetchMinimax(authContext({ minimax: apiKey("global-plan-key"), "minimax-cn": apiKey("cn-plan-key") }));
  });
  assert.deepEqual(seen, [["api.minimaxi.com", "Bearer cn-plan-key"], ["api.minimax.io", "Bearer global-plan-key"]]);
});

test("a non-list GLM limits or Grok productUsage does not blank the block", () => withState(async () => {
  for (const value of [{}, 7, "limits"]) {
    await withFetch(async () => json({ data: { level: "lite", limits: value } }), async () => {
      const lines = await fetchGlm(authContext({ zai: { source: "apiKey", auth: { apiKey: "zai-key" } } }));
      assert.deepEqual(lines, ["GLM (lite plan)"]);
    });
    const grok = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 28, { productUsage: value }));
    assert.match(grok.find((row) => row.includes("Week (credits)")), /28%/);
    assert.equal(grok.length, 2);
  }
}));

test("a missing Grok on-demand reading is unavailable, never 0%", () => withState(async () => {
  for (const onDemandUsed of [undefined, null, { val: null }, { val: "" }, { val: true }]) {
    const lines = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 28, { onDemandCap: { val: 100 }, onDemandUsed }));
    assert.match(lines.find((row) => row.includes("On-demand")), /window reported, reading unavailable$/);
  }
  const zero = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 28, { onDemandCap: { val: 100 }, onDemandUsed: { val: 0 } }));
  assert.match(zero.find((row) => row.includes("On-demand")), / 0%$/);
  const noCap = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 28, { onDemandCap: { val: null }, onDemandUsed: { val: null } }));
  assert.ok(!noCap.some((row) => row.includes("On-demand")));
}));

// ---- Rendered layout: what pi shows, colours removed ----

const renderedRows = (data) => renderContent(data).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
const indentOf = (row) => row.length - row.trimStart().length;
const barColumn = (row) => row.search(/[█░]/);

test("rendered rows sit 2 spaces under the header, Grok slices 4, with every bar in one column", () => withState(async () => {
  const claude = await withFetch(
    claudeFetch({ five_hour: { utilization: 37, resets_at: inHours(2) }, seven_day: week, extra_usage: { credits_ever_enabled: true, is_enabled: false, used_credits: 0, monthly_limit: 2000, currency: "GBP" } }, pro),
    () => fetchAnthropic(authContext({ anthropic: oauth() })),
  );
  const sliced = await runGrokFetch(grokBilling(PERIOD_A[0], PERIOD_A[1], 28, {
    productUsage: [{ product: "GrokBot", usagePercent: 23 }, { product: "Api", usagePercent: 5 }],
  }));
  const mismatched = await runGrokFetch(grokBilling(PERIOD_B[0], PERIOD_B[1], 17, {
    productUsage: [{ product: "GrokBot", usagePercent: 10 }, { product: "Imagine", usagePercent: 2 }],
  }));
  for (const [lines, slices] of [[claude, []], [sliced, ["Bot", "Grok API"]], [mismatched, []]]) {
    const [header, ...body] = renderedRows({ blocks: [{ name: "Grok", lines }] });
    assert.equal(indentOf(header), 0, header);
    for (const row of body) {
      const slice = slices.some((name) => row.trimStart().startsWith(`${name} `));
      assert.equal(indentOf(row), slice ? 4 : 2, row);
    }
    const bars = body.filter((row) => barColumn(row) >= 0);
    assert.ok(bars.length >= 2);
    assert.equal(new Set(bars.map(barColumn)).size, 1, bars.join("\n"));
  }
  // Status notes and the footer stay flush left.
  const rows = renderedRows({ blocks: [{ name: "Grok", lines: sliced }, { name: "Kimi", status: "nodata" }], fetchedAt: "2026-11-02T10:00:00Z" });
  assert.deepEqual(rows.slice(-2).map(indentOf), [0, 0]);
  assert.equal(rows.at(-2), "Kimi: no plan data");
}));
