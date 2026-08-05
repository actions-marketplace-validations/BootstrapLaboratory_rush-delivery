// The pinned Rush 5.160.0 package fixture has 22,426 scannable entries. Keep
// measured headroom while retaining a fixed fail-closed ceiling.
export const MAX_PROTECTED_SCAN_FILES = 30_000;
export const MAX_PROTECTED_SCAN_BYTES = 1024 * 1024 * 1024;

export function assertProtectedScanCapacity(inspectedFiles, inspectedBytes) {
  if (inspectedFiles > MAX_PROTECTED_SCAN_FILES) {
    throw new Error(
      "Live matrix protected-output scan exceeded its file-count bound.",
    );
  }
  if (inspectedBytes > MAX_PROTECTED_SCAN_BYTES) {
    throw new Error(
      "Live matrix protected-output scan exceeded its byte bound.",
    );
  }
}
