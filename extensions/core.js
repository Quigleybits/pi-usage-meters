const TIMEOUT_MS = 8_000;
const OPTIONAL_TIMEOUT_MS = 2_500;
const CACHE_MS = 60_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RENDER_LINE = 300;
const LABEL_W = 22;
const H5 = 5 * 3600e3;
const D7 = 7 * 86400e3;
const RESET_DROP_PCT = 5;

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const stateFilePath = () =>
  process.env.PI_USAGE_METERS_STATE || join(homedir(), ".pi", "agent", "usage-meters-state.json");

async function readUsageState() {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeUsageState(state) {
  try {
    const path = stateFilePath();
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, path);
  } catch {
    // State persistence is best-effort; /usage must never fail because of it.
  }
}

export const RESET = "\x1b[0m";
export const STAMP = "\x1b[2;38;2;138;138;138m";

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};

export const COLORS = {
  Claude: rgb("#d77757"),
  Codex: "", // terminal default foreground: pure white vanishes on light themes
  Kimi: rgb("#4fa8ff"),
  Grok: rgb("#8a8a8a"),
  GLM: rgb("#9b8cff"),
  MiniMax: rgb("#e0457b"),
  DeepSeek: rgb("#5b6cff"),
  Copilot: rgb("#2ea043"),
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
  const clock = Number.isFinite(resetMs)
    ? Number.isFinite(windowMs) && windowMs > 0
      ? ` reset ${pie(windowMs, resetMs)} ${fmtReset(resetMs)}`
      : ` reset ${fmtReset(resetMs)}`
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

// Thrown by a fetcher when the user holds no credential for that provider. fetchAll turns it into
// a "not connected" status, which renders as part of one dim footer line — never as a block.
export class NotConnected extends Error {
  constructor(hint) {
    super("not connected");
    this.name = "NotConnected";
    this.hint = hint;
  }
}

const noAuth = (login) => new NotConnected(`/login ${login}`);

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
      redirect: "error", // a quota endpoint never redirects; never carry a credential to a second host
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers },
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

// Thrown when pi cannot resolve a provider's credential — typically an OAuth refresh that failed
// because the refresh token itself has expired. Only a fixed hint is ever rendered, never the reason.
export class LoginFailed extends Error {
  constructor(provider, reason) {
    super("login failed");
    this.name = "LoginFailed";
    this.provider = provider;
    this.expired = /expired|invalid_grant|revoked|re-?authenticate|refresh/i.test(String(reason?.message ?? reason ?? ""));
  }
}

async function providerAuth(ctx, provider) {
  try {
    return await ctx.modelRegistry.getProviderAuth(provider);
  } catch (error) {
    throw new LoginFailed(provider, error);
  }
}

