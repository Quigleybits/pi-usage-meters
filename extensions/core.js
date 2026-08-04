const TIMEOUT_MS = 12_000;
const OPTIONAL_TIMEOUT_MS = 2_500;
const CACHE_MS = 60_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RENDER_LINE = 300;
const LABEL_W = 22;
const H5 = 5 * 3600e3;
const D7 = 7 * 86400e3;

export const RESET = "\x1b[0m";
export const STAMP = "\x1b[2;38;2;138;138;138m";

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};

export const COLORS = {
  Claude: rgb("#d77757"),
  Codex: rgb("#ffffff"),
  Kimi: rgb("#4fa8ff"),
  Grok: rgb("#8a8a8a"),
};

export function clean(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .slice(0, max);
}

export function clampPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

export function bar(value, width = 10) {
  const n = Math.round((clampPct(value) / 100) * width);
  return "█".repeat(n) + "░".repeat(width - n);
}

export function pct(used, limit) {
  const u = Number(used);
  const l = Number(limit);
  return Number.isFinite(u) && Number.isFinite(l) && l > 0 ? clampPct((u / l) * 100) : 0;
}

export function fmtReset(ms) {
  const delta = ms - Date.now();
  if (!Number.isFinite(delta) || delta <= 0) return "soon";
  const minutes = Math.round(delta / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && mins) parts.push(`${mins}m`);
  return parts.join(" ") || "<1m";
}

const PIE = ["○", "◔", "◑", "◕", "●"];
export function pie(windowMs, resetMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(resetMs)) return PIE[0];
  const remaining = Math.max(0, Math.min(1, (resetMs - Date.now()) / windowMs));
  return PIE[Math.round((1 - remaining) * (PIE.length - 1))];
}

const field = (label) => clean(label, LABEL_W).padEnd(LABEL_W);

export function line(label, value, resetMs, windowMs) {
  const usedPct = clampPct(value);
  const clock = Number.isFinite(resetMs) && Number.isFinite(windowMs) && windowMs > 0
    ? ` reset ${pie(windowMs, resetMs)} ${fmtReset(resetMs)}`
    : "";
  return `  ${field(label)} ${bar(usedPct)} ${String(Math.round(usedPct)).padStart(3)}%${clock}`;
}

export function plain(label, text) {
  return `  ${field(label)} ${clean(text, MAX_RENDER_LINE - LABEL_W - 3)}`;
}

const windowLabel = (ms) => {
  const minutes = Math.round(ms / 60e3);
  if (!Number.isFinite(minutes) || minutes <= 0) return "Session";
  if (minutes === D7 / 60e3) return "Week";
  if (minutes % 1440 === 0) return `Session (${minutes / 1440}d)`;
  if (minutes % 60 === 0) return `Session (${minutes / 60}h)`;
  return `Session (${minutes}m)`;
};

const header = (name, plan) => {
  const safe = clean(plan, 80);
  return safe ? `${name} (${safe})` : name;
};

const noAuth = (name, login) => [name, `  OAuth not logged in (/login ${login})`];

async function readTextLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export async function getJson(url, token, headers = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { ...headers, Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new Error("response too large");
    }
    const text = await readTextLimited(res);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("non-JSON response");
    }
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function tokenFor(ctx, provider) {
  const result = await ctx.modelRegistry.getProviderAuth(provider);
  if (result?.source !== "OAuth") return undefined;
  if (typeof result.auth?.apiKey === "string" && result.auth.apiKey) return result.auth.apiKey;
  const headers = result.auth?.headers;
  const authorization = typeof headers?.get === "function"
    ? headers.get("authorization")
    : Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  const match = typeof authorization === "string" && authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function codexAccountId(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return clean(payload?.["https://api.openai.com/auth"]?.chatgpt_account_id, 128) || undefined;
  } catch {
    return undefined;
  }
}

function claudePlanLabel(profile) {
  const tier = profile?.organization?.rate_limit_tier ?? "";
  const match = String(tier).match(/claude_max_(\d+)x/i);
  if (match) return `Max x${match[1]}`;
  if (profile?.account?.has_claude_max || profile?.organization?.organization_type === "claude_max") return "Max";
  return profile?.account?.has_claude_pro ? "Pro" : undefined;
}

