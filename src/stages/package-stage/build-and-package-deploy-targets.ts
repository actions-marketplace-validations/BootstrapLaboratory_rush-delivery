import { Directory, File } from "@dagger.io/dagger";

import { buildDeployTargets } from "../build-stage/build-deploy-targets.ts";
import { logSection } from "../../logging/sections.ts";
import { packageDeployTargets } from "./package-deploy-targets.ts";

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

  const builtRepo = await buildDeployTargets(
    repo,
    ciPlanFile,
    deployEnvFile,
    dryRun,
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
  );
}
