import path from "node:path";

import { applicationImageProvidersPath } from "../application-images/metadata-paths.ts";
import { parseApplicationImageProviders } from "../application-images/parse-providers.ts";
import type { DeployRuntimeSpec } from "../model/deploy-target.ts";
import type { EnvPassthroughSpec } from "../model/env.ts";
import type {
  PackageBuildSpec,
  PackageTargetDefinition,
} from "../model/package-target.ts";
import { buildDeploymentPlan } from "../planning/build-deployment-plan.ts";
import { parseServicesMesh } from "../planning/parse-services-mesh.ts";
import {
  deployTargetsDirectory,
  servicesMeshPath,
  targetDefinitionPath,
} from "../stages/deploy/metadata-paths.ts";
import { parseDeployTarget } from "../stages/deploy/parse-deploy-target.ts";
import {
  packageTargetDefinitionPath,
  packageTargetsDirectory,
} from "../stages/package-stage/metadata-paths.ts";
import { parsePackageTarget } from "../stages/package-stage/parse-package-target.ts";
import {
  validationTargetDefinitionPath,
  validationTargetsDirectory,
} from "../stages/validate/metadata-paths.ts";
import { parseValidationTarget } from "../stages/validate/parse-validation-target.ts";
import {
  parseRushProjects,
  type RushProjectDefinition,
} from "./rush-projects.ts";
import { parseRushCacheProviders } from "../rush-cache/parse-providers.ts";
import { rushCacheProvidersPath } from "../rush-cache/metadata-paths.ts";
import type { NpmReleaseDefinition } from "../model/npm-release.ts";
import {
  npmReleaseMetadataPath,
  releaseMetadataDirectory,
} from "../stages/release/metadata-paths.ts";
import { parseNpmRelease } from "../stages/release/parse-npm-release.ts";

type RepositoryPathType = "directory" | "file";