export async function tokenFor(ctx, provider) {
  const result = await providerAuth(ctx, provider);
  if (result?.source !== "OAuth") return undefined;
  if (typeof result.auth?.apiKey === "string" && result.auth.apiKey) return result.auth.apiKey;
  const headers = result.auth?.headers;
  const authorization = typeof headers?.get === "function"
    ? headers.get("authorization")
    : Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  const match = typeof authorization === "string" && authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

// zai is an API-key provider (ZAI_API_KEY), not OAuth — accept the key from any auth source.
export async function apiKeyFor(ctx, provider) {
  const result = await providerAuth(ctx, provider);
  const key = typeof result?.auth?.apiKey === "string" ? result.auth.apiKey : "";
  return key.trim() || undefined;
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

// Optional follow-up calls never extend a provider past its budget: they get the smaller of their own
// cap and whatever remains of the provider's deadline, and are skipped once that is spent.
const optionalJson = (url, token, headers, budgetMs = OPTIONAL_TIMEOUT_MS) => {
  const timeoutMs = Math.min(OPTIONAL_TIMEOUT_MS, budgetMs);
  if (!(timeoutMs > 0)) return Promise.resolve(null);
  return getJson(url, token, headers, timeoutMs).catch(() => null);
};

export async function fetchAnthropic(ctx) {
  const token = await tokenFor(ctx, "anthropic");
  if (!token) throw noAuth("anthropic");
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

export async function fetchCodex(ctx, { clock = Date.now } = {}) {
  const token = await tokenFor(ctx, "openai-codex");
  if (!token) throw noAuth("openai-codex");
  const deadline = clock() + TIMEOUT_MS; // one budget for the whole provider, follow-up calls included
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
    }, deadline - clock());
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
  if (!token) throw noAuth("kimi-coding");
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

function grokProductLabel(product) {
  const raw = clean(String(product ?? "").replace(/^Grok/i, ""), 20);
  return raw || "product";
}

export async function fetchXai(ctx) {
  const token = await tokenFor(ctx, "xai");
  if (!token) throw noAuth("xai");
  // SuperGrok unified billing is weekly; bare /billing still returns the old monthly shape with 0s.
  const [billing, settings] = await Promise.all([
    getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", token),
    optionalJson("https://cli-chat-proxy.grok.com/v1/settings", token),
  ]);
  const config = billing.config ?? {};
  const lines = [header("Grok", settings?.subscription_tier_display)];
  const start = Date.parse(config.currentPeriod?.start ?? config.billingPeriodStart);
  const end = Date.parse(config.currentPeriod?.end ?? config.billingPeriodEnd);
  const periodMs = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : D7;
  const creditPct = Number(config.creditUsagePercent);
  const weekly =
    config.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY"
    || config.isUnifiedBillingUser === true
    || Number.isFinite(creditPct);

  if (weekly) {
    lines.push(line("Week (credits)", Number.isFinite(creditPct) ? creditPct : 0, end, periodMs));
    for (const product of (config.productUsage ?? []).slice(0, 8)) {
      const productPct = Number(product?.usagePercent);
      if (!Number.isFinite(productPct)) continue;
      lines.push(line(grokProductLabel(product.product), productPct));
    }

    // Reset credits are web-session-only at xAI (ConsumerUiSvc), so the meter infers
    // a redeemed reset: within one weekly period usage only climbs — a drop is a reset.
    const startIso = config.currentPeriod?.start ?? config.billingPeriodStart;
    const endIso = config.currentPeriod?.end ?? config.billingPeriodEnd;
    if (Number.isFinite(creditPct) && startIso && endIso) {
      const state = await readUsageState();
      const prev = state.xai;
      if (
        prev?.periodStart === startIso && prev?.periodEnd === endIso
        && Number.isFinite(Number(prev.pct)) && prev.pct - creditPct >= RESET_DROP_PCT
      ) {
        lines.push(plain("Reset used", `${fmtDay(Date.now())} (${Math.round(prev.pct)}% → ${Math.round(creditPct)}%)`));
      }
      for (const key of ["resetsRemaining", "remainingResets"]) {
        const count = Math.trunc(Number(config[key]));
        if (Number.isFinite(count) && count > 0) {
          lines.push(plain("Resets", `${count} available`));
          break;
        }
      }
      state.xai = { periodStart: startIso, periodEnd: endIso, pct: creditPct, seenAt: new Date().toISOString() };
      await writeUsageState(state);
    }
  } else {
    const limit = Number(config.monthlyLimit?.val);
    const used = Number(config.used?.val);
    if (Number.isFinite(limit) && limit > 0) {
      lines.push(line("Month (credits)", pct(used, limit), end, periodMs));
    } else if (Number.isFinite(used)) {
      lines.push(plain("Month (credits)", `${used.toLocaleString()} used (no limit reported)`));
    }
    // Neither a limit nor a used figure means no plan on this account: the bare header reads as "no plan data".
  }

  const onDemandCap = Number(config.onDemandCap?.val);
  const onDemandUsed = Number(config.onDemandUsed?.val);
  if (Number.isFinite(onDemandCap) && onDemandCap > 0) {
    lines.push(line("On-demand", pct(onDemandUsed, onDemandCap)));
  } else if (Number.isFinite(onDemandUsed) && onDemandUsed > 0) {
    lines.push(plain("On-demand", `${onDemandUsed.toLocaleString()} used`));
  }

  const prepaid = Number(config.prepaidBalance?.val);
  if (Number.isFinite(prepaid) && prepaid > 0) {
    lines.push(plain("Prepaid balance", prepaid.toLocaleString()));
  }
  return lines;
}

// GLM coding plan: monitor endpoints used by the official zai-coding-plugins
// (undocumented, may change). Keep global first for backward compatibility.
const GLM_PROVIDERS = [
  {
    provider: "zai",
    endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
    authorization: (key) => `Bearer ${key}`,
  },
  {
    provider: "zai-coding-cn",
    endpoint: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    authorization: (key) => key,
  },
];

async function glmAuthFor(ctx) {
  for (const config of GLM_PROVIDERS) {
    // Older pi builds do not know zai-coding-cn; an unknown-provider throw simply means "no key here".
    const key = await apiKeyFor(ctx, config.provider).catch(() => undefined);
    if (key) return { ...config, key };
  }
  return undefined;
}

export async function fetchGlm(ctx) {
  const auth = await glmAuthFor(ctx);
  if (!auth) throw new NotConnected("set ZAI_API_KEY or ZAI_CODING_CN_API_KEY");
  const res = await getJson(auth.endpoint, auth.key, {
    Authorization: auth.authorization(auth.key),
    "Accept-Language": "en-US,en",
  });
  const data = res?.data ?? res;
  const level = clean(String(data?.level ?? "").toLowerCase(), 24);
  const lines = [header("GLM", level ? `${level} plan` : undefined)];
  const counts = (current, total) => {
    const c = Number(current);
    const t = Number(total);
    return Number.isFinite(c) && Number.isFinite(t) && t > 0 ? ` · ${c.toLocaleString()}/${t.toLocaleString()}` : "";
  };
  for (const limit of (data?.limits ?? []).slice(0, 6)) {
    const type = String(limit?.type ?? "");
    const percent = clampPct(Number(limit?.percentage));
    // API may send epoch-ms or an ISO string; Number() on an ISO string is NaN.
    const rawReset = limit?.nextResetTime;
    const resetMs = typeof rawReset === "number" ? rawReset : Date.parse(String(rawReset ?? ""));
    const UNIT_MS = { 1: 1e3, 2: 60e3, 3: 3600e3, 4: 86400e3, 5: D7, 6: 30 * 86400e3 };
    const unit = Number(limit?.unit);
    const number = Number(limit?.number);
    const windowMs = unit > 0 && number > 0 ? (UNIT_MS[unit] ?? 0) * number : NaN;
    const isSession = Number.isFinite(windowMs)
      ? windowMs <= 86400e3
      : Number.isFinite(resetMs) && resetMs - Date.now() <= 86400e3;
    // Long windows: the coding plan has weekly model quotas as well as monthly ones. Only an explicit
    // 7-day unit/number is labelled Week — a reset horizon alone cannot tell a week from a month's tail.
    const period = windowMs === D7 ? "Week" : "Month";
    if (type === "TOKENS_LIMIT") {
      const label = Number.isFinite(windowMs)
        ? (isSession ? windowLabel(windowMs) : `${period} (tokens)`)
        : "Session (tokens)";
      lines.push(line(label, percent, resetMs, windowMs));
    } else if (type === "TIME_LIMIT") {
      lines.push(line("MCP (month)", percent, Number.isFinite(resetMs) ? resetMs : NaN)
        + counts(limit.currentValue, limit.usage));
    } else if (type === "CREDIT_LIMIT") {
      // Window shape: unit/number encode the rolling window (verified: {unit:3,number:5}=5h
      // session with NO nextResetTime field; {unit:6,number:1}=monthly with epoch-ms reset).
      // Session when the window itself is short (≤24h); fall back to the reset horizon.
      lines.push(line(isSession ? (Number.isFinite(windowMs) ? windowLabel(windowMs) : "Session (credits)") : `${period} (credits)`, percent, resetMs, windowMs)
        + counts(limit.currentValue, limit.usage));
    }
  }
  return lines;
}

// MiniMax token plan: the endpoint the official MiniMax CLI uses (MiniMax-AI/cli src/client/endpoints.ts),
// on the same host pi sends the key to. The API answers HTTP 200 even on auth failure and signals it
// in base_resp.status_code (1004). `*_usage_count` historically meant *remaining*; newer payloads add
// `*_remaining_percent`, which decides the interpretation (mirrors the CLI's resolveQuotaCounts).
const MINIMAX_PROVIDERS = [
  { provider: "minimax", host: "https://api.minimax.io" },
  { provider: "minimax-cn", host: "https://api.minimaxi.com" },
];

// remaining_percent is authoritative when present (the official CLI renders it even for zero-total,
// time-based plans); counts are shown only when a positive total makes them meaningful.
function minimaxWindow(reported, total, remainingPercent, boostPermille, status) {
  const t = Number(total);
  const hasTotal = Number.isFinite(t) && t > 0;
  const r = Number(reported);
  const percent = Number(remainingPercent);
  const boost = Number(boostPermille) > 0 ? Number(boostPermille) / 1000 : 1;
  let remaining = hasTotal && Number.isFinite(r) && r >= 0 && r <= t ? r : NaN; // legacy reading: a remaining count
  if (Number.isFinite(percent) && Number.isFinite(remaining)) {
    const asRemaining = Math.abs((remaining / t) * 100 - percent);
    const asUsed = Math.abs(((t - remaining) / t) * 100 - percent);
    if (Math.min(asRemaining, asUsed) > 1) remaining = NaN; // neither reading matches: counts unknown
    else if (asUsed < asRemaining) remaining = t - remaining;
  }
  const remainingPct = Number.isFinite(percent) ? percent * boost
    : Number.isFinite(remaining) ? (remaining / t) * 100 * boost : NaN;
  const exhausted = Number(status) === 2; // server says the window is spent, whatever a stale percent claims
  if (!Number.isFinite(remainingPct) && !exhausted) return undefined;
  return {
    usedPct: exhausted ? 100 : clampPct(100 - remainingPct),
    counts: Number.isFinite(remaining) ? ` · ${(t - remaining).toLocaleString()}/${t.toLocaleString()}` : "",
  };
}

export async function fetchMinimax(ctx) {
  let auth;
  for (const config of MINIMAX_PROVIDERS) {
    const key = await apiKeyFor(ctx, config.provider).catch(() => undefined);
    if (key) {
      auth = { ...config, key };
      break;
    }
  }
  if (!auth) throw new NotConnected("set MINIMAX_API_KEY or MINIMAX_CN_API_KEY");
  // sk-api- keys are pay-as-you-go secret keys: like the CLI, query the account balance instead of a plan.
  const payg = auth.key.startsWith("sk-api-");
  const res = await getJson(`${auth.host}${payg ? "/account/query_balance" : "/v1/token_plan/remains"}`, auth.key);
  const code = Number(res?.base_resp?.status_code ?? 0);
  if (code === 1004 || code === 2049) throw new Error("HTTP 401"); // in-band auth failures (login fail / invalid api key) → "API key rejected"
  if (code !== 0) throw new Error(`provider status ${code}`);
  const lines = [header("MiniMax", payg ? "pay-as-you-go" : "token plan")];
  if (payg) {
    const amount = clean(res?.available_amount, 20);
    if (amount) lines.push(plain("Balance", `${amount} available`));
    return lines;
  }
  const entries = Array.isArray(res?.model_remains) ? res.model_remains.slice(0, 6) : [];
  const notInPlan = (m) => Number(m?.current_interval_total_count) === 0 && Number(m?.current_weekly_total_count) === 0
    && Number(m?.current_interval_status) === 3 && Number(m?.current_weekly_status) === 3;
  // "general" is the shared text-model bucket in live payloads (the CLI fixture calls it "MiniMax-M*"); it renders first.
  const primary = entries.find((m) => /^(general|MiniMax-M)/i.test(String(m?.model_name ?? ""))) ?? entries[0];
  for (const m of [primary, ...entries.filter((entry) => entry !== primary)]) {
    if (!m || typeof m !== "object" || notInPlan(m)) continue;
    const interval = minimaxWindow(m.current_interval_usage_count, m.current_interval_total_count, m.current_interval_remaining_percent, undefined, m.current_interval_status);
    if (m === primary) {
      const windowMs = Number(m.end_time) - Number(m.start_time);
      if (interval) lines.push(line(windowLabel(windowMs), interval.usedPct, Number(m.end_time), windowMs) + interval.counts);
      const weekly = Number(m.current_weekly_status) === 3 // 3 = weekly quota unlimited
        ? undefined
        : minimaxWindow(m.current_weekly_usage_count, m.current_weekly_total_count, m.current_weekly_remaining_percent, m.weekly_boost_permille, m.current_weekly_status);
      if (weekly) {
        const weekMs = Number(m.weekly_end_time) - Number(m.weekly_start_time);
        lines.push(line("Week", weekly.usedPct, Number(m.weekly_end_time), weekMs > 0 ? weekMs : D7) + weekly.counts);
      }
    } else if (interval) {
      lines.push(line(clean(m.model_name, 20) || "model", interval.usedPct));
    }
  }
  return lines;
}

// DeepSeek is pay-as-you-go: the documented balance endpoint (api-docs.deepseek.com/api/get-user-balance).
export async function fetchDeepseek(ctx) {
  const key = await apiKeyFor(ctx, "deepseek").catch(() => undefined); // unknown provider on older pi = no key
  if (!key) throw new NotConnected("set DEEPSEEK_API_KEY");
  const res = await getJson("https://api.deepseek.com/user/balance", key);
  const lines = [header("DeepSeek", res?.is_available === false ? "balance unavailable" : "pay-as-you-go")];
  for (const info of (Array.isArray(res?.balance_infos) ? res.balance_infos : []).slice(0, 4)) {
    const total = clean(info?.total_balance, 20);
    if (!total) continue;
    const parts = [`${total} ${clean(info?.currency, 8) || "?"}`];
    const granted = clean(info?.granted_balance, 20);
    const topped = clean(info?.topped_up_balance, 20);
    if (Number(granted) > 0) parts.push(`granted ${granted}`);
    if (Number(topped) > 0) parts.push(`topped up ${topped}`);
    lines.push(plain("Balance", parts.join(" · ")));
  }
  return lines;
}

// GitHub Copilot. The quota endpoint lives on GitHub's API and authenticates the GitHub OAuth token,
// while pi hands extensions only the exchanged Copilot session token. This is the one documented
// exception to "credentials come from getProviderAuth": after getProviderAuth confirms a live OAuth
// login (pi validates and refreshes it there), the stored credential is read through pi's public
// readStoredCredential() — injected by the adapter, never parsed here — and its GitHub token is sent
// only to GitHub's own API host. Header set mirrors pi's Copilot client; the endpoint 403s without a UA.
const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};
const D30 = 30 * 86400e3;
const COPILOT_PLANS = {
  individual: "Pro",
  individual_pro: "Pro+",
  individual_max: "Max",
  individual_edu: "Edu",
  business: "Business",
  enterprise: "Enterprise",
};

async function readPiCredential(providerId) {
  const { readStoredCredential } = await import("@earendil-works/pi-coding-agent");
  return readStoredCredential(providerId);
}

function copilotApiHost(enterpriseUrl) {
  const raw = clean(enterpriseUrl, 200);
  if (!raw) return "api.github.com";
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    if (!host || host === "github.com" || host === "api.github.com") return "api.github.com";
    return host.startsWith("api.") ? host : `api.${host}`;
  } catch {
    return "api.github.com";
  }
}

