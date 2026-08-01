import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isProtocolCompatible,
  protocolCompatibilityError,
} from "./protocol-compatibility.js";

describe("protocol compatibility", () => {
  it("matches the shared Java and TypeScript golden vectors", () => {
    const repositoryRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const rows = readFileSync(
      resolve(repositoryRoot, "contracts/protocol-compatibility-v1.tsv"),
      "utf8",
    )
      .split(/\r?\n/u)
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    for (const row of rows) {
      const [rawClient, rawAgent, rawCompatible, rawErrorCode] =
        row.split("\t");
      expect(rawClient).toBeDefined();
      expect(rawAgent).toBeDefined();
      const client = rawClient === "<missing>" ? null : rawClient;
      const agent = rawAgent === "<missing>" ? null : rawAgent;
      const compatible = rawCompatible === "true";
      const expectedErrorCode = rawErrorCode === "-" ? null : rawErrorCode;

      expect(isProtocolCompatible(client, agent), row).toBe(compatible);
      expect(protocolCompatibilityError(client, agent), row).toBe(
        expectedErrorCode,
      );
    }
  });
});
