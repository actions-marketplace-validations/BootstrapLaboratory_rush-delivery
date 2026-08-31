const SUPPORTED_REPOSITORY_PROTOCOLS = new Set([
  "git:",
  "http:",
  "https:",
  "ssh:",
]);
const SCP_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const SCP_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function isSafeGitScpLocator(value: string): boolean {
  const match = /^git@([^:]+):(.+)$/.exec(value);

  if (match === null || !SCP_HOST_PATTERN.test(match[1])) {
    return false;
  }

  const segments = match[2].split("/");

  return (
    segments.length > 1 &&
    segments.every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        SCP_PATH_SEGMENT_PATTERN.test(segment),
    )
  );
}

export function normalizeCredentialFreeRepositoryLocator(
  value: string,
  context: string,
): string {
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(
      `${context} must not contain whitespace or control characters.`,
    );
  }

  if (isSafeGitScpLocator(value)) {
    return value;
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${context} must be an absolute HTTP(S), Git, or SSH URL, or a credential-free git@host:path locator.`,
    );
  }

  const allowedSshUsername =
    parsed.protocol === "ssh:" &&
    parsed.username === "git" &&
    parsed.password.length === 0;

  if (
    !SUPPORTED_REPOSITORY_PROTOCOLS.has(parsed.protocol) ||
    parsed.hostname.length === 0 ||
    parsed.pathname.length <= 1
  ) {
    throw new Error(
      `${context} must be an absolute HTTP(S), Git, or SSH repository URL.`,
    );
  }

  if (
    (!allowedSshUsername &&
      (parsed.username.length > 0 || parsed.password.length > 0)) ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      `${context} must not embed credentials or URL query/fragment data; use an explicit authentication capability instead.`,
    );
  }

  return value;
}