function copilotPlanLabel(user) {
  if (user?.access_type_sku === "free_limited_copilot") return "Free";
  const plan = String(user?.copilot_plan ?? "");
  return COPILOT_PLANS[plan] ?? (clean(plan, 24) || undefined);
}

export async function fetchCopilot(ctx, { readCredential = readPiCredential } = {}) {
  const session = await providerAuth(ctx, "github-copilot");
  if (session?.source !== "OAuth") throw noAuth("github-copilot");
  const credential = await readCredential("github-copilot");
  const githubToken = typeof credential?.refresh === "string" ? credential.refresh.trim() : "";
  if (!githubToken) throw new Error("login not readable");
  const user = await getJson(`https://${copilotApiHost(credential.enterpriseUrl)}/copilot_internal/user`, githubToken, COPILOT_HEADERS);
  const lines = [header("Copilot", copilotPlanLabel(user))];
  const resetMs = parseTs(user?.quota_reset_date_utc ?? user?.quota_reset_date);
  const snapshots = user?.quota_snapshots && typeof user.quota_snapshots === "object" ? user.quota_snapshots : undefined;
  for (const [key, label] of [["premium_interactions", "Premium requests"], ["chat", "Chat"], ["completions", "Completions"]]) {
    const snap = snapshots?.[key];
    if (!snap || typeof snap !== "object" || snap.unlimited === true) continue;
    const entitlement = Number(snap.entitlement);
    const remaining = Number(snap.remaining ?? snap.quota_remaining);
    const percentRemaining = Number(snap.percent_remaining);
    const usedPct = Number.isFinite(percentRemaining)
      ? clampPct(100 - percentRemaining)
      : entitlement > 0 && Number.isFinite(remaining) ? pct(entitlement - remaining, entitlement) : NaN;
    if (!Number.isFinite(usedPct)) continue;
    const counts = entitlement > 0 && Number.isFinite(remaining)
      ? ` · ${Math.max(0, entitlement - remaining).toLocaleString()}/${entitlement.toLocaleString()}`
      : "";
    const overage = Math.trunc(Number(snap.overage_count));
    lines.push(line(label, usedPct, resetMs, D30) + counts + (overage > 0 ? ` (+${overage.toLocaleString()} overage)` : ""));
  }
  // Copilot Free reports monthly allowances and what is left of them instead of quota snapshots.
  const monthly = user?.monthly_quotas;
  const left = user?.limited_user_quotas;
  if (!snapshots && monthly && typeof monthly === "object" && left && typeof left === "object") {
    const freeReset = parseTs(user?.limited_user_reset_date);
    for (const [key, label] of [["chat", "Chat"], ["completions", "Completions"]]) {
      const limit = Number(monthly[key]);
      const remaining = Number(left[key]);
      if (!(limit > 0) || !Number.isFinite(remaining)) continue;
      const used = Math.max(0, limit - remaining);
      lines.push(line(label, pct(used, limit), freeReset, D30) + ` · ${used.toLocaleString()}/${limit.toLocaleString()}`);
    }
  }
  return lines;
}

