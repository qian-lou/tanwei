// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildClassChangeSetParameters,
  parseClassChangeSetPreview,
  parseClassChangeSetResult,
  type ClassChangeSetDraft,
} from "./class-change-set";

const drafts: readonly ClassChangeSetDraft[] = [
  {
    className: "example.Main",
    classLoader: "app",
    source: "class Main {}",
  },
  {
    className: "example.Support",
    classLoader: "app",
    source: "class Support {}",
  },
];

describe("class change-set renderer boundary", () => {
  it("builds exact indexed parameters from a bounded compile result", () => {
    expect(
      buildClassChangeSetParameters(drafts, {
        targetRelease: 21,
        totalSize: 16,
        items: [
          {
            className: "example.Main",
            targetRelease: 21,
            size: 8,
            sha256: "a".repeat(64),
            bytecodeBase64: "QUFBQUFBQUFB",
          },
          {
            className: "example.Support",
            targetRelease: 21,
            size: 8,
            sha256: "b".repeat(64),
            bytecodeBase64: "QkJCQkJCQkJC",
          },
        ],
      }),
    ).toMatchObject({
      count: "2",
      item0Name: "example.Main",
      item0ClassLoader: "app",
      item1Name: "example.Support",
      item1ClassLoader: "app",
    });
  });

  it("accepts an order-independent exact preview evidence set", () => {
    expect(
      parseClassChangeSetPreview(
        evidenceValues("currentSha256", "proposedSha256"),
        drafts,
      ),
    ).toMatchObject({
      fingerprint: "f".repeat(64),
      items: [{ className: "example.Support" }, { className: "example.Main" }],
    });
  });

  it("rejects response identity substitution and malformed results", () => {
    const substituted = {
      ...evidenceValues("previousSha256", "currentSha256"),
      "item.00.className": "example.Other",
    };
    expect(() => parseClassChangeSetResult(substituted, drafts)).toThrow(
      /身份|证据/u,
    );
    expect(() =>
      buildClassChangeSetParameters(drafts, {
        targetRelease: 21,
        totalSize: 9,
        items: [
          {
            className: "example.Main",
            targetRelease: 21,
            size: 8,
            sha256: "a".repeat(64),
            bytecodeBase64: "QUFBQUFBQUFB",
          },
        ],
      }),
    ).toThrow(/越界/u);
  });
});

function evidenceValues(
  beforeKey: "currentSha256" | "previousSha256",
  afterKey: "proposedSha256" | "currentSha256",
): Readonly<Record<string, string>> {
  return {
    count: "2",
    fingerprint: "f".repeat(64),
    structuralCompatible: "true",
    "item.00.className": "example.Support",
    "item.00.classLoader": "app",
    [`item.00.${beforeKey}`]: "a".repeat(64),
    [`item.00.${afterKey}`]: "b".repeat(64),
    "item.00.currentSize": "10",
    "item.00.proposedSize": "11",
    "item.00.previousSize": "10",
    "item.01.className": "example.Main",
    "item.01.classLoader": "app",
    [`item.01.${beforeKey}`]: "c".repeat(64),
    [`item.01.${afterKey}`]: "d".repeat(64),
    "item.01.currentSize": "12",
    "item.01.proposedSize": "13",
    "item.01.previousSize": "12",
  };
}
