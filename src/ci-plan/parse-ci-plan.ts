import type { CiPlan } from "../model/ci-plan.ts";

export type CiPlanSource = {
  affectedProjectsByDeployTarget: Record<string, string[]>;
  deployTargets: string[];
  mode: CiPlan["mode"];
  prBaseSha: string;
  releaseTargets?: string[];
  validateTargets: string[];
};

function parseStringArray(rawValue: unknown, name: string): string[] {
  if (!Array.isArray(rawValue)) {
    throw new Error(`CI plan field "${name}" must be an array of strings.`);
  }

  return rawValue.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`CI plan field "${name}" must contain only strings.`);
    }

    return entry;
  });
}

function parseDistinctStringArray(rawValue: unknown, name: string): string[] {
  return [...new Set(parseStringArray(rawValue, name))];
}

function parseAffectedProjectsByDeployTarget(
  rawValue: unknown,
): Record<string, string[]> {
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw new Error(
      'CI plan field "affected_projects_by_deploy_target" must be an object.',
    );
  }

  return Object.fromEntries(
    Object.entries(rawValue).map(([target, projects]) => {
      if (target.length === 0) {
        throw new Error(
          'CI plan field "affected_projects_by_deploy_target" must use non-empty target names.',
        );
      }

      return [
        target,
        parseStringArray(
          projects,
          `affected_projects_by_deploy_target.${target}`,
        ),
      ];
    }),
  );
}

export function normalizeCiPlan(parsedValue: unknown): CiPlan {
  if (
    typeof parsedValue !== "object" ||
    parsedValue === null ||
    Array.isArray(parsedValue)
  ) {
    throw new Error("CI plan must be a JSON object.");
  }

  const mode = "mode" in parsedValue ? parsedValue.mode : undefined;

  if (mode !== "pull_request" && mode !== "release") {
    throw new Error(
      'CI plan field "mode" must be either "pull_request" or "release".',
    );
  }

  const prBaseSha =
    "pr_base_sha" in parsedValue ? parsedValue.pr_base_sha : undefined;

  if (typeof prBaseSha !== "string") {
    throw new Error('CI plan field "pr_base_sha" must be a string.');
  }

  return {
    affected_projects_by_deploy_target: parseAffectedProjectsByDeployTarget(
      "affected_projects_by_deploy_target" in parsedValue
        ? parsedValue.affected_projects_by_deploy_target
        : undefined,
    ),
    deploy_targets: parseDistinctStringArray(
      "deploy_targets" in parsedValue ? parsedValue.deploy_targets : undefined,
      "deploy_targets",
    ),
    mode,
    pr_base_sha: prBaseSha,
    release_targets: parseDistinctStringArray(
      "release_targets" in parsedValue ? parsedValue.release_targets : [],
      "release_targets",
    ),
    validate_targets: parseDistinctStringArray(
      "validate_targets" in parsedValue
        ? parsedValue.validate_targets
        : undefined,
      "validate_targets",
    ),
  };
}

export function createCiPlan(source: CiPlanSource): CiPlan {
  return normalizeCiPlan({
    affected_projects_by_deploy_target: source.affectedProjectsByDeployTarget,
    deploy_targets: source.deployTargets,
    mode: source.mode,
    pr_base_sha: source.prBaseSha,
    release_targets: source.releaseTargets ?? [],
    validate_targets: source.validateTargets,
  });
}

export function formatCiPlan(ciPlan: CiPlan): string {
  return `${JSON.stringify(normalizeCiPlan(ciPlan), null, 2)}\n`;
}

export function parseCiPlan(source: string): CiPlan {
  return normalizeCiPlan(JSON.parse(source));
}
