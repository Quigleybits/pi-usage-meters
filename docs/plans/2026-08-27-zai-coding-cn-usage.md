# Z.AI Coding CN Usage Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add `zai-coding-cn` authentication and the China-region GLM quota endpoint while preserving existing `zai` behavior.

**Architecture:** Keep one GLM meter and resolve its region from pi's provider auth registry. Prefer the existing global `zai` provider; when it has no API key, fall back to `zai-coding-cn`, its China quota endpoint, and the raw `Authorization` header required by the official Z.AI usage script.

**Tech Stack:** Node.js ESM, built-in `fetch`, `node:test`, pi model registry authentication.

---

### Task 1: Lock the provider-selection contract with tests

**Files:**
- Modify: `tests/index.test.mjs`

**Step 1: Write the failing China-region test**

Add a test whose auth context contains only:

```js
{
  "zai-coding-cn": {
    source: "apiKey",
    auth: { apiKey: "zai-cn-key" },
  },
}
```

Call `fetchGlm(ctx)` and assert that it requests:

```js
assert.equal(String(url), "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
assert.equal(init.headers.Authorization, "zai-cn-key");
assert.equal(init.headers["Accept-Language"], "en-US,en");
```

Use the China endpoint's observed `TOKENS_LIMIT` shapes (`unit: 3, number: 5` and
`unit: 6, number: 1`) and assert they render as `Session (5h)` and
`Month (tokens)` in the GLM block.

**Step 2: Run the focused test to verify it fails**

Run: `node --test --test-name-pattern="China-region" tests/index.test.mjs`

Expected: FAIL because `fetchGlm` only resolves `zai` and returns the missing-key line.

**Step 3: Add preference and missing-key assertions**

Extend the existing global test with both providers and assert the global endpoint and `Bearer zai-key` remain selected. Extend the missing-key test to assert both `ZAI_API_KEY` and `ZAI_CODING_CN_API_KEY` are named.

**Step 4: Run the focused tests and verify the new assertions fail**

Run: `node --test --test-name-pattern="GLM" tests/index.test.mjs`

Expected: FAIL for the China fallback and the expanded missing-key message while existing global behavior still passes.

### Task 2: Implement regional GLM auth resolution

**Files:**
- Modify: `extensions/core.js`
- Test: `tests/index.test.mjs`

**Step 1: Add the minimal resolver**

Add immutable provider definitions in preference order:

```js
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
```

Resolve each provider with `apiKeyFor`. Return the first configured entry and key.

**Step 2: Send the selected authorization header**

Call `getJson` with an explicit `Authorization` header. Adjust `getJson` header construction so explicit headers override its default Bearer value:

```js
headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers },
```

**Step 3: Update the missing-key line**

Render one safe error naming both accepted environment variables without exposing values:

```text
API key not set (ZAI_API_KEY or ZAI_CODING_CN_API_KEY)
```

**Step 4: Classify China token windows**

Apply the same `unit` / `number` window classification used by credit limits to
`TOKENS_LIMIT`, while retaining `Session (tokens)` for legacy payloads without
window metadata.

**Step 5: Run GLM tests**

Run: `node --test --test-name-pattern="GLM" tests/index.test.mjs`

Expected: all GLM tests PASS.

**Step 6: Run the complete suite**

Run: `npm test`

Expected: all tests PASS with no warnings.

### Task 3: Update operator documentation and probe support

**Files:**
- Modify: `README.md`
- Modify: `scripts/probe-glm-quota.mjs`

**Step 1: Document both provider IDs**

State that GLM accepts either `zai` / `ZAI_API_KEY` or `zai-coding-cn` / `ZAI_CODING_CN_API_KEY`, with global preferred if both are configured.

**Step 2: Document both issuer endpoints and auth boundaries**

Add the China endpoint to the provider table and explain that each API key is sent only to its matching Z.AI domain.

**Step 3: Make the probe region-aware**

Let the development probe select the global key and endpoint first, then the China key and endpoint. Use `Bearer` for global and the raw key for China, matching runtime behavior.

**Step 4: Run syntax and packaging checks**

Run: `npm run check`

Expected: PASS.

Run: `npm pack --dry-run`

Expected: the package contains only the existing published file set and no test secrets or development scripts.

### Task 4: Verify and deliver upstream

**Files:**
- Review: all changed files

**Step 1: Review the diff and secret safety**

Run: `git diff --check`

Run: `git diff -- extensions/core.js tests/index.test.mjs README.md scripts/probe-glm-quota.mjs`

Expected: no whitespace errors, no real credential values, no unrelated changes.

**Step 2: Run final verification**

Run: `npm test`

Run: `npm run check`

Expected: all commands PASS from a clean worktree.

**Step 3: Commit the feature**

```bash
git add docs/plans/2026-08-27-zai-coding-cn-usage.md extensions/core.js tests/index.test.mjs README.md scripts/probe-glm-quota.mjs
git commit -m "feat: support Z.AI Coding CN usage quotas"
```

**Step 4: Fork, push, and open the PR**

Create `LJC-god/pi-usage-meters` if needed, push `feat/zai-coding-cn-usage`, and open a PR against `Quigleybits/pi-usage-meters:main` describing compatibility, endpoint/auth selection, and test evidence.