const FETCHERS = [
  ["Claude", fetchAnthropic, "anthropic"],
  ["Codex", fetchCodex, "openai-codex"],
  ["Kimi", fetchKimi, "kimi-coding"],
  ["Grok", fetchXai, "xai"],
  ["Copilot", fetchCopilot, "github-copilot"],
  ["GLM", fetchGlm, null], // API-key providers carry no /login target
  ["MiniMax", fetchMinimax, null],
  ["DeepSeek", fetchDeepseek, null],
];

function safeError(error) {
  const message = String(error?.message ?? "");
  const timeout = message.match(/^timed out after (\d+)ms$/);
  if (timeout) return `timed out (${Math.round(Number(timeout[1]) / 1000)}s)`;
  if (/^(HTTP \d{3}|provider status \d{1,6}|response too large|non-JSON response|login not readable)$/.test(message)) return message;
  if (message === "fetch failed") {
    const code = String(error?.cause?.code ?? "");
    return /^[A-Z0-9_]{2,20}$/.test(code) ? `network error (${code})` : "network error";
  }
  return "usage unavailable";
}

// Block shapes: { name, lines } when the provider is connected and reported at least one meter;
// otherwise { name, status, hint | detail } with status unconnected | rejected | nodata | error.
// Status blocks never render as blocks — renderContent folds them into one dim footer line.
async function fetchAll(ctx, deps) {
  return Promise.all(FETCHERS.map(async ([name, fetcher, login]) => {
    try {
      const lines = await fetcher(ctx, deps);
      if (lines.length <= 1) return { name, status: "nodata" };
      return { name, lines };
    } catch (error) {
      if (error instanceof NotConnected) return { name, status: "unconnected", hint: error.hint };
      if (error instanceof LoginFailed) {
        return error.expired
          ? { name, status: "rejected", hint: login ? `login expired (/login ${login})` : "API key rejected" }
          : { name, status: "error", detail: "login check failed" };
      }
      if (error?.message === "HTTP 401") {
        return { name, status: "rejected", hint: login ? `login expired (/login ${login})` : "API key rejected" };
      }
      return { name, status: "error", detail: safeError(error) };
    }
  }));
}

