import { Directory, Socket } from "@dagger.io/dagger";
import {
  assertNoApplicationImageCredentialProjections,
  collectDeployRuntimeCredentialProjectionIssues,
  type ProtectedApplicationImageCredential,
} from "../../application-images/environment-boundary.ts";

import type { DeployTargetResult } from "../../model/deploy-result.ts";
import { withFreshExecutionCache } from "../../execution/cache-buster.ts";
import type { PackageManifestArtifact } from "../../model/package-manifest.ts";
import type {
  ToolchainImagePolicy,
  ToolchainImageProvider,
  ToolchainImageProvidersDefinition,
} from "../../model/toolchain-image.ts";
import { logSubsection } from "../../logging/sections.ts";
import { deployTargetToolchainImageSpec } from "../../toolchain-images/spec.ts";
import {
  buildResolvedToolchainContainer,
  resolveToolchainImage,
} from "../../toolchain-images/resolve.ts";
import {
  applyRuntimeWorkspace,
  assertRuntimeFileMountTargetsDoNotCollideWithFrameworkEvidence,
  mountTargetEvidence,
  withoutFrameworkEvidence,
} from "./runtime-workspace.ts";
import { loadDeployTargetDefinition } from "./load-deploy-metadata.ts";
import {
  getRequiredRepoRelativeHostPathSource,
  mergeProjectAndFrameworkDeployEnvironment,
  resolveSpecEnvironment,
  validateRuntimeFilesProvided,
  validateRequiredHostEnv,
} from "./runtime-env.ts";
import {
  buildDeployTargetCommand,
  deployTagName,
  updateDeployTagWithGithubApiIfConfigured,
} from "./deploy-tag.ts";
import { formatDryRunSummary } from "./dry-run-summary.ts";
import {
  buildArtifactRuntimeHandoff,
  buildSuccessfulDeployTargetResult,
} from "./artifact-handoff.ts";

