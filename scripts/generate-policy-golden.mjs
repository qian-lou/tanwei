import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reference = path.join(root, "apps/desktop/tests/reference");
const testPath = path.join(reference, "policy-engine.test.ts");
const oraclePath = path.join(reference, "policy-engine.ts");
const outputPath = path.join(root, "apps/desktop/src-tauri/src/policy/golden.json");
const temporary = mkdtempSync(path.join(tmpdir(), "tanwei-policy-golden-"));
const cases = [];
const connections = [];
const connectionIds = new Map();
const suites = [];
let currentTest = "";
let testsRun = 0;

function partial(actual, expected) {
  if (expected !== null && typeof expected === "object") {
    assert(actual !== null && typeof actual === "object");
    for (const [key, value] of Object.entries(expected)) partial(actual[key], value);
  } else {
    assert.deepStrictEqual(actual, expected);
  }
}

// Execute the unchanged reference tests, including their original assertions.
// This small synchronous adapter deliberately implements only the matchers used
// by that file; a new matcher fails the generator instead of skipping a check.
globalThis.__tanweiPolicyTest = {
  describe(name, callback) {
    suites.push(name);
    try { callback(); } finally { suites.pop(); }
  },
  it(name, callback) {
    currentTest = name;
    testsRun += 1;
    const value = callback();
    assert(!(value && typeof value.then === "function"), "Policy oracle tests must be synchronous");
  },
  expect(actual) {
    return {
      toBe(expected) { assert.strictEqual(actual, expected); },
      toEqual(expected) { assert.deepStrictEqual(actual, expected); },
      toMatchObject(expected) { partial(actual, expected); },
      toBeInstanceOf(expected) { assert(actual instanceof expected); },
      toThrowError(expected) {
        assert.equal(typeof actual, "function");
        let failure;
        try { actual(); } catch (error) { failure = error; }
        assert(failure, "Expected reference policy to throw");
        if (expected instanceof RegExp) assert.match(failure.message, expected);
        else if (typeof expected === "function") assert(failure instanceof expected);
        else if (typeof expected === "string") assert(failure.message.includes(expected));
      },
    };
  },
};

globalThis.__tanweiPolicyCapture = (api, args, run) => {
  let item;
  if (api === "authorizeAction") {
    const [connection, actionId, parameters, maximumRiskLevel = "R4", contractVersion = "1.0"] = args;
    const key = JSON.stringify(connection ?? null);
    if (!connectionIds.has(key)) {
      connectionIds.set(key, connections.length);
      connections.push(connection ?? null);
    }
    item = { api, suite: suites.join(" / "), test: currentTest, connection: connectionIds.get(key), actionId, parameters, maximumRiskLevel, contractVersion };
  } else {
    item = { api, suite: suites.join(" / "), test: currentTest, actionId: args[0], parameters: args[1] };
  }
  try {
    const value = run();
    cases.push({ ...item, result: { ok: true, value } });
    return value;
  } catch (error) {
    assert.equal(typeof error.code, "string", "Policy oracle must return a structured error");
    cases.push({ ...item, result: { ok: false, errorCode: error.code } });
    throw error;
  }
};

try {
  const bundlePath = path.join(temporary, "oracle.cjs");
  await build({
    entryPoints: [testPath],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [{
      name: "record-policy-contracts",
      setup(builder) {
        builder.onResolve({ filter: /^vitest$/ }, () => ({ path: "assertions", namespace: "policy-oracle" }));
        builder.onLoad({ filter: /.*/, namespace: "policy-oracle" }, () => ({
          contents: "export const { describe, expect, it } = globalThis.__tanweiPolicyTest;",
          loader: "js",
        }));
        builder.onLoad({ filter: /policy-engine\.ts$/ }, (args) => {
          let source = readFileSync(args.path, "utf8");
          for (const name of ["authorizeAction", "validateDiagnosticTemplateAction"]) {
            assert(source.includes(`export function ${name}(`), `Missing policy export ${name}`);
            source = source.replace(`export function ${name}(`, `function original_${name}(`);
            source += `\nexport function ${name}(...args) { return globalThis.__tanweiPolicyCapture(${JSON.stringify(name)}, args, () => original_${name}(...args)); }\n`;
          }
          return { contents: source, loader: "ts", resolveDir: path.dirname(args.path) };
        });
      },
    }],
  });
  await import(pathToFileURL(bundlePath).href);
  assert(cases.length > 100, "Oracle produced too few cases");
  const fixture = {
    schemaVersion: 1,
    provenance: "Original policy-engine.test.ts executed against the Zod policy oracle with its assertions enabled",
    sourceSha256: createHash("sha256").update(readFileSync(testPath)).digest("hex"),
    oracleSha256: createHash("sha256").update(readFileSync(oraclePath)).digest("hex"),
    testsRun,
    connections,
    cases,
  };
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    assert.equal(readFileSync(outputPath, "utf8"), serialized, "Rust policy golden fixtures are stale; run node scripts/generate-policy-golden.mjs");
  } else {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized);
  }
  console.log(`Policy golden: ${cases.length} calls from ${testsRun} passing reference tests`);
} finally {
  delete globalThis.__tanweiPolicyTest;
  delete globalThis.__tanweiPolicyCapture;
  rmSync(temporary, { recursive: true, force: true });
}
