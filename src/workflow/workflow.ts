import { Directory, ExistsType, File, Socket } from "@dagger.io/dagger";

import { deployRelease } from "../stages/deploy/deploy-release.ts";
import { logSection } from "../logging/sections.ts";
import { validateMetadataContract } from "../metadata/dagger-metadata-contract.ts";
import { formatMetadataContractValidationResult } from "../metadata/metadata-contract.ts";
import {
  requiresRushCacheProviderMetadata,
  resolveRushProviderOptions,
} from "../rush/provider-options.ts";
import { resolveSource } from "../source/resolve-source.ts";
import { buildWorkflowSourcePlan } from "../source/source-options.ts";
import { runBuildPackageWorkflow } from "./build-package-runner.ts";
import { executeNpmPackageRelease } from "../stages/release/release-packages.ts";
import { loadOptionalNpmReleaseMetadata } from "../stages/release/load-release-metadata.ts";
import { servicesMeshPath } from "../stages/deploy/metadata-paths.ts";
import { parseReleaseTargets } from "../planning/parse-release-targets.ts";
import {
  mergeWorkflowEnvOverlay,
  mergeWorkflowSourceEnv,
  parseOptionalEnvFile,
} from "./env.ts";
import { selectWorkflowReleaseTargets } from "./release-target-selection.ts";

const PACKAGE_MANIFEST_PATH = ".dagger/runtime/package-manifest.json";

export type WorkflowInput = {
  applicationImageProvider?: string;
  artifactPrefix?: string;
  deployEnvFile?: File;
  deployTagPrefix?: string;
  dockerSocket?: Socket;
  dryRun?: boolean;
  environment?: string;
  eventName?: string;
  forceTargetsJson?: string;
  gitSha: string;
  hostWorkspaceDir?: string;
  prBaseSha?: string;
  releaseEnvFile?: File;
  releaseTargetsJson?: string;
  repo?: Directory;
  runtimeFiles?: Directory;
  rushCachePolicy?: string;
  rushCacheProvider?: string;
  sourceAuthTokenEnv?: string;
  sourceAuthUsername?: string;
  sourceMode?: string;
  sourceRef?: string;
  sourceRepositoryUrl?: string;
  toolchainImagePolicy?: string;
  toolchainImageProvider?: string;
  workflowEnvFile?: File;
};

type WorkflowSideEffectResult = {
  name: string;
  value: string;
};

async function settleWorkflowSideEffects(
  tasks: Array<{
    name: string;
    promise: Promise<string>;
  }>,
): Promise<Record<string, string>> {
  const settled = await Promise.allSettled(
    tasks.map(
      async (task): Promise<WorkflowSideEffectResult> => ({
        name: task.name,
        value: await task.promise,
      }),
    ),
  );
  const failures: string[] = [];
  const results: Record<string, string> = {};

  for (const result of settled) {
    if (result.status === "fulfilled") {
      results[result.value.name] = result.value.value;
      continue;
    }

    failures.push(
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason),
    );
  }

  if (failures.length > 0) {
    throw new Error(
      [
        "Release workflow side effects failed:",
        ...failures.map((failure) => `- ${failure}`),
      ].join("\n"),
    );
  }

  return results;
}

function parseJsonResult(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return source;
  }
}

