import { Directory, File } from "@dagger.io/dagger";

import { activateApplicationImageProvider } from "../../application-images/activation.ts";
import { parseCiPlan } from "../../ci-plan/parse-ci-plan.ts";
import { buildDeployTargets } from "../build-stage/build-deploy-targets.ts";
import { logSection } from "../../logging/sections.ts";
import { parseOptionalEnvFile } from "../../workflow/env.ts";
import { packageDeployTargets } from "./package-deploy-targets.ts";
import { preparePackageTargets } from "./package-planning.ts";

export async function buildAndPackageDeployTargets(
  repo: Directory,
  ciPlanFile: File,
  artifactPrefix: string = "deploy-target",
  deployEnvFile?: File,
  dryRun: boolean = false,
  gitSha: string = "",
  sourceRepositoryUrl: string = "",
  applicationImageProvider: string = "off",
): Promise<Directory> {
  logSection("Build and package deploy targets");

  const ciPlan = parseCiPlan(await ciPlanFile.contents());
  const hostEnv = await parseOptionalEnvFile(deployEnvFile, "deploy env");
  const packageTargets = await preparePackageTargets(
    repo,
    ciPlan.deploy_targets,
    artifactPrefix,
  );
  const applicationImageProviderActivation =
    await activateApplicationImageProvider(repo, packageTargets, {
      applicationImageProvider,
      dryRun,
    });

  const builtRepo = await buildDeployTargets(
    repo,
    ciPlanFile,
    deployEnvFile,
    dryRun,
    {
      hostEnv,
      packageTargets,
      protectedApplicationImageCredentials:
        applicationImageProviderActivation?.protectedCredentials,
    },
  );

  return packageDeployTargets(
    builtRepo,
    ciPlanFile,
    artifactPrefix,
    gitSha,
    sourceRepositoryUrl,
    dryRun,
    deployEnvFile,
    applicationImageProvider,
    {
      applicationImageProviderActivation,
      frameworkMetadataRepo: repo,
      hostEnv,
      packageTargets,
    },
  );
}
