import { Directory, File, Socket } from "@dagger.io/dagger";
import { activateApplicationImageCredentialBoundaryForDeploy } from "../../application-images/activation.ts";
import type { DeployReleaseResult } from "../../model/deploy-result.ts";
import type { ToolchainImageProvidersDefinition } from "../../model/toolchain-image.ts";
import { buildDeploymentPlan } from "../../planning/build-deployment-plan.ts";
import { logSection } from "../../logging/sections.ts";
import { parseReleaseTargets } from "../../planning/parse-release-targets.ts";
import { assertFrameworkRuntimePathsAreCanonical } from "../../runtime/framework-runtime.ts";
import {
  parseToolchainImagePolicy,
  parseToolchainImageProvider,
} from "../../toolchain-images/options.ts";
import { parseToolchainImageProviders } from "../../toolchain-images/parse-providers.ts";
import { toolchainImageProvidersPath } from "../../toolchain-images/metadata-paths.ts";
import { executeDeploymentPlan } from "./execute-deployment-plan.ts";
import { loadServicesMesh } from "./load-deploy-metadata.ts";
import { parsePackageManifest } from "../package-stage/package-manifest.ts";
import { parseDeployEnvFile } from "./runtime-env.ts";
import {
  assertPackageManifestDeployPreflight,
  assertPackageManifestEvidenceIntegrity,
} from "./package-manifest-preflight.ts";

async function buildReleasePlan(
  repo: Directory,
  releaseTargetsJson: string = "[]",
): Promise<ReturnType<typeof buildDeploymentPlan>> {
  const servicesMesh = await loadServicesMesh(repo);
  return buildDeploymentPlan(
    servicesMesh,
    parseReleaseTargets(releaseTargetsJson),
  );
}

export async function deployRelease(
  repo: Directory,
  gitSha: string,
  releaseTargetsJson: string = "[]",
  environment: string = "prod",
  dryRun: boolean = true,
  deployEnvFile?: File,
  packageManifestFile?: File,
  hostWorkspaceDir: string = "",
  toolchainImageProvider: string = "off",
  toolchainImagePolicy: string = "lazy",
  dockerSocket?: Socket,
  runtimeMountRepo?: Directory,
  deployTagTokenEnv: string = "",
  runtimeFiles?: Directory,
  hostEnvOverride?: Record<string, string>,
): Promise<string> {
  logSection("Deploy release");

  await assertFrameworkRuntimePathsAreCanonical(repo);
  const hostEnv =
    hostEnvOverride ??
    (deployEnvFile ? parseDeployEnvFile(await deployEnvFile.contents()) : {});
  const deploymentPlan = await buildReleasePlan(repo, releaseTargetsJson);
  const parsedToolchainImageProvider = parseToolchainImageProvider(
    toolchainImageProvider,
  );
  const parsedToolchainImagePolicy =
    parseToolchainImagePolicy(toolchainImagePolicy);
  const toolchainImageProviders: ToolchainImageProvidersDefinition | undefined =
    parsedToolchainImageProvider === "off"
      ? undefined
      : parseToolchainImageProviders(
          await repo.file(toolchainImageProvidersPath).contents(),
        );
  const packageManifest =
    packageManifestFile === undefined
      ? undefined
      : parsePackageManifest(await packageManifestFile.contents());

  if (deploymentPlan.selectedTargets.length === 0) {
    const emptyResult: DeployReleaseResult = {
      dryRun,
      environment,
      plan: deploymentPlan,
      results: [],
    };

    console.log("[deploy-release] no release targets selected");

    return JSON.stringify(emptyResult, null, 2);
  }

  if (packageManifest === undefined) {
    throw new Error(
      "packageManifestFile is required when release targets are selected.",
    );
  }

  assertPackageManifestDeployPreflight(
    deploymentPlan.selectedTargets,
    packageManifest,
    gitSha,
    dryRun,
  );
  const protectedApplicationImageCredentials =
    await activateApplicationImageCredentialBoundaryForDeploy(
      repo,
      packageManifest,
      deploymentPlan.selectedTargets,
    );
  if (!dryRun) {
    await assertPackageManifestEvidenceIntegrity(
      deploymentPlan.selectedTargets,
      packageManifest,
      (path) => repo.file(path).contents(),
    );
  }

  console.log(
    `[deploy-release] selected targets: ${deploymentPlan.selectedTargets.join(", ")} | environment=${environment} | dryRun=${dryRun}`,
  );
  console.log(JSON.stringify(deploymentPlan, null, 2));

  const results = await executeDeploymentPlan(
    repo,
    runtimeMountRepo ?? repo,
    deploymentPlan,
    packageManifest,
    gitSha,
    environment,
    dryRun,
    hostEnv,
    hostWorkspaceDir,
    parsedToolchainImageProvider,
    parsedToolchainImagePolicy,
    toolchainImageProviders,
    dockerSocket,
    deployTagTokenEnv,
    runtimeFiles,
    protectedApplicationImageCredentials,
  );
  const deployResult: DeployReleaseResult = {
    dryRun,
    environment,
    plan: deploymentPlan,
    results,
  };

  return JSON.stringify(deployResult, null, 2);
}
