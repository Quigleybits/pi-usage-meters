import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run the real CLI modules with no network or credential-store access. The child
// supplies VM modules so the production probes need no test-only entry points.
const harness = String.raw`
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";
const input = JSON.parse(readFileSync(0, "utf8"));
const result = { logs: [], errors: [], requests: [], reads: [], directReads: 0, sdkLoads: 0 };
const fakeProcess = {
  argv: ["node", input.script, ...(input.args ?? [])],
  env: input.env ?? {},
  exit(code) { this.exitCode = code; throw new Error("exit requested"); },
};
const context = createContext({
  process: fakeProcess,
  console: {
    log: (...args) => result.logs.push(args.map(String).join(" ")),
    error: (...args) => result.errors.push(args.map(String).join(" ")),
  },
  fetch: async (url, options) => {
    result.requests.push({ url, authorization: options.headers.Authorization });
    if (input.failure === "fetch") throw new Error(input.privateText);
    return {
      status: input.status ?? 200,
      headers: new Headers(input.headers ?? {}),
      text: async () => {
        if (input.failure === "body") throw new Error(input.privateText);
        return input.body ?? JSON.stringify(input.value ?? {});
      },
    };
  },
});
function synthetic(exports) {
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context });
}
const cache = new Map();
async function load(url) {
  if (cache.has(url)) return cache.get(url);
  // Only these source files may be opened by the VM module loader.
  if (!/\/scripts\/probe-(glm-quota|grok-billing)\.mjs$/.test(url)) throw new Error("unexpected module");
  const module = new SourceTextModule(readFileSync(fileURLToPath(url), "utf8"), {
    context, identifier: url,
    initializeImportMeta(meta) { meta.url = url; },
    importModuleDynamically: async (name) => {
      const dependency = await link(name, module);
      if (dependency.status === "unlinked") await dependency.link(link);
      if (dependency.status === "linked") await dependency.evaluate();
      return dependency;
    },
  });
  cache.set(url, module);
  await module.link(link);
  return module;
}
async function link(name, parent) {
  if (name === "./usage-json.mjs") return synthetic({ loadPiSdk: async () => {
    result.sdkLoads++;
    if (input.failure === "sdk") throw new Error(input.privateText);
    return { readStoredCredential: async (provider) => {
      result.reads.push(provider);
      if (input.failure === "credential") throw new Error(input.privateText);
      return input.credential;
    } };
  } });
  if (name === "node:fs/promises") return synthetic({ readFile: async () => {
    result.directReads++;
    return JSON.stringify({ xai: { access: "legacy-synthetic-token-0123456789" } });
  } });
  if (name === "node:os") return synthetic({ homedir: () => "/synthetic-home" });
  if (["node:path", "node:url"].includes(name)) return synthetic(await import(name));
  return load(new URL(name, parent.identifier).href);
}
try { await (await load(pathToFileURL(input.script).href)).evaluate(); }
catch (error) { result.unhandled = error.message; }
result.exitCode = fakeProcess.exitCode ?? 0;
console.log(JSON.stringify(result));
`;

function probe(name, options = {}) {
  const script = fileURLToPath(new URL(`../scripts/probe-${name}.mjs`, import.meta.url));
  const child = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", harness], {
    env: {}, encoding: "utf8", timeout: 10000,
    input: JSON.stringify({ script, ...options }),
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.unhandled, undefined, "the CLI must handle failures safely");
  return result;
}

