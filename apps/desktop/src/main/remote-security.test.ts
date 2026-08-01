import { describe, expect, it } from "vitest";
import {
  isSafeRemoteDirectory,
  normalizeRemotePlatform,
  quotePosixShell,
  stableRemoteTargetId,
} from "./remote-security.js";

describe("remote orchestration safety", () => {
  it("normalizes only supported OS and architecture pairs", () => {
    expect(
      normalizeRemotePlatform(
        "Linux\n",
        "aarch64\n",
        'openjdk version "21.0.8"\nOpenJDK Runtime Environment',
      ),
    ).toEqual({
      platform: "linux",
      architecture: "arm64",
      javaVersion: 'openjdk version "21.0.8"',
    });
    expect(() =>
      normalizeRemotePlatform("Windows", "x86_64", "java 21"),
    ).toThrow(/不受支持/u);
  });

  it("quotes untrusted shell values as one literal argument", () => {
    expect(quotePosixShell("name'; touch /tmp/injected; '")).toBe(
      `'name'"'"'; touch /tmp/injected; '"'"''`,
    );
  });

  it("allows cleanup only for exact one-time Tanwei directories", () => {
    expect(
      isSafeRemoteDirectory(
        "/tmp/tanwei-123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBe(true);
    expect(isSafeRemoteDirectory("/tmp/tanwei-../important")).toBe(false);
    expect(isSafeRemoteDirectory("/tmp")).toBe(false);
  });

  it("derives stable non-secret target identifiers", () => {
    const id = stableRemoteTargetId("ssh", "user@example.test:22", 42);
    expect(id).toMatch(/^remote:ssh:[a-f0-9]{24}$/u);
    expect(id).toBe(
      stableRemoteTargetId("ssh", "user@example.test:22", 42),
    );
    expect(id).not.toBe(
      stableRemoteTargetId("ssh", "user@example.test:22", 43),
    );
  });
});
