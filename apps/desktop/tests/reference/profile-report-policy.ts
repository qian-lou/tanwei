import path from "node:path";

function normalizedDocumentUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

export function isPathInsideRoot(
  canonicalRoot: string,
  canonicalPath: string,
): boolean {
  const relative = path.relative(canonicalRoot, canonicalPath);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function isProfileReportNavigationAllowed(
  candidateUrl: string,
  reportUrl: string,
): boolean {
  const normalizedCandidate = normalizedDocumentUrl(candidateUrl);
  const normalizedReport = normalizedDocumentUrl(reportUrl);
  return (
    normalizedCandidate !== null &&
    normalizedReport !== null &&
    normalizedCandidate === normalizedReport
  );
}

export function isProfileReportRequestAllowed(
  candidateUrl: string,
  reportUrl: string,
): boolean {
  if (isProfileReportNavigationAllowed(candidateUrl, reportUrl)) {
    return true;
  }
  try {
    const protocol = new URL(candidateUrl).protocol;
    return protocol === "data:" || protocol === "blob:";
  } catch {
    return false;
  }
}