for (const name of ["glm-quota", "grok-billing"]) {
  const envFor = (token) => name === "glm-quota" ? { ZAI_API_KEY: token } : { XAI_ACCESS_TOKEN: token };

  test(`${name} prints types, masking short tokens, emails and account IDs`, () => {
    const value = {
      data: {
        token: "q", email: "fixture@example.invalid", account_id: 82736451,
        start: "2026-11-04T10:00:00Z fixture@example.invalid",
        limits: [{ percentage: 12, q: "short", "fixture@example.invalid": true, arbitraryAccountId: null }],
        "account-82736451": false,
      },
    };
    const result = probe(name, {
      env: envFor("q"), value,
      headers: { "x-usage-q": "q", "x-ratelimit-limit": "fixture@example.invalid" },
    });
    const output = result.logs.join("\n");
    for (const privateValue of ["fixture@example.invalid", "82736451", "arbitraryAccountId", "2026-11-04", '"q"']) {
      assert.ok(!output.includes(privateValue), `private data escaped: ${privateValue}`);
    }
    assert.match(output, /percentage/);
    assert.match(output, /number/);
    assert.match(output, /string/);
    assert.ok(!output.includes("x-usage-q"));
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].authorization, "Bearer q");
    assert.equal(result.directReads, 0);
    assert.equal(result.sdkLoads, 0);
  });

  test(`${name} masks credentials literally in nested field names`, () => {
    const result = probe(name, { env: envFor(".*"), value: { data: [{ ".*": ".*", limits: [".*"] }] } });
    assert.ok(!result.logs.join("\n").includes(".*"));
    assert.match(result.logs.join("\n"), /limits/);
  });

  test(`${name} masks credentials even when they overlap known schema names`, () => {
    for (const [token, field] of [["data", "data"], ["s", "success"], ["LIMIT", "limits"]]) {
      const result = probe(name, {
        env: envFor(token), value: { [field]: [{ start: true }] },
        headers: { "x-ratelimit-limit": token },
      });
      const shape = JSON.parse(result.logs.at(-1));
      assert.equal(shape.fields[0].name, "[redacted]");
      if (token === "s") assert.equal(shape.fields[0].items[0].fields[0].name, "[redacted]");
      if (name === "grok-billing" && token === "LIMIT") {
        const headers = JSON.parse(result.logs.find((line) => line.startsWith("headers:")).slice("headers:".length));
        assert.equal(headers.fields[0].name, "[redacted]");
      }
    }
  });

  test(`${name} preserves separate fields when their names are all masked`, () => {
    const result = probe(name, { env: envFor("q"), body: '{"__proto__":"private","constructor":null,"account-82736451":12}' });
    const shape = JSON.parse(result.logs.at(-1));
    assert.deepEqual(shape.fields, [
      { name: "[redacted]", type: "string" },
      { name: "[redacted]", type: "null" },
      { name: "[redacted]", type: "number" },
    ]);
  });

  for (const failure of ["non-json", "fetch", "body"]) {
    test(`${name} hides private ${failure} diagnostics`, () => {
      const privateText = "synthetic-private-token fixture@example.invalid account-82736451";
      const result = probe(name, {
        env: envFor("q"), privateText,
        failure: failure === "non-json" ? undefined : failure,
        body: failure === "non-json" ? privateText : undefined,
      });
      const output = JSON.stringify(result.logs.concat(result.errors));
      for (const part of privateText.split(" ")) assert.ok(!output.includes(part), `private data escaped: ${part}`);
      assert.equal(result.exitCode, 1);
      assert.ok(result.errors.length > 0);
    });
  }

  test(`${name} rejects unsupported options before credentials or requests`, () => {
    for (const option of ["--explore", "--resets", "--unknown=fixture@example.invalid"]) {
      const result = probe(name, { args: [option] });
      assert.equal(result.exitCode, 1);
      assert.equal(result.requests.length, 0);
      assert.equal(result.directReads, 0);
      assert.equal(result.sdkLoads, 0);
      assert.ok(!JSON.stringify(result.logs.concat(result.errors)).includes("fixture@example.invalid"));
    }
  });
}

test("Grok uses pi's credential API only when an environment token is absent", () => {
  const result = probe("grok-billing", { args: ["--settings"], credential: { type: "oauth", access: "s" } });
  assert.deepEqual(result.reads, ["xai"]);
  assert.equal(result.directReads, 0);
  assert.equal(result.requests.length, 2);
  assert.ok(result.requests.every((request) => request.authorization === "Bearer s"));
  assert.deepEqual(result.requests.map((request) => new URL(request.url).pathname), ["/v1/billing", "/v1/settings"]);
});

for (const failure of ["sdk", "credential"]) {
  test(`Grok hides private ${failure} errors`, () => {
    const privateText = "short-token fixture@example.invalid account-82736451";
    const result = probe("grok-billing", { failure, privateText });
    assert.equal(result.exitCode, 1);
    assert.equal(result.requests.length, 0);
    const output = JSON.stringify(result.logs.concat(result.errors));
    for (const part of privateText.split(" ")) assert.ok(!output.includes(part), `private data escaped: ${part}`);
  });
}

test("Grok never treats API-key credentials as OAuth access tokens", () => {
  const result = probe("grok-billing", { credential: { type: "api_key", key: "synthetic-key" } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.requests.length, 0);
  assert.equal(result.directReads, 0);
});

test("GLM retains the China endpoint and its unprefixed authorization", () => {
  const result = probe("glm-quota", { env: { ZAI_CODING_CN_API_KEY: "q" } });
  assert.equal(new URL(result.requests[0].url).host, "open.bigmodel.cn");
  assert.equal(result.requests[0].authorization, "q");
});
