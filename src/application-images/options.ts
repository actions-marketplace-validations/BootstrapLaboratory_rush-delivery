const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

export function parseApplicationImageProvider(value: string): string {
  if (value === "off") {
    return value;
  }

  if (!PROVIDER_NAME_PATTERN.test(value)) {
    throw new Error(
      `Unsupported application image provider "${value}". Provider names must match ${PROVIDER_NAME_PATTERN}.`,
    );
  }

  return value;
}