// deps: { readCredential } — pi's readStoredCredential, supplied by the adapter (tests inject a stub).
export function createUsageLoader(deps = {}) {
  let cache;
  let inFlight;
  return async (ctx, refresh = false) => {
    if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const data = { blocks: await fetchAll(ctx, deps), fetchedAt: new Date().toISOString() };
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

const dim = (text) => `${STAMP}${clean(text, MAX_RENDER_LINE)}${RESET}`;

export function renderContent(data) {
  const showAll = data?.all === true;
  const out = [];
  const unconnected = [];
  const notes = [];
  for (const block of (Array.isArray(data?.blocks) ? data.blocks : []).slice(0, FETCHERS.length)) {
    const name = clean(block?.name, 40);
    const color = Object.hasOwn(COLORS, name) ? COLORS[name] : "";
    const lines = Array.isArray(block?.lines) ? block.lines.slice(0, 20) : [];
    if (lines.length) {
      out.push(...lines.map((value) => `${color}${clean(value, MAX_RENDER_LINE)}${RESET}`));
      continue;
    }
    const status = clean(block?.status, 20);
    const hint = clean(block?.hint, 80);
    if (status === "unconnected") {
      if (showAll) out.push(`${color}${name}${RESET}`, `${color}  not connected (${hint})${RESET}`);
      else unconnected.push({ name, hint });
    } else if (status === "rejected") {
      notes.push(`${name}: ${hint || "credential rejected"}`);
    } else if (status === "nodata") {
      notes.push(`${name}: no plan data`);
    } else if (status === "error") {
      notes.push(`${name}: ${clean(block?.detail, 80) || "usage unavailable"}`);
    }
  }
  // Actionable notes (expired logins, errors) come first; the not-connected summary closes the footer.
  if (unconnected.length && (out.length || notes.length)) {
    notes.push(`not connected: ${unconnected.map((entry) => entry.name).join(" · ")}`);
  } else if (unconnected.length) {
    notes.push(`no providers connected — ${unconnected.map((entry) => `${entry.name}: ${entry.hint}`).join(" · ")}`);
  }
  out.push(...notes.map(dim));
  const fetched = new Date(data?.fetchedAt);
  if (Number.isFinite(fetched.getTime())) out.push(dim(`fetched ${fetched.toLocaleTimeString()}`));
  return out.join("\n");
}
