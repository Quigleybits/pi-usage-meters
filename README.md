# pi-usage-meters

A [pi](https://pi.dev) coding agent extension that adds a `/usage` command showing **subscription quota for every provider you're connected to** — one compact, colour-coded block instead of a dashboard per provider. Claude, Codex, Kimi, and Grok authenticate via pi's OAuth; GLM uses either `ZAI_API_KEY` (`zai`) or `ZAI_CODING_CN_API_KEY` (`zai-coding-cn`); MiniMax token plans use `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`; DeepSeek balances use `DEEPSEEK_API_KEY`.

![Colour-coded usage meters for Claude, Codex, Kimi, Grok, and GLM (real fixture data)](https://raw.githubusercontent.com/Quigleybits/pi-usage-meters/main/assets/pi-usage.png)

Each provider block is colour-coded on your terminal's existing background, bars fill left-to-right with usage, and the pie glyph (`○ ◔ ◑ ◕ ●`) fills as the quota window elapses toward reset. The entry renders in the transcript but never enters LLM context.

## Install

```bash
pi install npm:pi-usage-meters
```

Try without installing:

```bash
pi -e npm:pi-usage-meters
```

Then run `/usage` in any pi session. Results are cached in memory for 60 seconds; use `/usage --refresh` to bypass the cache. No extension-specific configuration is needed — OAuth credentials come from pi's own auth store (`/login`) and refresh automatically. The GLM meter resolves either `zai` / `ZAI_API_KEY` or `zai-coding-cn` / `ZAI_CODING_CN_API_KEY` from the same auth registry; if both are configured, the existing global `zai` provider takes precedence.

Only providers you are connected to get a block. Everything else collapses into one dim footer line — `not connected: Codex · Kimi`, `Claude: login expired (/login anthropic)`, `Codex: timed out (8s)` — so an account you do not have never shows up as an error. `/usage --all` lists the per-provider login hints as blocks instead.

## Providers & endpoints

| Provider | Plan label source | Quota endpoint |
|---|---|---|
| Claude (`anthropic`) | `api.anthropic.com/api/oauth/profile` | `api.anthropic.com/api/oauth/usage` |
| Codex (`openai-codex`) | plan from usage payload | `chatgpt.com/backend-api/wham/usage` + `.../rate-limit-reset-credits` |
| Kimi (`kimi-coding`) | membership level from usage payload | `api.kimi.com/coding/v1/usages` |
| GLM (`zai`, `zai-coding-cn`) | plan level from usage payload | Global: `api.z.ai/api/monitor/usage/quota/limit`; China: `open.bigmodel.cn/api/monitor/usage/quota/limit` (coding-plan windows: 5h session plus weekly or monthly, classified from the payload's `unit`/`number`; an explicit 7-day window renders as `Week`) |
| Grok (`xai`) | `cli-chat-proxy.grok.com/v1/settings` | `cli-chat-proxy.grok.com/v1/billing?format=credits` (weekly SuperGrok pool; monthly shape kept as fallback) + redeemed-reset detection |
| MiniMax (`minimax`, `minimax-cn`) | token plan vs pay-as-you-go from the key type | Global: `api.minimax.io/v1/token_plan/remains`; China: `api.minimaxi.com/v1/token_plan/remains` (5h session + weekly window per model family, same contract as the official MiniMax CLI); `sk-api-` keys query `/account/query_balance` instead |
| DeepSeek (`deepseek`) | pay-as-you-go | `api.deepseek.com/user/balance` (documented; balance only, no quota windows) |

## Privacy & security

- OAuth access tokens come from **pi's auth store only** (`ctx.modelRegistry.getProviderAuth`). The GLM meter resolves `zai` and `zai-coding-cn` API keys the same way and sends each key **only** to its matching issuer (`api.z.ai` or `open.bigmodel.cn`) — never to another provider's endpoint. The same holds for MiniMax (`api.minimax.io` / `api.minimaxi.com`, the hosts pi already sends those keys to) and DeepSeek (`api.deepseek.com`).
- The Grok reset-detection feature persists a small state file at `~/.pi/agent/usage-meters-state.json` (override: `PI_USAGE_METERS_STATE`). It contains only the last-seen Grok weekly period boundaries, pool percentage, and a timestamp — no tokens, no secrets, no other providers. It is written atomically, deletable at any time, and never leaves the machine.
- Codex's non-secret account ID is decoded from the OAuth JWT; this package never opens `~/.pi/agent/auth.json`.
- Credentials are used solely in the `Authorization` header on the provider's own HTTPS quota endpoints. OAuth providers and global Z.AI use `Bearer`; Z.AI Coding CN uses the raw API-key value required by its endpoint. Credentials are never logged, rendered, or written into session entries. Remote error bodies are not persisted.
- API responses are size-limited; untrusted strings are length-limited and stripped of terminal controls, ANSI, and bidirectional-text controls both before storage and again at render time.
- Each provider fetch is isolated: one failure never blanks the others.

**Privacy note:** `/usage` stores plan labels, quota percentages, reset times, and any displayed spend figures in the current pi session. Exporting or sharing that session includes this output. Do not share the session if those account details are sensitive. The README screenshot uses synthetic fixture values, not live account data.

## Notes & caveats

- These quota endpoints are **undocumented** and may change without notice; each provider fetch is isolated and fails soft.
- A provider that stalls is cut off after 8 s — one budget per provider, optional follow-up calls included — and reported as `timed out (8s)` in the footer line; the other meters still render. A connected account with no quota windows (no active plan) shows as `no plan data`.
- MiniMax's `*_usage_count` fields historically meant *remaining*; when the payload carries `*_remaining_percent` the meter uses it to pick the right reading (mirroring the official MiniMax CLI), and a weekly boost (`weekly_boost_permille`) is applied the same way. Models flagged "not in plan" are skipped; the shared `general` bucket is the primary meter and a window the server flags as exhausted (`status` 2) renders as 100% used even if its percent is stale. The API reports auth failures in-band (HTTP 200 with `status_code` 1004 or 2049), which the meter maps to `API key rejected`.
- GitHub Copilot premium-request meters are not supported yet: pi's extension API exposes only the Copilot session token, while `api.github.com/copilot_internal/user` needs the GitHub OAuth token that pi keeps private. This needs an upstream pi API before it can be added safely.
- Codex banked-reset lookup currently sends `OpenAI-Beta: codex-1` and `originator: Codex Desktop`, matching the existing Codex client endpoint contract. Review this compatibility choice if OpenAI publishes an official replacement.
- Grok SuperGrok usage is the shared weekly credit pool (`creditUsagePercent`), with optional per-product split (Build/Chat/Imagine). Legacy monthly credit totals remain as a fallback if the weekly payload is absent.
- Grok usage-reset credits are served only to the grok.com web app (a cookie-authenticated Connect RPC, `prod_mc_billing.ConsumerUiSvc/GetRemainingResets`); the OAuth-reachable billing API never reports them. The meter therefore **detects redeemed resets by inference**: within one weekly period the pool percentage only climbs, so a drop of 5+ points while the period is unchanged is reported as `Reset used 21 Aug (35% → 5%)`. This needs a small state file (see Privacy). It is inference — an xAI-side recomputation could in theory produce the same signature. If xAI ever exposes explicit counts (`resetsRemaining`), they are rendered as `Resets N available` and take precedence in spirit. `scripts/probe-grok-billing.mjs` (repo only, not shipped) dumps the sanitized payload for re-checking.
- The state file path defaults to `~/.pi/agent/usage-meters-state.json` and can be overridden with the `PI_USAGE_METERS_STATE` environment variable. Delete the file at any time; the meter simply re-seeds a baseline on the next `/usage` (no reset line is reported for the first observation).
- The pie glyph uses `○ ◔ ◑ ◕ ●` from the Unicode Geometric Shapes block so a single font renders all states uniformly.
- Requires a pi version with OAuth login support for the providers you use (`/login anthropic`, `/login openai-codex`, `/login kimi-coding`, `/login xai`).

## Development

Runtime code has no installed dependencies: pi supplies the `@earendil-works/pi-tui` peer. `extensions/index.js` is the small pi adapter; provider, formatting, caching, and security logic lives in `extensions/core.js`.

```bash
npm test
npm run check
pi -e ./extensions/index.js
```

## License

MIT
