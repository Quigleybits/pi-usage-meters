// Dev probe: inspect the GLM/Z.ai quota payload shape without printing values.
// Usage: node scripts/probe-glm-quota.mjs
// Reads ZAI_API_KEY or ZAI_CODING_CN_API_KEY from the environment only,
// Calls the matching undocumented monitor endpoint. Unknown field names are masked.
// Not shipped: excluded via package.json "files".

import { pathToFileURL } from "node:url";

// Provider-controlled names can contain credentials or account identifiers too.
// Preserve only known schema labels; never infer safety from a string's length.
const SAFE_FIELDS = new Set([
  "data", "code", "message", "success", "level", "limits", "type", "percentage",
  "currentValue", "usage", "nextResetTime", "unit", "number", "config",
  "currentPeriod", "start", "end", "billingPeriodStart", "billingPeriodEnd",
  "creditUsagePercent", "monthlyLimit", "val", "isUnifiedBillingUser", "productUsage",
  "product", "usagePercent", "resetsRemaining", "remainingResets", "used",
  "onDemandCap", "onDemandUsed", "prepaidBalance", "subscription_tier_display",
  "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
  "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset",
]);

export function describeShape(value, secrets = [], depth = 0) {
  if (depth > 8) return { type: "truncated" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", items: value.slice(0, 4).map((item) => describeShape(item, secrets, depth + 1)) };
  }
  if (typeof value !== "object") return { type: typeof value };
  return {
    type: "object",
    fields: Object.entries(value).slice(0, 80).map(([name, item]) => ({
      name: SAFE_FIELDS.has(name) && !secrets.some((secret) => secret && name.toLowerCase().includes(secret.toLowerCase()))
        ? name : "[redacted]",
      ...describeShape(item, secrets, depth + 1),
    })),
  };
}

const providers = [
  {
    variable: "ZAI_API_KEY",
    url: "https://api.z.ai/api/monitor/usage/quota/limit",
    authorization: (key) => `Bearer ${key}`,
  },
  {
    variable: "ZAI_CODING_CN_API_KEY",
    url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    authorization: (key) => key,
  },
];
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 2) throw new Error();
    const selected = providers.find((provider) => process.env[provider.variable]?.trim());
    if (!selected) {
      console.error("ZAI_API_KEY or ZAI_CODING_CN_API_KEY is required");
      process.exitCode = 1;
    } else {
      const key = process.env[selected.variable].trim();
      const res = await fetch(selected.url, {
        headers: { Authorization: selected.authorization(key), "Accept-Language": "en-US,en" },
      });
      console.log(`HTTP ${res.status}`);
      console.log(JSON.stringify(describeShape(JSON.parse(await res.text()), [key]), null, 2));
    }
  } catch {
    console.error("quota probe failed (check arguments, credentials and provider response)");
    process.exitCode = 1;
  }
}
