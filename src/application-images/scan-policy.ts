import type { VulnerabilitySeverity } from "../model/package-target.ts";

export type GrypeReport = {
  matches?: Array<{
    vulnerability?: {
      id?: string;
      severity?: string;
    };
  }>;
};

function normalizedSeverity(value: string | undefined): string {
  return (value ?? "unknown").toLowerCase();
}

export function rejectedVulnerabilities(
  report: GrypeReport,
  policy: VulnerabilitySeverity[],
): { count: number; ids: string[] } {
  const rejected = (report.matches ?? []).filter((match) =>
    policy.includes(
      normalizedSeverity(
        match.vulnerability?.severity,
      ) as VulnerabilitySeverity,
    ),
  );

  return {
    count: rejected.length,
    ids: [
      ...new Set(
        rejected
          .map((match) => match.vulnerability?.id)
          .filter((id): id is string => id !== undefined),
      ),
    ].sort(),
  };
}
