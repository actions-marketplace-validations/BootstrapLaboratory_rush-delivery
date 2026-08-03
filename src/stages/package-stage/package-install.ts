import type { PackageActionPlan } from "./package-action-plan.ts";

export function packagePlansRequireRushInstall(
  packagePlans: Array<{ plan: PackageActionPlan }>,
): boolean {
  return packagePlans.some(({ plan }) =>
    plan.commands.some(({ command }) => command === "node"),
  );
}
