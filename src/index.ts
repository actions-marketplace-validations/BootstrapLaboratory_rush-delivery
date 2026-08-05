/**
 * Rush Delivery is a Dagger module and GitHub Action for Rush-based release
 * workflows. It owns the release path from source acquisition through detect,
 * validate, build, package, package release, and deploy while keeping
 * project-specific behavior in metadata.
 */
import {
  argument,
  Directory,
  File,
  func,
  object,
  Socket,
} from "@dagger.io/dagger";

import { detect as detectCiPlan } from "./stages/detect/detect.ts";
import { deployRelease } from "./stages/deploy/deploy-release.ts";
import { buildAndPackageDeployTargets } from "./stages/package-stage/build-and-package-deploy-targets.ts";
import { buildDeployTargets } from "./stages/build-stage/build-deploy-targets.ts";
import { packageDeployTargets } from "./stages/package-stage/package-deploy-targets.ts";
import { parseReleaseTargets } from "./planning/parse-release-targets.ts";
import { validate as validateRelease } from "./stages/validate/validate.ts";
import { releasePackages as runReleasePackages } from "./stages/release/release-packages.ts";
import { workflow as runWorkflow } from "./workflow/workflow.ts";
import { selfCheck as runSelfCheck } from "./self-check/self-check.ts";
import {
  assertMetadataContract,
  validateMetadataContract as validateMetadataContractForRepo,
} from "./metadata/dagger-metadata-contract.ts";
import { formatMetadataContractValidationResult } from "./metadata/metadata-contract.ts";

/**
 * Repeatable release workflows for Rush monorepos.
 */
@object()
export class RushDelivery {
  /**
   * Returns a simple marker proving the Dagger module is callable.
   */
  @func({ cache: "session" })
  ping(): string {
    return "rush-delivery ready";
  }

  /**
   * Runs the framework's local typecheck and unit tests.
   */
  @func({ cache: "never" })
  async selfCheck(
    @argument({
      defaultPath: ".",
      ignore: ["node_modules", ".git", ".trunk/out", ".trunk/logs"],
    })
    moduleSource: Directory,
  ): Promise<string> {
    return runSelfCheck(moduleSource);
  }

  /**
   * Computes the canonical CI plan JSON for detect/package/deploy handoff.
   */
  @func({ cache: "never" })
  async detect(
    repo: Directory,
    eventName: string = "push",
    forceTargetsJson: string = "[]",
    prBaseSha: string = "",
    deployTagPrefix: string = "deploy/prod",
  ): Promise<string> {
    await assertMetadataContract(repo, {
      validate_application_image_provider_metadata: false,
    });

    return detectCiPlan(
      repo,
      eventName,
      forceTargetsJson,
      prBaseSha,
      deployTagPrefix,
    );
  }

  /**
   * Validates and normalizes a release target selection for future planning work.
   */
  @func({ cache: "session" })
  describeReleaseTargets(releaseTargetsJson: string = "[]"): string {
    const normalizedTargets = parseReleaseTargets(releaseTargetsJson);

    if (normalizedTargets.length === 0) {
      return "No release targets selected.";
    }

    return `Selected release targets: ${normalizedTargets.join(", ")}`;
  }

  /**
   * Runs the generic Rush build stage for deploy targets selected by ci-plan.json.
   */
  @func({ cache: "never" })
  async buildDeployTargets(
    repo: Directory,
    ciPlanFile: File,
    deployEnvFile?: File,
    dryRun: boolean = false,
  ): Promise<Directory> {
    await assertMetadataContract(repo, {
      validate_application_image_provider_metadata: false,
    });

    return buildDeployTargets(repo, ciPlanFile, deployEnvFile, dryRun);
  }

  /**
   * Materializes deploy package artifacts for deploy targets selected by ci-plan.json.
   */
  @func({ cache: "never" })
  async packageDeployTargets(
    repo: Directory,
    ciPlanFile: File,
    artifactPrefix: string = "deploy-target",
    gitSha: string = "",
    sourceRepositoryUrl: string = "",
    dryRun: boolean = true,
    deployEnvFile?: File,
    applicationImageProvider: string = "off",
  ): Promise<Directory> {
    await assertMetadataContract(repo, {
      validate_application_image_provider_metadata: false,
    });

    return packageDeployTargets(
      repo,
      ciPlanFile,
      artifactPrefix,
      gitSha,
      sourceRepositoryUrl,
      dryRun,
      deployEnvFile,
      applicationImageProvider,
    );
  }

  /**
   * Runs build and package as separate stages while exporting the final packaged workspace once.
   */
  @func({ cache: "never" })
  async buildAndPackageDeployTargets(
    repo: Directory,
    ciPlanFile: File,
    artifactPrefix: string = "deploy-target",
    deployEnvFile?: File,
    dryRun: boolean = false,
    gitSha: string = "",
    sourceRepositoryUrl: string = "",
    applicationImageProvider: string = "off",
  ): Promise<Directory> {
    await assertMetadataContract(repo, {
      validate_application_image_provider_metadata: false,
    });

    return buildAndPackageDeployTargets(
      repo,
      ciPlanFile,
      artifactPrefix,
      deployEnvFile,
      dryRun,
      gitSha,
      sourceRepositoryUrl,
      applicationImageProvider,
    );
  }

