# pi-usage-meters

A [pi](https://pi.dev) coding agent extension that adds a `/usage` command showing **subscription quota for every provider you're logged into via pi's OAuth** — one compact, colour-coded block instead of four dashboards.

![Colour-coded usage meters for Claude, Codex, Kimi, and Grok (synthetic fixture data)](https://raw.githubusercontent.com/Quigleybits/pi-usage-meters/b8b83acbd3c41bbca9d8ce0274767e9400a9e459/assets/pi-usage.png)

Each provider block is colour-coded on your terminal's existing background, bars fill left-to-right with usage, and the pie glyph (`○ ◔ ◑ ◕ ●`) fills as the quota window elapses toward reset. The entry renders in the transcript but never enters LLM context.

## Install

```bash
pi install npm:pi-usage-meters
```

Try without installing:

```bash
pi -e npm:pi-usage-meters
```

Then run `/usage` in any pi session. Results are cached in memory for 60 seconds; use `/usage --refresh` to bypass the cache. No configuration needed — OAuth credentials come from pi's own auth store (`/login`) and refresh automatically. API-key credentials are deliberately rejected. Providers without OAuth login show a one-line hint.

## Providers & endpoints

| Provider | Plan label source | Quota endpoint |
|---|---|---|
| Claude (`anthropic`) | `api.anthropic.com/api/oauth/profile` | `api.anthropic.com/api/oauth/usage` |
| Codex (`openai-codex`) | plan from usage payload | `chatgpt.com/backend-api/wham/usage` + `.../rate-limit-reset-credits` |
| Kimi (`kimi-coding`) | membership level from usage payload | `api.kimi.com/coding/v1/usages` |
| Grok (`xai`) | `cli-chat-proxy.grok.com/v1/settings` | `cli-chat-proxy.grok.com/v1/billing?format=credits` (weekly SuperGrok pool; monthly shape kept as fallback) |

## Privacy & security

- OAuth access tokens come from **pi's auth store only** (`ctx.modelRegistry.getProviderAuth`). API-key credentials are never sent to subscription endpoints.
- Codex's non-secret account ID is decoded from the OAuth JWT; this package never opens `~/.pi/agent/auth.json`.
- Tokens are used solely as `Authorization: Bearer` on the provider's own HTTPS quota endpoints. They are never logged, rendered, or written into session entries. Remote error bodies are not persisted.
- API responses are size-limited; untrusted strings are length-limited and stripped of terminal controls, ANSI, and bidirectional-text controls both before storage and again at render time.
- Each provider fetch is isolated: one failure never blanks the others.

**Privacy note:** `/usage` stores plan labels, quota percentages, reset times, and any displayed spend figures in the current pi session. Exporting or sharing that session includes this output. Do not share the session if those account details are sensitive. The README screenshot uses synthetic fixture values, not live account data.

## Notes & caveats

- These quota endpoints are **undocumented** and may change without notice; each provider fetch is isolated and fails soft.
- Codex banked-reset lookup currently sends `OpenAI-Beta: codex-1` and `originator: Codex Desktop`, matching the existing Codex client endpoint contract. Review this compatibility choice if OpenAI publishes an official replacement.
- Grok SuperGrok usage is the shared weekly credit pool (`creditUsagePercent`), with optional per-product split (Build/Chat/Imagine). Legacy monthly credit totals remain as a fallback if the weekly payload is absent.
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
