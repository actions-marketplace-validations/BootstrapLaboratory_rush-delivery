import { OciPackageOperationError } from "../stages/package-stage/oci-package-results.ts";

export type RegistryPublicationFailureStage =
  | "registry publication"
  | "registry publication authentication"
  | "registry publication authorization"
  | "registry publication transport";

const AUTHENTICATION_FAILURE_PATTERNS = [
  /\b(?:http(?: response)? status|response status|status code|unexpected status(?: code)?)[ :=-]+401\b/u,
  /\bhttp(?:\/[0-9.]+)?[ \t]+401\b/u,
  /\bunauthorized\b/u,
  /\bauthentication required\b/u,
  /\bno basic auth credentials\b/u,
  /\b(?:invalid|incorrect) (?:credentials|password|username)\b/u,
  /\bbad credentials\b/u,
  /\bcredentials? (?:are |is )?(?:expired|invalid)\b/u,
  /\btoken (?:is )?(?:expired|invalid)\b/u,
] as const;

const AUTHORIZATION_FAILURE_PATTERNS = [
  /\b(?:http(?: response)? status|response status|status code|unexpected status(?: code)?)[ :=-]+403\b/u,
  /\bhttp(?:\/[0-9.]+)?[ \t]+403\b/u,
  /\bforbidden\b/u,
  /\binsufficient[_ -]scope\b/u,
  /\brequested access to (?:the )?resource is denied\b/u,
  /\bpermissions?[_ ]denied\b/u,
  /\baccess denied\b/u,
  /\bnot authorized (?:for|to)\b/u,
  /\b(?:installation|operation) not allowed\b/u,
] as const;

const TRANSPORT_FAILURE_PATTERNS = [
  /\bdial (?:tcp|udp)\b/u,
  /\bno such host\b/u,
  /\bconnection (?:refused|reset|timed out)\b/u,
  /\bnetwork is unreachable\b/u,
  /\bno route to host\b/u,
  /\bi\/o timeout\b/u,
  /\btls handshake timeout\b/u,
  /\bcontext deadline exceeded\b/u,
  /\bclient\.timeout exceeded\b/u,
  /\btemporary failure in name resolution\b/u,
  /\bx509: certificate\b/u,
  /\bremote error: tls\b/u,
  /\bunexpected eof\b/u,
  /\b(?:502 bad gateway|503 service unavailable|504 gateway timeout)\b/u,
] as const;

function matchesAny(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function extractRegistryErrorMessage(error: unknown): string {
  try {
    if (typeof error === "string") {
      return error.toLowerCase();
    }

    if (error instanceof Error) {
      const message: unknown = error.message;

      return typeof message === "string" ? message.toLowerCase() : "";
    }
  } catch {
    // An untrusted exception accessor must not replace the sanitized error.
  }

  return "";
}

/**
 * Maps an untrusted registry exception to a fixed operational stage. The raw
 * exception must never be attached to the returned package error because
 * registry clients can include credentials or signed URLs in their output.
 */
export function classifyRegistryPublicationFailure(
  error: unknown,
): RegistryPublicationFailureStage {
  const message = extractRegistryErrorMessage(error);

  if (matchesAny(message, AUTHORIZATION_FAILURE_PATTERNS)) {
    return "registry publication authorization";
  }

  if (matchesAny(message, AUTHENTICATION_FAILURE_PATTERNS)) {
    return "registry publication authentication";
  }

  if (matchesAny(message, TRANSPORT_FAILURE_PATTERNS)) {
    return "registry publication transport";
  }

  return "registry publication";
}

export function sanitizeRegistryPublicationFailure(
  error: unknown,
): OciPackageOperationError {
  return new OciPackageOperationError(
    classifyRegistryPublicationFailure(error),
  );
}
