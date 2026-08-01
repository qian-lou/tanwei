import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathInsideRoot,
  isProfileReportNavigationAllowed,
  isProfileReportRequestAllowed,
} from "./profile-report-policy.js";

describe("profile report security policy", () => {
  it("accepts only strict children of the canonical artifact root", () => {
    const root = path.resolve("/tmp/tanwei/artifacts");

    expect(isPathInsideRoot(root, path.join(root, "profile.html"))).toBe(true);
    expect(isPathInsideRoot(root, root)).toBe(false);
    expect(
      isPathInsideRoot(root, path.resolve(root, "..", "profile.html")),
    ).toBe(false);
    expect(
      isPathInsideRoot(root, path.resolve("/tmp/tanwei/artifacts-copy/report.html")),
    ).toBe(false);
  });

  it("allows navigation only within the verified report document", () => {
    const reportUrl = "file:///tmp/tanwei/profile.html";

    expect(
      isProfileReportNavigationAllowed(
        "file:///tmp/tanwei/profile.html#hot-method",
        reportUrl,
      ),
    ).toBe(true);
    expect(
      isProfileReportNavigationAllowed(
        "file:///tmp/tanwei/other.html",
        reportUrl,
      ),
    ).toBe(false);
    expect(
      isProfileReportNavigationAllowed("https://example.com/", reportUrl),
    ).toBe(false);
  });

  it("allows embedded data and blob resources but blocks network and sibling files", () => {
    const reportUrl = "file:///tmp/tanwei/profile.html";

    expect(
      isProfileReportRequestAllowed(
        "data:image/svg+xml,%3Csvg%2F%3E",
        reportUrl,
      ),
    ).toBe(true);
    expect(
      isProfileReportRequestAllowed("blob:file:///generated", reportUrl),
    ).toBe(true);
    expect(
      isProfileReportRequestAllowed("https://example.com/script.js", reportUrl),
    ).toBe(false);
    expect(
      isProfileReportRequestAllowed(
        "file:///tmp/tanwei/secret.txt",
        reportUrl,
      ),
    ).toBe(false);
  });
});