function money(value, exponent) {
  const amount = Number(value);
  const exp = Math.max(0, Math.min(6, Math.trunc(Number(exponent) || 0)));
  return Number.isFinite(amount) ? (amount / (10 ** exp)).toFixed(exp) : "?";
}

function fmtDay(ms) {
  const date = new Date(ms);
  return Number.isFinite(date.getTime())
    ? `${date.getDate()} ${date.toLocaleDateString("en-GB", { month: "short" })}`
    : "";
}

function parseTs(value) {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

const optionalJson = (url, token, headers) => getJson(url, token, headers, OPTIONAL_TIMEOUT_MS).catch(() => null);

export async function fetchAnthropic(ctx) {
  const token = await tokenFor(ctx, "anthropic");
  if (!token) return noAuth("Claude", "anthropic");
  const headers = { "anthropic-beta": "oauth-2025-04-20" };
  const [usage, profile] = await Promise.all([
    getJson("https://api.anthropic.com/api/oauth/usage", token, headers),
    optionalJson("https://api.anthropic.com/api/oauth/profile", token, headers),
  ]);
  const lines = [header("Claude", claudePlanLabel(profile))];
  if (usage.five_hour) {
    lines.push(line("Session (5h)", usage.five_hour.utilization, Date.parse(usage.five_hour.resets_at), H5));
  }
  if (usage.seven_day) {
    lines.push(line("Week (all models)", usage.seven_day.utilization, Date.parse(usage.seven_day.resets_at), D7));
  }
  for (const limit of (usage.limits ?? []).slice(0, 10)) {
    if (limit.group === "weekly" && limit.scope?.model?.display_name) {
      lines.push(line(`Week (${limit.scope.model.display_name})`, limit.percent, Date.parse(limit.resets_at), D7));
    }
  }
  if (usage.extra_usage?.credits_ever_enabled) {
    const extra = usage.extra_usage;
    const used = money(
      usage.spend?.used?.amount_minor ?? extra.used_credits,
      usage.spend?.used?.exponent ?? extra.decimal_places ?? 2,
    );
    const limit = money(
      usage.spend?.limit?.amount_minor ?? extra.monthly_limit,
      usage.spend?.limit?.exponent ?? extra.decimal_places ?? 2,
    );
    const currency = clean(usage.spend?.used?.currency ?? extra.currency, 12);
    const state = extra.is_enabled
      ? `${currency} ${used}/${limit}`
      : `disabled (${currency} ${used}/${limit} spent)`;
    lines.push(plain("Extra usage", state));
  }
  return lines;
}

export async function fetchCodex(ctx) {
  const token = await tokenFor(ctx, "openai-codex");
  if (!token) return noAuth("Codex", "openai-codex");
  const accountId = codexAccountId(token);
  const accountHeader = accountId ? { "ChatGPT-Account-Id": accountId } : {};
  const usage = await getJson("https://chatgpt.com/backend-api/wham/usage", token, accountHeader);
  const lines = [header("Codex", usage.plan_type)];
  for (const window of [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window]) {
    if (!window) continue;
    const seconds = Number(window.limit_window_seconds) || 0;
    lines.push(line(windowLabel(seconds * 1000), window.used_percent, Number(window.reset_at) * 1000, seconds * 1000));
  }
  const banked = Math.max(0, Math.trunc(Number(usage.rate_limit_reset_credits?.available_count) || 0));
  if (banked > 0) {
    const visible = Math.min(20, banked);
    const credits = await optionalJson("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", token, {
      ...accountHeader,
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
    });
    const dates = (credits?.credits ?? [])
      .filter((credit) => (credit.status ?? "available") === "available")
      .slice(0, visible)
      .map((credit) => fmtDay(parseTs(credit.expires_at ?? credit.expiresAt)))
      .filter(Boolean);
    const overflow = banked > visible ? `+${banked - visible}` : "";
    const expiry = dates.length ? ` use by: ${dates.join(", ")}` : "";
    lines.push(plain("Banked resets", `${"●".repeat(visible)}${overflow}${expiry}`));
  }
  return lines;
}

export async function fetchKimi(ctx) {
  const token = await tokenFor(ctx, "kimi-coding");
  if (!token) return noAuth("Kimi", "kimi-coding");
  const usage = await getJson("https://api.kimi.com/coding/v1/usages", token);
  const level = clean(String(usage.user?.membership?.level ?? "").replace(/^LEVEL_/i, ""), 40).toLowerCase();
  const lines = [header("Kimi", level)];
  const five = (usage.limits ?? []).slice(0, 10).find((limit) => limit.window?.timeUnit === "TIME_UNIT_MINUTE");
  if (five?.detail) {
    const windowMs = (Number(five.window?.duration) || 300) * 60e3;
    lines.push(line(windowLabel(windowMs), pct(five.detail.used, five.detail.limit), Date.parse(five.detail.resetTime), windowMs));
  }
  if (usage.usage?.limit) {
    lines.push(line("Week", pct(usage.usage.used, usage.usage.limit), Date.parse(usage.usage.resetTime), D7));
  }
  return lines;
}

export async function fetchXai(ctx) {
  const token = await tokenFor(ctx, "xai");
  if (!token) return noAuth("Grok", "xai");
  const [billing, settings] = await Promise.all([
    getJson("https://cli-chat-proxy.grok.com/v1/billing", token),
    optionalJson("https://cli-chat-proxy.grok.com/v1/settings", token),
  ]);
  const config = billing.config ?? {};
  const limit = Number(config.monthlyLimit?.val);
  const used = Number(config.used?.val);
  const lines = [header("Grok", settings?.subscription_tier_display)];
  if (Number.isFinite(limit) && limit > 0) {
    const start = Date.parse(config.billingPeriodStart);
    const end = Date.parse(config.billingPeriodEnd);
    lines.push(line("Month (credits)", pct(used, limit), end, end - start));
  } else {
    lines.push(plain("Month (credits)", `${Number.isFinite(used) ? used.toLocaleString() : "?"} used (no limit reported)`));
  }
  return lines;
}

const FETCHERS = [
  ["Claude", fetchAnthropic],
  ["Codex", fetchCodex],
  ["Kimi", fetchKimi],
  ["Grok", fetchXai],
];

function safeError(error) {
  const message = String(error?.message ?? "");
  if (/^(HTTP \d{3}|timed out after \d+ms|response too large|non-JSON response)$/.test(message)) return message;
  if (message === "fetch failed") {
    const code = String(error?.cause?.code ?? "");
    return /^[A-Z0-9_]{2,20}$/.test(code) ? `network error (${code})` : "network error";
  }
  return "usage unavailable";
}

async function fetchAll(ctx) {
  return Promise.all(FETCHERS.map(async ([name, fetcher]) => {
    try {
      return { name, lines: await fetcher(ctx) };
    } catch (error) {
      return { name, lines: [name, plain("error", safeError(error))] };
    }
  }));
}

export function createUsageLoader() {
  let cache;
  let inFlight;
  return async (ctx, refresh = false) => {
    if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const data = { blocks: await fetchAll(ctx), fetchedAt: new Date().toISOString() };
      cache = { at: Date.now(), data };
      return data;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}

export function renderContent(data) {
  const out = (Array.isArray(data?.blocks) ? data.blocks : []).slice(0, FETCHERS.length).flatMap((block) => {
    const name = clean(block?.name, 40);
    const color = Object.hasOwn(COLORS, name) ? COLORS[name] : COLORS.Codex;
    const lines = Array.isArray(block?.lines) ? block.lines.slice(0, 20) : [];
    return lines.map((value) => `${color}${clean(value, MAX_RENDER_LINE)}${RESET}`);
  });
  const fetched = new Date(data?.fetchedAt);
  if (Number.isFinite(fetched.getTime())) {
    out.push(`${STAMP}fetched ${fetched.toLocaleTimeString()}${RESET}`);
  }
  return out.join("\n");
}
