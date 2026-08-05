const APPLICATION_IMAGE_TARGET_PATTERN = /^[A-Za-z0-9@._-]+$/;

export function isSafeApplicationImageTarget(target: string): boolean {
  return (
    APPLICATION_IMAGE_TARGET_PATTERN.test(target) &&
    target !== "." &&
    target !== ".."
  );
}

export function assertSafeApplicationImageTarget(target: string): void {
  if (!isSafeApplicationImageTarget(target)) {
    throw new Error(
      `OCI image package target "${target}" cannot be used as an evidence directory name.`,
    );
  }
}
