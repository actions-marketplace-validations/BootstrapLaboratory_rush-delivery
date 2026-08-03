import { Directory, File } from "@dagger.io/dagger";

import { parseCiPlan } from "../../ci-plan/parse-ci-plan.ts";
import { logSection } from "../../logging/sections.ts";
import { installRush, prepareRushContainer } from "../../rush/container.ts";
import { parseOptionalEnvFile } from "../../workflow/env.ts";
import {
  createEmptyPackageManifest,
  formatPackageManifest,
} from "./package-manifest.ts";
import { loadPackageTargetDefinition } from "./load-package-metadata.ts";
import { buildPackageActionPlan } from "./package-action-plan.ts";
import { executePackagePlans } from "./execute-package-plans.ts";

const PACKAGE_MANIFEST_PATH = ".dagger/runtime/package-manifest.json";

export async function packageDeployTargets(
  repo: Directory,
  ciPlanFile: File,
  artifactPrefix: string = "deploy-target",
  gitSha: string = "",
  sourceRepositoryUrl: string = "",
  dryRun: boolean = true,
  deployEnvFile?: File,
  applicationImageProvider: string = "off",
): Promise<Directory> {
  const ciPlan = parseCiPlan(await ciPlanFile.contents());

  logSection("Package deploy artifacts");

  if (ciPlan.deploy_targets.length === 0) {
    console.log("[package] no deploy targets selected");
    return repo.withNewFile(
      PACKAGE_MANIFEST_PATH,
      formatPackageManifest(createEmptyPackageManifest()),
    );
  }

  const packagePlans = await Promise.all(
    ciPlan.deploy_targets.map(async (target) => ({
      plan: buildPackageActionPlan(
        target,
        await loadPackageTargetDefinition(repo, target),
        artifactPrefix,
      ),
      target,
    })),
  );
  const needsRushInstall = packagePlans.some(({ plan }) =>
    plan.commands.some(({ command }) => command === "node"),
  );
  const baseContainer = await prepareRushContainer(repo);
  const container = needsRushInstall
    ? installRush(baseContainer)
    : baseContainer;
  const result = await executePackagePlans(repo, container, packagePlans, {
    applicationImageProvider,
    dryRun,
    gitSha,
    hostEnv: await parseOptionalEnvFile(deployEnvFile, "deploy env"),
    sourceRepositoryUrl,
  });

  return result.repo;
}
