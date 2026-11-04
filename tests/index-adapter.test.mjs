import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = new URL("../", import.meta.url);

async function withAdapter(run, coreSource) {
  const base = mkdtempSync(join(tmpdir(), "usage-adapter-"));
  const originalFetch = globalThis.fetch;
  const originalState = process.env.PI_USAGE_METERS_STATE;
  try {
    process.env.PI_USAGE_METERS_STATE = join(base, "state.json");
    globalThis.fetch = async () => { throw new Error("unexpected request"); };
    writeFileSync(join(base, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(base, "extensions"));
    copyFileSync(new URL("extensions/index.js", REPO), join(base, "extensions", "index.js"));
    const corePath = join(base, "extensions", "core.js");
    if (coreSource === undefined) copyFileSync(new URL("extensions/core.js", REPO), corePath);
    else writeFileSync(corePath, coreSource);
    const packages = {
      "pi-coding-agent": `
        export const credentialReads = [];
        export async function readStoredCredential(provider) {
          credentialReads.push(provider);
          return { type: "oauth", refresh: "synthetic-github-token", access: "synthetic-session-token", expires: 0 };
        }
      `,
      "pi-tui": `
        export class Text {
          constructor(text, x, y) { Object.assign(this, { text, x, y }); }
        }
      `,
    };
    for (const [name, source] of Object.entries(packages)) {
      const dir = join(base, "node_modules", "@earendil-works", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`, type: "module", exports: "./index.js" }));
      writeFileSync(join(dir, "index.js"), source);
    }
    const { default: register } = await import(pathToFileURL(join(base, "extensions", "index.js")).href);
    const sdk = await import(pathToFileURL(join(base, "node_modules", "@earendil-works", "pi-coding-agent", "index.js")).href);
    const { Text } = await import(pathToFileURL(join(base, "node_modules", "@earendil-works", "pi-tui", "index.js")).href);
    await run({ register, sdk, Text, coreUrl: pathToFileURL(corePath).href });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalState === undefined) delete process.env.PI_USAGE_METERS_STATE;
    else process.env.PI_USAGE_METERS_STATE = originalState;
    rmSync(base, { recursive: true, force: true });
  }
}

function recordingPi() {
  const renderers = new Map();
  const commands = new Map();
  const entries = [];
  return {
    renderers, commands, entries,
    registerEntryRenderer: (name, renderer) => renderers.set(name, renderer),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (name, data) => entries.push({ name, data }),
  };
}

test("adapter registers and runs the usage command and renderer with real core", async () => {
  await withAdapter(async ({ register, sdk, Text }) => {
    const pi = recordingPi();
    const notifications = [];
    const requests = [];
    const ctx = {
      ui: { notify: (...args) => notifications.push(args) },
      modelRegistry: {
        getProviderAuth: async (provider) => provider === "github-copilot"
          ? { source: "OAuth", auth: { apiKey: "synthetic-session-token" } } : undefined,
      },
    };
    globalThis.fetch = async (url, init) => {
      requests.push(String(url));
      assert.equal(String(url), "https://api.github.com/copilot_internal/user");
      assert.equal(init.headers.Authorization, "Bearer synthetic-github-token");
      assert.equal(init.redirect, "error");
      return new Response(JSON.stringify({
        copilot_plan: "individual",
        quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 60, percent_remaining: 60, unlimited: false } },
      }));
    };
    register(pi);
    assert.deepEqual([...pi.commands.keys()], ["usage"]);
    assert.deepEqual([...pi.renderers.keys()], ["provider-usage"]);
    const { handler } = pi.commands.get("usage");
    await handler("--unknown --refresh", ctx);
    assert.deepEqual(notifications, [["Usage: /usage [--refresh] [--all]", "warning"]]);
    assert.equal(pi.entries.length, 0);
    assert.equal(requests.length, 0);
    assert.deepEqual(sdk.credentialReads, []);

    await handler(undefined, ctx);
    const first = pi.entries[0];
    assert.equal(first.name, "provider-usage");
    assert.equal(first.data.all, undefined);
    const copilot = first.data.blocks.find((block) => block.name === "Copilot");
    assert.equal(copilot.lines[0], "Copilot (Pro)");
    assert.match(copilot.lines[1], /Premium requests.*40%.*40\/100$/);
    assert.deepEqual(sdk.credentialReads, ["github-copilot"]);
    const render = pi.renderers.get("provider-usage");
    const rendered = render(first);
    assert.ok(rendered instanceof Text);
    assert.equal(rendered.x, 0);
    assert.equal(rendered.y, 0);
    assert.match(rendered.text, /Copilot \(Pro\)/);
    assert.match(rendered.text, /Premium requests.*40%/);
    assert.doesNotMatch(rendered.text, /synthetic-/);
    assert.match(rendered.text, /not connected: Claude/);

    await handler("  --all  ", ctx);
    assert.equal(pi.entries[1].data.all, true);
    assert.equal(pi.entries[1].data.blocks, first.data.blocks);
    assert.match(render(pi.entries[1]).text, /not connected \(\/login anthropic\)/);
    assert.equal(requests.length, 1);

    await handler(" --refresh   --all ", ctx);
    assert.equal(pi.entries[2].data.all, true);
    assert.equal(requests.length, 2);
    await handler("--refresh", ctx);
    assert.equal(pi.entries[3].data.all, undefined);
    assert.equal(requests.length, 3);
    assert.deepEqual(sdk.credentialReads, Array(3).fill("github-copilot"));
  });
});

test("adapter injects the public credential reader into the loader", async () => {
  await withAdapter(async ({ register, sdk, coreUrl }) => {
    register(recordingPi());
    const { loaderDeps } = await import(coreUrl);
    assert.equal(loaderDeps?.readCredential, sdk.readStoredCredential);
    assert.deepEqual(sdk.credentialReads, []);
  }, `
    export let loaderDeps;
    export function createUsageLoader(deps) {
      loaderDeps = deps;
      return async () => ({ blocks: [] });
    }
    export function renderContent() { return ""; }
  `);
});
