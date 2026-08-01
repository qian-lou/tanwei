import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listActionContractDescriptors } from "./policy-engine.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const AGENT_SERVICE_PATH = resolve(
  REPOSITORY_ROOT,
  "jvm/agent/src/main/java/dev/tanwei/agent/DiagnosticApplicationService.java",
);

function uniqueMatches(source: string, pattern: RegExp): readonly string[] {
  return [...source.matchAll(pattern)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
}

describe("Action Contract Catalog consistency", () => {
  const source = readFileSync(AGENT_SERVICE_PATH, "utf8");
  const dispatcherStart = source.indexOf("public void executeAction(");
  const dispatcherEnd = source.indexOf("\n  private ", dispatcherStart);
  const dispatcher = source.slice(dispatcherStart, dispatcherEnd);
  const catalog = listActionContractDescriptors();

  it("keeps catalog, Host policy and Agent dispatcher action sets identical", () => {
    const catalogActions = catalog.map((entry) => entry.actionId);
    const dispatcherActions = uniqueMatches(dispatcher, /case\s+"([^"]+)"\s*:/gu);

    expect(dispatcherStart).toBeGreaterThanOrEqual(0);
    expect(dispatcherEnd).toBeGreaterThan(dispatcherStart);
    expect(new Set(catalogActions).size).toBe(catalogActions.length);
    expect(dispatcherActions).toEqual(catalogActions);
  });

  it("requires only capabilities advertised by the Agent", () => {
    const advertisedCapabilities = new Set(
      uniqueMatches(source, /capability\(\s*"([^"]+)"/gu),
    );
    const missing = catalog
      .filter((entry) => !advertisedCapabilities.has(entry.requiredCapability))
      .map((entry) => `${entry.actionId}:${entry.requiredCapability}`);

    expect(missing).toEqual([]);
  });
});
