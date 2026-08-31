import {
  Directory,
  ExistsType,
  field,
  File,
  func,
  object,
  Socket,
} from "@dagger.io/dagger";

import { releasePackages as runReleasePackages } from "../stages/release/release-packages.ts";
import { validate as runValidate } from "../stages/validate/validate.ts";
import { workflow as runWorkflow } from "../workflow/workflow.ts";

const REQUIRED_LOCAL_SOURCE_PATHS = [
  { path: ".git", type: ExistsType.DirectoryType },
  { path: ".dagger", type: ExistsType.DirectoryType },
  { path: "rush.json", type: ExistsType.RegularType },
] as const;

async function assertBoundedLocalSource(
  repo: Directory,
  entrypoint: string,
): Promise<void> {
  const missing: string[] = [];

  for (const required of REQUIRED_LOCAL_SOURCE_PATHS) {
    if (!(await repo.exists(required.path, { expectedType: required.type }))) {
      missing.push(required.path);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Bounded local-copy ${entrypoint} requires retained paths: ${missing.join(", ")}.`,
    );
  }
}

/**
 * Source-adapter entrypoints over a caller-filtered local repository Directory.
 */
@object()
export class LocalSource {
  @field()
  readonly repo: Directory;

  constructor(repo: Directory) {
    this.repo = repo;
  }

  /**
   * Runs the release workflow without applying a second static repo filter.
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
    dockerSocket?: Socket,
    runtimeFiles?: Directory,
  ): Promise<string> {
    await assertBoundedLocalSource(this.repo, "workflow");

    return runWorkflow({
      applicationImageProvider,
      artifactPrefix,
      deployEnvFile,
      deployTagPrefix,
      dockerSocket,
      dryRun,
      environment,
      eventName,
      forceTargetsJson,
      gitSha,
      hostWorkspaceDir,
      prBaseSha,
      releaseEnvFile,
      releaseTargetsJson,
      repo: this.repo,
      runtimeFiles,
      rushCachePolicy,
      rushCacheProvider,
      sourceMode: "local_copy",
      toolchainImagePolicy,
      toolchainImageProvider,
      workflowEnvFile,
    });
  }

  /**
   * Runs pull-request validation without applying a second static repo filter.
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
  ): Promise<string> {
    await assertBoundedLocalSource(this.repo, "validate");

    return runValidate({
      deployEnvFile,
      eventName,
      gitSha,
      prBaseSha,
      repo: this.repo,
      rushCachePolicy,
      rushCacheProvider,
      sourceMode: "local_copy",
      toolchainImagePolicy,
      toolchainImageProvider,
      validateTargetsJson,
    });
  }

  /**
   * Runs package release/versioning without applying a second static repo filter.
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
  ): Promise<string> {
    await assertBoundedLocalSource(this.repo, "release-packages");

    return runReleasePackages({
      dryRun,
      gitSha,
      releaseEnvFile,
      repo: this.repo,
      rushCachePolicy,
      rushCacheProvider,
      sourceMode: "local_copy",
      toolchainImagePolicy,
      toolchainImageProvider,
    });
  }
}