  /**
   * Executes the release plan in wave order, applying generic target runtime handling in parallel within each wave.
   */
  @func({ cache: "never" })
  async deployRelease(
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
    runtimeFiles?: Directory,
  ): Promise<string> {
    await assertMetadataContract(repo, {
      validate_application_image_provider_metadata: false,
    });

    return deployRelease(
      repo,
      gitSha,
      releaseTargetsJson,
      environment,
      dryRun,
      deployEnvFile,
      packageManifestFile,
      hostWorkspaceDir,
      toolchainImageProvider,
      toolchainImagePolicy,
      dockerSocket,
      undefined,
      "",
      runtimeFiles,
    );
  }

  /**
   * Validates cross-file Dagger metadata contracts before running release stages.
   */
  @func({ cache: "session" })
  async validateMetadataContract(repo: Directory): Promise<string> {
    return formatMetadataContractValidationResult(
      await validateMetadataContractForRepo(repo),
    );
  }

  /**
   * Runs the deploy-oriented workflow as one Dagger composition: detect, build, package, then deploy.
   */
  @func({ cache: "never" })
  async workflow(
    gitSha: string,
    eventName: string = "push",
    forceTargetsJson: string = "[]",
    prBaseSha: string = "",
    deployTagPrefix: string = "deploy/prod",
    artifactPrefix: string = "deploy-target",
    environment: string = "prod",
    dryRun: boolean = true,
    workflowEnvFile?: File,
    deployEnvFile?: File,
    releaseEnvFile?: File,
    releaseTargetsJson: string = "[]",
    hostWorkspaceDir: string = "",
    toolchainImageProvider: string = "off",
    toolchainImagePolicy: string = "lazy",
    rushCacheProvider: string = "off",
    rushCachePolicy: string = "lazy",
    applicationImageProvider: string = "off",
    sourceMode: string = "local_copy",
    sourceRepositoryUrl: string = "",
    sourceRef: string = "",
    sourceAuthTokenEnv: string = "",
    sourceAuthUsername: string = "",
    dockerSocket?: Socket,
    @argument({
      ignore: ["**/node_modules", ".trunk/out", ".trunk/logs"],
    })
    repo?: Directory,
    runtimeFiles?: Directory,
  ): Promise<string> {
    return runWorkflow({
      repo,
      gitSha,
      eventName,
      forceTargetsJson,
      prBaseSha,
      deployTagPrefix,
      artifactPrefix,
      environment,
      dryRun,
      workflowEnvFile,
      deployEnvFile,
      releaseEnvFile,
      releaseTargetsJson,
      hostWorkspaceDir,
      toolchainImageProvider,
      toolchainImagePolicy,
      rushCacheProvider,
      rushCachePolicy,
      applicationImageProvider,
      sourceMode,
      sourceRepositoryUrl,
      sourceRef,
      sourceAuthTokenEnv,
      sourceAuthUsername,
      dockerSocket,
      runtimeFiles,
    });
  }

  /**
   * Runs Dagger-owned pull-request validation for affected Rush projects.
   */
  @func({ cache: "never" })
  async validate(
    eventName: string = "pull_request",
    prBaseSha: string = "",
    validateTargetsJson: string = "[]",
    gitSha: string = "",
    deployEnvFile?: File,
    toolchainImageProvider: string = "off",
    toolchainImagePolicy: string = "pull-or-build",
    rushCacheProvider: string = "off",
    rushCachePolicy: string = "pull-or-build",
    sourceMode: string = "local_copy",
    sourceRepositoryUrl: string = "",
    sourceRef: string = "",
    sourceAuthTokenEnv: string = "",
    sourceAuthUsername: string = "",
    @argument({
      ignore: ["**/node_modules", ".trunk/out", ".trunk/logs"],
    })
    repo?: Directory,
  ): Promise<string> {
    return validateRelease({
      deployEnvFile,
      eventName,
      gitSha,
      prBaseSha,
      repo,
      rushCachePolicy,
      rushCacheProvider,
      sourceAuthTokenEnv,
      sourceAuthUsername,
      sourceMode,
      sourceRef,
      sourceRepositoryUrl,
      toolchainImagePolicy,
      toolchainImageProvider,
      validateTargetsJson,
    });
  }

  /**
   * Runs the package release/versioning flow from release metadata.
   */
  @func({ cache: "never" })
  async releasePackages(
    gitSha: string = "",
    dryRun: boolean = true,
    releaseEnvFile?: File,
    toolchainImageProvider: string = "off",
    toolchainImagePolicy: string = "lazy",
    rushCacheProvider: string = "off",
    rushCachePolicy: string = "lazy",
    sourceMode: string = "local_copy",
    sourceRepositoryUrl: string = "",
    sourceRef: string = "",
    sourceAuthTokenEnv: string = "",
    sourceAuthUsername: string = "",
    @argument({
      ignore: ["**/node_modules", ".trunk/out", ".trunk/logs"],
    })
    repo?: Directory,
  ): Promise<string> {
    return runReleasePackages({
      dryRun,
      gitSha,
      releaseEnvFile,
      repo,
      rushCachePolicy,
      rushCacheProvider,
      sourceAuthTokenEnv,
      sourceAuthUsername,
      sourceMode,
      sourceRef,
      sourceRepositoryUrl,
      toolchainImagePolicy,
      toolchainImageProvider,
    });
  }
}
