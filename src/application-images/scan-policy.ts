import type { VulnerabilitySeverity } from "../model/package-target.ts";

const SUPPORTED_SEVERITIES = new Set<VulnerabilitySeverity>([
  "critical",
  "high",
  "medium",
  "low",
  "negligible",
]);

export type GrypeReport = {
  matches: Array<{
    vulnerability: {
      id: string;
      severity: VulnerabilitySeverity;
    };
  }>;
};

function invalidReport(message: string): never {
  throw new Error(`Grype produced invalid scanner output: ${message}`);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseGrypeReport(value: unknown): GrypeReport {
  const report = recordValue(value);

  if (report === undefined) {
    return invalidReport("the report must be a JSON object.");
  }

  if (!Array.isArray(report.matches)) {
    return invalidReport('"matches" must be an array.');
  }

  return {
    matches: report.matches.map((rawMatch, index) => {
      const match = recordValue(rawMatch);
      const vulnerability = recordValue(match?.vulnerability);

      if (vulnerability === undefined) {
        return invalidReport(
          `matches[${index}].vulnerability must be an object.`,
        );
      }

      const id = vulnerability.id;

      if (typeof id !== "string" || id.trim().length === 0) {
        return invalidReport(
          `matches[${index}].vulnerability.id must be a non-empty string.`,
        );
      }

      const rawSeverity = vulnerability.severity;

      if (typeof rawSeverity !== "string") {
        return invalidReport(
          `matches[${index}].vulnerability.severity must be a supported string.`,
        );
      }

      const severity = rawSeverity.trim().toLowerCase();

      if (!SUPPORTED_SEVERITIES.has(severity as VulnerabilitySeverity)) {
        return invalidReport(
          `matches[${index}].vulnerability.severity "${rawSeverity}" is unsupported.`,
        );
      }

      return {
        vulnerability: {
          id: id.trim(),
          severity: severity as VulnerabilitySeverity,
        },
      };
    }),
  };
}

export function rejectedVulnerabilities(
  report: unknown,
  policy: VulnerabilitySeverity[],
): { count: number; ids: string[] } {
  const parsed = parseGrypeReport(report);
  const rejected = parsed.matches.filter((match) =>
    policy.includes(match.vulnerability.severity),
  );

  return {
    count: rejected.length,
    ids: [...new Set(rejected.map((match) => match.vulnerability.id))].sort(),
  };
}
