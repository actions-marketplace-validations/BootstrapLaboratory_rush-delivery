import type { Directory } from "@dagger.io/dagger";

import type { PackageTargetDefinition } from "../../model/package-target.ts";
import { loadPackageTargetDefinition } from "./load-package-metadata.ts";
import {
  buildPackageActionPlan,
  type PackageActionPlan,
} from "./package-action-plan.ts";

export type PreparedPackageTarget = {
  definition: PackageTargetDefinition;
  plan: PackageActionPlan;
  target: string;
};

export async function preparePackageTargets(
  repo: Directory,
  targets: string[],
  artifactPrefix: string,
): Promise<PreparedPackageTarget[]> {
  return Promise.all(
    targets.map(async (target) => {
      const definition = await loadPackageTargetDefinition(repo, target);

      return {
        definition,
        plan: buildPackageActionPlan(target, definition, artifactPrefix),
        target,
      };
    }),
  );
}

export function packageTargetsContainOciImage(
  packageTargets: PreparedPackageTarget[],
): boolean {
  return packageTargets.some(({ plan }) => "oci" in plan);
}
