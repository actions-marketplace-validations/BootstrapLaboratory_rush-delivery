export function parseEnvFileContents(
  contents: string,
  label: string,
): Record<string, string> {
  const envVars: Record<string, string> = {};

  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(
        `Invalid ${label} line ${index + 1}. Expected KEY=VALUE format; line contents were redacted.`,
      );
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);

    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(
        `Invalid ${label} line ${index + 1}. The environment variable name is invalid; line contents were redacted.`,
      );
    }

    envVars[key] = value;
  }

  return envVars;
}