export async function executeTarget(
  repo: Directory,
  runtimeMountRepo: Directory,
  target: string,
  artifact: PackageManifestArtifact,
  gitSha: string,
  environment: string,
  dryRun: boolean,
  hostEnv: Record<string, string>,
  hostWorkspaceDir: string,
  wave: number,
  toolchainImageProvider: ToolchainImageProvider = "off",
  toolchainImagePolicy: ToolchainImagePolicy = "lazy",
  toolchainImageProviders?: ToolchainImageProvidersDefinition,
  dockerSocket?: Socket,
  deployTagTokenEnv: string = "",
  runtimeFiles?: Directory,
  protectedApplicationImageCredentials: ProtectedApplicationImageCredential[] = [],
): Promise<DeployTargetResult> {
  const definition = await loadDeployTargetDefinition(repo, target);
  assertRuntimeFileMountTargetsDoNotCollideWithFrameworkEvidence(
    definition.runtime.file_mounts,
  );
  assertNoApplicationImageCredentialProjections(
    collectDeployRuntimeCredentialProjectionIssues(
      target,
      definition.runtime,
      protectedApplicationImageCredentials,
    ),
  );
  validateRequiredHostEnv(definition.runtime, hostEnv, dryRun, target);
  validateRuntimeFilesProvided(
    definition.runtime.file_mounts,
    runtimeFiles,
    dryRun,
    target,
  );
  if (
    artifact.kind === "oci_image" &&
    artifact.source_revision !== gitSha.toLowerCase()
  ) {
    throw new Error(
      `OCI artifact source revision "${artifact.source_revision}" does not match deploy gitSha "${gitSha}".`,
    );
  }
  if (
    artifact.kind === "oci_image" &&
    !dryRun &&
    artifact.status !== "published"
  ) {
    throw new Error(
      `Live deploy requires a published OCI artifact for target "${target}".`,
    );
  }

  const artifactHandoff = buildArtifactRuntimeHandoff(target, artifact);
  const artifactPath = artifactHandoff.artifactPath;
  const deployTag = deployTagName(environment, target);

  const frameworkEnv: Record<string, string> = {
    ...artifactHandoff.environment,
    DRY_RUN: dryRun ? "1" : "0",
    GIT_SHA: gitSha,
  };
  const projectEnv = resolveSpecEnvironment(
    definition.runtime,
    hostEnv,
    dryRun,
    target,
  );
  const envVars = mergeProjectAndFrameworkDeployEnvironment(
    projectEnv,
    frameworkEnv,
    target,
  );
  const command = buildDeployTargetCommand(definition.deploy_script);

  logSubsection(`Deploy target: ${target} (wave ${wave})`);
  console.log(`[deploy-release] wave ${wave}: starting ${target}`);

  if (dryRun) {
    const output = formatDryRunSummary({
      artifact,
      artifactPath,
      definition,
      deployTag,
      dockerSocketEnabled: dockerSocket !== undefined,
      environment,
      envVars,
      gitSha,
      wave,
    });
    console.log(output.trimEnd());

    return buildSuccessfulDeployTargetResult(
      artifact,
      artifactPath,
      output,
      target,
      wave,
    );
  }

  const toolchainImage = await resolveToolchainImage(
    deployTargetToolchainImageSpec(definition),
    {
      hostEnv,
      policy: toolchainImagePolicy,
      provider: toolchainImageProvider,
      providers: toolchainImageProviders,
    },
  );
  let container = (
    await applyRuntimeWorkspace(
      buildResolvedToolchainContainer(toolchainImage),
      repo,
      definition.runtime.workspace,
    )
  ).withWorkdir("/workspace");

  if (artifact.kind === "oci_image" && artifact.status === "published") {
    container = mountTargetEvidence(container, repo, target);
  }

  const runtimeMountSourceRepo =
    await withoutFrameworkEvidence(runtimeMountRepo);

  for (const fileMount of definition.runtime.file_mounts) {
    if (fileMount.kind === "host_path") {
      const sourcePath = getRequiredRepoRelativeHostPathSource(
        hostEnv,
        fileMount.source_var,
        target,
        hostWorkspaceDir,
      );
      const runtimeMountFile = runtimeMountSourceRepo.file(sourcePath);

      try {
        await runtimeMountFile.sync();
      } catch {
        throw new Error(
          `Runtime host-path file for environment name "${fileMount.source_var}" and target "${target}" was not found outside the Rush Delivery evidence subtree.`,
        );
      }

      container = container.withMountedFile(fileMount.target, runtimeMountFile);
      continue;
    }

    if (runtimeFiles === undefined) {
      throw new Error(
        `Runtime files directory is required for target "${target}" because it references "${fileMount.source}".`,
      );
    }

    const runtimeFile = runtimeFiles.file(fileMount.source);

    try {
      await runtimeFile.sync();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(
        `Runtime file "${fileMount.source}" for target "${target}" was not found in runtimeFiles: ${message}`,
      );
    }

    container = container.withMountedFile(fileMount.target, runtimeFile);
  }

  if (dockerSocket !== undefined) {
    container = container.withUnixSocket("/var/run/docker.sock", dockerSocket);
  }

  for (const [name, value] of Object.entries(envVars)) {
    container = container.withEnvVariable(name, value);
  }

  container = withFreshExecutionCache(container, "deploy-target");

  const deployOutput = await container
    .withExec(["bash", "-lc", command])
    .stdout();
  const tagOutput = await updateDeployTagWithGithubApiIfConfigured(
    environment,
    target,
    gitSha,
    hostEnv,
    deployTagTokenEnv,
  );
  const output = `${deployOutput}${tagOutput}`;

  console.log(`[deploy-release] wave ${wave}: finished ${target}`);

  return buildSuccessfulDeployTargetResult(
    artifact,
    artifactPath,
    output,
    target,
    wave,
  );
}