export async function workflow(input: WorkflowInput): Promise<string> {
  const {
    applicationImageProvider = "off",
    artifactPrefix = "deploy-target",
    deployEnvFile,
    deployTagPrefix = "deploy/prod",
    dockerSocket,
    dryRun = true,
    environment = "prod",
    eventName = "push",
    forceTargetsJson = "[]",
    gitSha,
    hostWorkspaceDir = "",
    prBaseSha = "",
    releaseEnvFile,
    releaseTargetsJson = "[]",
    repo,
    runtimeFiles,
    rushCachePolicy = "lazy",
    rushCacheProvider = "off",
    sourceAuthTokenEnv = "",
    sourceAuthUsername = "",
    sourceMode = "local_copy",
    sourceRef = "",
    sourceRepositoryUrl = "",
    toolchainImagePolicy = "lazy",
    toolchainImageProvider = "off",
    workflowEnvFile,
  } = input;

  logSection("Release workflow");
  const workflowHostEnv = await parseOptionalEnvFile(
    workflowEnvFile,
    "workflow env",
  );
  const deployOverlayEnv = await parseOptionalEnvFile(
    deployEnvFile,
    "deploy env",
  );
  const releaseOverlayEnv = await parseOptionalEnvFile(
    releaseEnvFile,
    "release env",
  );
  const deployHostEnv = mergeWorkflowEnvOverlay(
    workflowHostEnv,
    deployOverlayEnv,
    "deploy env",
  );
  const releaseHostEnv = mergeWorkflowEnvOverlay(
    workflowHostEnv,
    releaseOverlayEnv,
    "release env",
  );
  const sourceHostEnv = mergeWorkflowSourceEnv(
    workflowHostEnv,
    deployOverlayEnv,
    releaseOverlayEnv,
  );
  const requestedReleaseTargets = parseReleaseTargets(releaseTargetsJson);
  const sourcePlan = buildWorkflowSourcePlan({
    sourceAuthTokenEnv,
    sourceAuthUsername,
    deployTagPrefix,
    gitSha,
    prBaseSha,
    sourceMode,
    sourceRef,
    sourceRepositoryUrl,
  });
  logSection("Source acquisition");
  console.log(`[source] mode=${sourcePlan.mode}`);
  const sourceRepo = await resolveSource(sourcePlan, {
    hostEnv: sourceHostEnv,
    repo,
  });
  const deployMetadataExists = await sourceRepo.exists(servicesMeshPath, {
    expectedType: ExistsType.RegularType,
  });
  const requireDeployMetadata =
    deployMetadataExists || requestedReleaseTargets.length === 0;

  logSection("Metadata contract");

  const metadataResult = await validateMetadataContract(sourceRepo, {
    require_deploy_metadata: requireDeployMetadata,
    require_rush_cache_metadata: requiresRushCacheProviderMetadata({
      rushCacheProvider,
    }),
  });
  const releaseTargets = selectWorkflowReleaseTargets(
    releaseTargetsJson,
    metadataResult.release_targets,
  );

  console.log(formatMetadataContractValidationResult(metadataResult));

  const providerOptions = await resolveRushProviderOptions(sourceRepo, {
    rushCachePolicy,
    rushCacheProvider,
    toolchainImagePolicy,
    toolchainImageProvider,
  });

  const {
    ciPlan,
    container,
    repo: packagedRepo,
  } = await runBuildPackageWorkflow(
    sourceRepo,
    eventName,
    forceTargetsJson,
    prBaseSha,
    deployTagPrefix,
    artifactPrefix,
    {
      dryRun,
      applicationImageProvider,
      buildHostEnv: deployHostEnv,
      gitSha,
      hostEnv: sourceHostEnv,
      releaseTargets,
      skipDeployPlanning: !deployMetadataExists,
      sourceRepositoryUrl:
        sourcePlan.mode === "git" ? sourcePlan.repositoryUrl : "",
      ...providerOptions,
    },
  );

  console.log(
    `[workflow] mode=${ciPlan.mode} deploy_targets=${JSON.stringify(ciPlan.deploy_targets)} release_targets=${JSON.stringify(ciPlan.release_targets)} validate_targets=${JSON.stringify(ciPlan.validate_targets)}`,
  );

  const deployTagTokenEnv =
    sourcePlan.mode === "git" ? (sourcePlan.auth?.tokenEnv ?? "") : "";

  const startDeploy = (): Promise<string> =>
    deployMetadataExists
      ? deployRelease(
          packagedRepo,
          gitSha,
          JSON.stringify(ciPlan.deploy_targets),
          environment,
          dryRun,
          deployEnvFile,
          packagedRepo.file(PACKAGE_MANIFEST_PATH),
          hostWorkspaceDir,
          toolchainImageProvider,
          toolchainImagePolicy,
          dockerSocket,
          packagedRepo,
          deployTagTokenEnv,
          runtimeFiles,
          deployHostEnv,
        )
      : Promise.resolve(
          JSON.stringify(
            {
              dryRun,
              environment,
              plan: {
                selectedTargets: [],
                waves: [],
              },
              results: [],
              skipped: true,
            },
            null,
            2,
          ),
        );

  if (releaseTargets.length === 0) {
    return startDeploy();
  }

  const npmReleaseDefinition = await loadOptionalNpmReleaseMetadata(sourceRepo);
  if (npmReleaseDefinition === undefined) {
    throw new Error(
      'Workflow release target "npm" requires .dagger/release/npm.yaml.',
    );
  }

  const deployPromise = startDeploy();
  const releasePromise = executeNpmPackageRelease(
    container,
    npmReleaseDefinition,
    sourcePlan,
    releaseHostEnv,
    dryRun,
  );
  const sideEffects = await settleWorkflowSideEffects([
    {
      name: "deploy",
      promise: deployPromise,
    },
    {
      name: "release_packages",
      promise: releasePromise,
    },
  ]);

  return `${JSON.stringify(
    {
      deploy: parseJsonResult(sideEffects.deploy),
      release_packages: parseJsonResult(sideEffects.release_packages),
    },
    null,
    2,
  )}\n`;
}
