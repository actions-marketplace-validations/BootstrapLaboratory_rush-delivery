import { Directory, File } from "@dagger.io/dagger";

import {
  activateApplicationImageProvider,
  type ApplicationImageProviderActivation,
} from "../../application-images/activation.ts";
import { parseCiPlan } from "../../ci-plan/parse-ci-plan.ts";
import { logSection } from "../../logging/sections.ts";
import { canonicalizeFrameworkRuntime } from "../../runtime/framework-runtime.ts";
import {
  installRush,
  prepareRushContainer,
  prepareRushWorkspaceContainer,
} from "../../rush/container.ts";
import { parseOptionalEnvFile } from "../../workflow/env.ts";
import { executePackagePlans } from "./execute-package-plans.ts";
import { packagePlansRequireRushInstall } from "./package-install.ts";
import {
  preparePackageTargets,
  type PreparedPackageTarget,
} from "./package-planning.ts";
import { writePackageRuntimeMetadata } from "./package-runtime-metadata.ts";

export type PackageDeployTargetsOptions = {
  applicationImageProviderActivation?: ApplicationImageProviderActivation;
  frameworkMetadataRepo?: Directory;
  hostEnv?: Record<string, string>;
  packageTargets?: PreparedPackageTarget[];
};

export async function packageDeployTargets(
  repo: Directory,
  ciPlanFile: File,
  artifactPrefix: string = "deploy-target",
  gitSha: string = "",
  sourceRepositoryUrl: string = "",
  dryRun: boolean = true,
  deployEnvFile?: File,
  applicationImageProvider: string = "off",
  options: PackageDeployTargetsOptions = {},
): Promise<Directory> {
  const ciPlan = parseCiPlan(await ciPlanFile.contents());

  logSection("Package deploy artifacts");

  if (ciPlan.deploy_targets.length === 0) {
    console.log("[package] no deploy targets selected");
    return writePackageRuntimeMetadata(
      await canonicalizeFrameworkRuntime(
        options.frameworkMetadataRepo ?? repo,
        repo,
      ),
      [],
      new Map(),
      undefined,
    );
  }

  const packagePlans =
    options.packageTargets ??
    (await preparePackageTargets(repo, ciPlan.deploy_targets, artifactPrefix));
  const applicationImageProviderActivation =
    options.applicationImageProviderActivation ??
    (await activateApplicationImageProvider(repo, packagePlans, {
      applicationImageProvider,
      dryRun,
    }));
  const hostEnv =
    options.hostEnv ??
    (await parseOptionalEnvFile(deployEnvFile, "deploy env"));
  const needsRushInstall = packagePlansRequireRushInstall(packagePlans);
  const container = needsRushInstall
    ? installRush(await prepareRushContainer(repo))
    : prepareRushWorkspaceContainer(repo);
  const result = await executePackagePlans(
    options.frameworkMetadataRepo ?? repo,
    container,
    packagePlans,
    {
      applicationImageProviderActivation,
      applicationImageProvider,
      dryRun,
      gitSha,
      hostEnv,
      sourceRepositoryUrl,
    },
  );

  return result.repo;
}