export type MetadataContractRepository = {
  entries(path: string): Promise<string[]>;
  exists(path: string, expectedType: RepositoryPathType): Promise<boolean>;
  isSymlink(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
};

export type MetadataContractValidationResult = {
  deploy_targets: string[];
  package_targets: string[];
  release_targets: string[];
  rush_projects: string[];
  validation_targets: string[];
};

export type MetadataContractValidationOptions = {
  require_application_image_provider_metadata?: boolean;
  require_deploy_metadata?: boolean;
  require_rush_cache_metadata?: boolean;
};

async function validateApplicationImageProviderMetadata(
  repository: MetadataContractRepository,
  issues: string[],
  required: boolean,
): Promise<void> {
  const exists = await repository.exists(applicationImageProvidersPath, "file");

  if (!exists) {
    if (required) {
      issues.push(
        `Application image provider metadata file "${applicationImageProvidersPath}" must exist.`,
      );
    }
    return;
  }

  await readParsed(
    repository,
    applicationImageProvidersPath,
    "Application image provider metadata file",
    parseApplicationImageProviders,
    issues,
  );
}

function formatIssueList(issues: string[]): string {
  return [
    "Dagger metadata contract validation failed:",
    ...issues.map((issue) => `- ${issue}`),
  ].join("\n");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function validateRepoRelativePath(
  value: string,
  name: string,
  issues: string[],
): void {
  const normalized = value.replace(/\\/g, "/");

  if (normalized.length === 0 || normalized === ".") {
    issues.push(`${name} must be a repository-relative path.`);
    return;
  }

  if (isAbsolutePath(normalized)) {
    issues.push(`${name} must be a repository-relative path, got "${value}".`);
    return;
  }

  if (normalized.split("/").some((segment) => segment === "..")) {
    issues.push(`${name} must stay inside the repository, got "${value}".`);
  }
}

async function fileExists(
  repository: MetadataContractRepository,
  filePath: string,
  description: string,
  issues: string[],
): Promise<boolean> {
  if (!(await repository.exists(filePath, "file"))) {
    issues.push(`${description} "${filePath}" must exist.`);
    return false;
  }

  return true;
}

async function directoryExists(
  repository: MetadataContractRepository,
  directoryPath: string,
  description: string,
  issues: string[],
): Promise<void> {
  if (!(await repository.exists(directoryPath, "directory"))) {
    issues.push(`${description} "${directoryPath}" must exist.`);
  }
}

async function fileMustNotBeSymlink(
  repository: MetadataContractRepository,
  filePath: string,
  description: string,
  issues: string[],
): Promise<void> {
  if (await repository.isSymlink(filePath)) {
    issues.push(`${description} "${filePath}" must not be a symlink.`);
  }
}

async function readParsed<T>(
  repository: MetadataContractRepository,
  filePath: string,
  description: string,
  parser: (contents: string) => T,
  issues: string[],
): Promise<T | undefined> {
  try {
    return parser(await repository.readTextFile(filePath));
  } catch (error) {
    issues.push(
      `${description} "${filePath}" is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function yamlTargetNames(entries: string[]): string[] {
  return entries
    .filter((entry) => entry.endsWith(".yaml"))
    .map((entry) => path.posix.basename(entry, ".yaml"))
    .sort();
}

async function listYamlTargets(
  repository: MetadataContractRepository,
  directoryPath: string,
  issues: string[],
): Promise<string[]> {
  try {
    if (!(await repository.exists(directoryPath, "directory"))) {
      return [];
    }

    return yamlTargetNames(await repository.entries(directoryPath));
  } catch (error) {
    issues.push(
      `Unable to list metadata directory "${directoryPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function loadRushProjects(
  repository: MetadataContractRepository,
  issues: string[],
): Promise<Map<string, RushProjectDefinition>> {
  const projects =
    (await readParsed(
      repository,
      "rush.json",
      "Rush project file",
      parseRushProjects,
      issues,
    )) ?? [];
  const projectsByName = new Map(
    projects.map((project) => [project.packageName, project]),
  );

  for (const project of projects) {
    await directoryExists(
      repository,
      project.projectFolder,
      `Rush project "${project.packageName}" folder`,
      issues,
    );
    await fileExists(
      repository,
      `${project.projectFolder}/package.json`,
      `Rush project "${project.packageName}" package file`,
      issues,
    );
  }

  return projectsByName;
}

async function validateRushCacheMetadata(
  repository: MetadataContractRepository,
  issues: string[],
  required: boolean,
): Promise<void> {
  const exists = await repository.exists(rushCacheProvidersPath, "file");

  if (!exists) {
    if (required) {
      issues.push(
        `Rush cache provider metadata file "${rushCacheProvidersPath}" must exist.`,
      );
    }
    return;
  }

  const definition = await readParsed(
    repository,
    rushCacheProvidersPath,
    "Rush cache provider metadata file",
    parseRushCacheProviders,
    issues,
  );

  if (!definition) {
    return;
  }

  void definition;
}

async function validateNpmReleaseMetadata(
  repository: MetadataContractRepository,
  issues: string[],
): Promise<NpmReleaseDefinition | undefined> {
  if (!(await repository.exists(npmReleaseMetadataPath, "file"))) {
    return undefined;
  }

  const definition = await readParsed(
    repository,
    npmReleaseMetadataPath,
    "NPM release metadata file",
    parseNpmRelease,
    issues,
  );

  if (!definition) {
    return undefined;
  }

  if (definition.auth.kind === "token") {
    await fileExists(
      repository,
      "common/config/rush/.npmrc-publish",
      "NPM release token auth .npmrc-publish file",
      issues,
    );
  }

  return definition;
}

async function validateReleaseMetadata(
  repository: MetadataContractRepository,
  issues: string[],
): Promise<string[]> {
  const releaseTargets = await listYamlTargets(
    repository,
    releaseMetadataDirectory,
    issues,
  );

  for (const target of releaseTargets) {
    if (target !== "npm") {
      issues.push(
        `Release metadata "${releaseMetadataDirectory}/${target}.yaml" is not supported.`,
      );
    }
  }

  const npmRelease = await validateNpmReleaseMetadata(repository, issues);

  return npmRelease === undefined ? [] : ["npm"];
}

function validatePackageArtifact(
  target: string,
  definition: PackageTargetDefinition,
  rushProjects: Map<string, RushProjectDefinition>,
  issues: string[],
): void {
  if (definition.artifact.kind === "directory") {
    validateRepoRelativePath(
      definition.artifact.path,
      `Package target "${target}" artifact path`,
      issues,
    );
    return;
  }

  if (definition.artifact.kind === "oci_image") {
    if (definition.artifact.context !== ".") {
      validateRepoRelativePath(
        definition.artifact.context,
        `Package target "${target}" OCI context`,
        issues,
      );
    }
    validateRepoRelativePath(
      definition.artifact.dockerfile,
      `Package target "${target}" OCI dockerfile`,
      issues,
    );
    if (definition.artifact.scan.ignore_file !== undefined) {
      validateRepoRelativePath(
        definition.artifact.scan.ignore_file,
        `Package target "${target}" OCI scan ignore_file`,
        issues,
      );
    }
    return;
  }

  if (!rushProjects.has(definition.artifact.project)) {
    issues.push(
      `Package target "${target}" artifact project "${definition.artifact.project}" must be a Rush project.`,
    );
  }

  validateRepoRelativePath(
    definition.artifact.output,
    `Package target "${target}" artifact output`,
    issues,
  );
}

async function validateOciPackageArtifactFiles(
  repository: MetadataContractRepository,
  target: string,
  definition: PackageTargetDefinition,
  issues: string[],
): Promise<void> {
  if (definition.artifact.kind !== "oci_image") {
    return;
  }

  await directoryExists(
    repository,
    definition.artifact.context,
    `Package target "${target}" OCI context`,
    issues,
  );
  const dockerfileExists = await fileExists(
    repository,
    definition.artifact.dockerfile,
    `Package target "${target}" OCI dockerfile`,
    issues,
  );
  if (dockerfileExists) {
    await fileMustNotBeSymlink(
      repository,
      definition.artifact.dockerfile,
      `Package target "${target}" OCI dockerfile`,
      issues,
    );
  }

  if (definition.artifact.scan.ignore_file !== undefined) {
    await fileExists(
      repository,
      definition.artifact.scan.ignore_file,
      `Package target "${target}" OCI scan ignore_file`,
      issues,
    );
  }
}

function validateEnvPassthroughDefaults(
  context: string,
  spec: EnvPassthroughSpec | PackageBuildSpec,
  issues: string[],
): void {
  const requiredSourceNames = new Set([
    ...spec.pass_env,
    ...Object.values(spec.map_env),
  ]);

  for (const envName of requiredSourceNames) {
    if (!(envName in spec.dry_run_defaults)) {
      issues.push(
        `${context} "${envName}" must have a dry_run_defaults value.`,
      );
    }
  }
}

function validateDeployRuntime(
  target: string,
  runtime: DeployRuntimeSpec,
  issues: string[],
): void {
  validateEnvPassthroughDefaults(
    `Deploy target "${target}" pass-through env`,
    runtime,
    issues,
  );

  for (const fileMount of runtime.file_mounts) {
    if (fileMount.kind === "runtime_file") {
      continue;
    }

    if (!runtime.required_host_env.includes(fileMount.source_var)) {
      issues.push(
        `Deploy target "${target}" file mount source_var "${fileMount.source_var}" must be listed in required_host_env.`,
      );
    }
  }

  if (runtime.workspace.mode === "full") {
    return;
  }

  for (const directoryPath of runtime.workspace.dirs) {
    validateRepoRelativePath(
      directoryPath,
      `Deploy target "${target}" runtime workspace dir`,
      issues,
    );
  }

  for (const filePath of runtime.workspace.files) {
    validateRepoRelativePath(
      filePath,
      `Deploy target "${target}" runtime workspace file`,
      issues,
    );
  }
}

function validateTargetIsRushProject(
  target: string,
  rushProjects: Map<string, RushProjectDefinition>,
  kind: string,
  issues: string[],
): void {
  if (!rushProjects.has(target)) {
    issues.push(`${kind} "${target}" must match a Rush project packageName.`);
  }
}

async function validateDeployTarget(
  repository: MetadataContractRepository,
  target: string,
  rushProjects: Map<string, RushProjectDefinition>,
  issues: string[],
): Promise<void> {
  const deployPath = targetDefinitionPath(target);

  if (
    !(await fileExists(
      repository,
      deployPath,
      `Deploy target "${target}" metadata file`,
      issues,
    ))
  ) {
    return;
  }

  const definition = await readParsed(
    repository,
    deployPath,
    `Deploy target "${target}" metadata file`,
    parseDeployTarget,
    issues,
  );

  if (!definition) {
    return;
  }

  if (definition.name !== target) {
    issues.push(
      `Deploy target metadata "${deployPath}" must declare name "${target}", got "${definition.name}".`,
    );
  }

  validateTargetIsRushProject(target, rushProjects, "Deploy target", issues);
  validateRepoRelativePath(
    definition.deploy_script,
    `Deploy target "${target}" deploy_script`,
    issues,
  );
  await fileExists(
    repository,
    definition.deploy_script,
    `Deploy target "${target}" deploy_script`,
    issues,
  );
  validateDeployRuntime(target, definition.runtime, issues);
}

async function validatePackageTarget(
  repository: MetadataContractRepository,
  target: string,
  rushProjects: Map<string, RushProjectDefinition>,
  issues: string[],
): Promise<void> {
  const packagePath = packageTargetDefinitionPath(target);

  if (
    !(await fileExists(
      repository,
      packagePath,
      `Package target "${target}" metadata file`,
      issues,
    ))
  ) {
    return;
  }

  const definition = await readParsed(
    repository,
    packagePath,
    `Package target "${target}" metadata file`,
    parsePackageTarget,
    issues,
  );

  if (!definition) {
    return;
  }

  if (definition.name !== target) {
    issues.push(
      `Package target metadata "${packagePath}" must declare name "${target}", got "${definition.name}".`,
    );
  }

  validateTargetIsRushProject(target, rushProjects, "Package target", issues);
  validatePackageArtifact(target, definition, rushProjects, issues);
  await validateOciPackageArtifactFiles(
    repository,
    target,
    definition,
    issues,
  );
  validateEnvPassthroughDefaults(
    `Package target "${target}" build env`,
    definition.build,
    issues,
  );
}

async function validateValidationTarget(
  repository: MetadataContractRepository,
  target: string,
  rushProjects: Map<string, RushProjectDefinition>,
  issues: string[],
): Promise<void> {
  const validationPath = validationTargetDefinitionPath(target);
  const definition = await readParsed(
    repository,
    validationPath,
    `Validation target "${target}" metadata file`,
    parseValidationTarget,
    issues,
  );

  if (!definition) {
    return;
  }

  if (definition.name !== target) {
    issues.push(
      `Validation target metadata "${validationPath}" must declare name "${target}", got "${definition.name}".`,
    );
  }

  validateTargetIsRushProject(
    target,
    rushProjects,
    "Validation target",
    issues,
  );
}

function validateNoOrphanTargets(
  targetKind: string,
  directoryPath: string,
  metadataTargets: string[],
  meshTargets: string[],
  issues: string[],
): void {
  const meshTargetSet = new Set(meshTargets);
  for (const target of metadataTargets) {
    if (!meshTargetSet.has(target)) {
      issues.push(
        `${targetKind} metadata "${directoryPath}/${target}.yaml" is not referenced by services mesh.`,
      );
    }
  }
}

export async function validateMetadataContractRepository(
  repository: MetadataContractRepository,
  options: MetadataContractValidationOptions = {},
): Promise<MetadataContractValidationResult> {
  const requireDeployMetadata = options.require_deploy_metadata ?? true;
  const requireApplicationImageProviderMetadata =
    options.require_application_image_provider_metadata ?? false;
  const requireRushCacheMetadata = options.require_rush_cache_metadata ?? true;
  const issues: string[] = [];
  const rushProjects = await loadRushProjects(repository, issues);
  await validateApplicationImageProviderMetadata(
    repository,
    issues,
    requireApplicationImageProviderMetadata,
  );
  await validateRushCacheMetadata(repository, issues, requireRushCacheMetadata);
  const releaseTargets = await validateReleaseMetadata(repository, issues);

  if (!requireDeployMetadata) {
    if (issues.length > 0) {
      throw new Error(formatIssueList(issues));
    }

    return {
      deploy_targets: [],
      package_targets: [],
      release_targets: releaseTargets,
      rush_projects: [...rushProjects.keys()].sort(),
      validation_targets: [],
    };
  }

  const servicesMesh = await readParsed(
    repository,
    servicesMeshPath,
    "Services mesh",
    parseServicesMesh,
    issues,
  );

  if (!servicesMesh) {
    throw new Error(formatIssueList(issues));
  }

  const deployTargets = Object.keys(servicesMesh.services).sort();

  try {
    buildDeploymentPlan(servicesMesh, deployTargets);
  } catch (error) {
    issues.push(
      `Services mesh deploy graph is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const deployMetadataTargets = await listYamlTargets(
    repository,
    deployTargetsDirectory,
    issues,
  );
  const packageMetadataTargets = await listYamlTargets(
    repository,
    packageTargetsDirectory,
    issues,
  );
  const validationTargets = await listYamlTargets(
    repository,
    validationTargetsDirectory,
    issues,
  );

  validateNoOrphanTargets(
    "Deploy target",
    deployTargetsDirectory,
    deployMetadataTargets,
    deployTargets,
    issues,
  );
  validateNoOrphanTargets(
    "Package target",
    packageTargetsDirectory,
    packageMetadataTargets,
    deployTargets,
    issues,
  );

  await Promise.all(
    deployTargets.flatMap((target) => [
      validateDeployTarget(repository, target, rushProjects, issues),
      validatePackageTarget(repository, target, rushProjects, issues),
    ]),
  );
  await Promise.all(
    validationTargets.map((target) =>
      validateValidationTarget(repository, target, rushProjects, issues),
    ),
  );

  if (issues.length > 0) {
    throw new Error(formatIssueList(issues));
  }

  return {
    deploy_targets: deployTargets,
    package_targets: packageMetadataTargets,
    release_targets: releaseTargets,
    rush_projects: [...rushProjects.keys()].sort(),
    validation_targets: validationTargets,
  };
}

export function formatMetadataContractValidationResult(
  result: MetadataContractValidationResult,
): string {
  return JSON.stringify(result, null, 2);
}
