import { Container, Directory } from "@dagger.io/dagger";

import type { CiPlan } from "../model/ci-plan.ts";
import type { NpmReleaseDefinition } from "../model/npm-release.ts";
import { activateApplicationImageProvider } from "../application-images/activation.ts";
import { buildRushBuildSteps } from "../stages/build-stage/rush-build-plan.ts";
import { createCiPlan, formatCiPlan } from "../ci-plan/parse-ci-plan.ts";
import { computeCiPlan } from "../stages/detect/compute-ci-plan.ts";
import {
  executePackagePlans,
  type ExecutePackagePlansOptions,
} from "../stages/package-stage/execute-package-plans.ts";
import { RUSH_WORKDIR } from "../rush/container.ts";
import { canonicalizeFrameworkRuntime } from "../runtime/framework-runtime.ts";
import {
  installRushWithCache,
  prepareRushWorkflowContainer,
  type RushWorkflowContainerOptions,
} from "../rush/workflow-container.ts";
import { buildRushAllProjectsLifecycleSteps } from "../rush/rush-command-plan.ts";
import {
  resolvePackageBuildEnvironmentFromDefinitions,
  withBuildEnvironment,
} from "../stages/build-stage/build-env.ts";
import { logSection } from "../logging/sections.ts";
import {
  preparePackageTargets,
  type PreparedPackageTarget,
} from "../stages/package-stage/package-planning.ts";
import { writePackageRuntimeMetadata } from "../stages/package-stage/package-runtime-metadata.ts";

const CI_PLAN_PATH = ".dagger/runtime/ci-plan.json";
const CI_PLAN_CONTAINER_PATH = `${RUSH_WORKDIR}/${CI_PLAN_PATH}`;

function buildDetectedContainer(
  container: Container,
  ciPlan: CiPlan,
): Container {
  return container.withNewFile(CI_PLAN_CONTAINER_PATH, formatCiPlan(ciPlan));
}

function runBuildStage(
  container: Container,
  ciPlan: CiPlan,
  buildEnv: Record<string, string>,
  buildMode: "all-projects" | "deploy-targets",
): Container {
  logSection("Rush build");

  if (ciPlan.deploy_targets.length === 0 && buildMode === "deploy-targets") {
    console.log("[build] no deploy targets selected");
    return container;
  }

  if (buildMode === "all-projects") {
    console.log("[build] Rush targets: all projects");
  } else {
    console.log(`[build] Rush targets: ${ciPlan.deploy_targets.join(", ")}`);
  }

  if (Object.keys(buildEnv).length > 0) {
    console.log(
      `[build] Environment: ${Object.keys(buildEnv).sort().join(", ")}`,
    );
  }

  let nextContainer = withBuildEnvironment(
    container.withEnvVariable("FAILURE_MODE", "deploy"),
    buildEnv,
  );
  const rushSteps =
    buildMode === "all-projects"
      ? buildRushAllProjectsLifecycleSteps()
      : buildRushBuildSteps(ciPlan);

  for (const { command, args } of rushSteps) {
    console.log(`[build] Rush command: ${args[1]}`);
    nextContainer = nextContainer.withExec([command, ...args], {
      expand: false,
    });
  }

  return nextContainer;
}

async function runPackageStage(
  repo: Directory,
  container: Container,
  ciPlan: CiPlan,
  packageTargets: PreparedPackageTarget[],
  options: ExecutePackagePlansOptions,
): Promise<Directory> {
  logSection("Package deploy artifacts");

  if (ciPlan.deploy_targets.length === 0) {
    console.log("[package] no deploy targets selected");
    return writePackageRuntimeMetadata(
      await canonicalizeFrameworkRuntime(
        repo,
        container.directory(RUSH_WORKDIR),
      ),
      [],
      new Map(),
      undefined,
    );
  }

  return (await executePackagePlans(repo, container, packageTargets, options))
    .repo;
}

export type BuildPackageWorkflowResult = {
  container: Container;
  ciPlan: CiPlan;
  repo: Directory;
};

export type BuildPackageWorkflowOptions = RushWorkflowContainerOptions & {
  applicationImageProvider?: string;
  buildHostEnv?: Record<string, string>;
  dryRun?: boolean;
  gitSha?: string;
  npmReleaseDefinition?: NpmReleaseDefinition;
  protectedEnvironmentNames?: string[];
  releaseTargets?: string[];
  skipDeployPlanning?: boolean;
  sourceRepositoryUrl?: string;
};

function collectCoordinateProtectedEnvironmentNames(
  options: BuildPackageWorkflowOptions,
): string[] {
  const rushCacheProvider = options.rushCacheProviders.providers.github;
  const toolchainImageProvider = options.toolchainImageProviders?.providers.github;

  return [
    ...(options.protectedEnvironmentNames ?? []),
    ...(options.npmReleaseDefinition === undefined
      ? []
      : [options.npmReleaseDefinition.auth.token_env]),
    ...(rushCacheProvider === undefined
      ? []
      : [rushCacheProvider.username_env, rushCacheProvider.token_env]),
    ...(toolchainImageProvider === undefined
      ? []
      : [toolchainImageProvider.username_env, toolchainImageProvider.token_env]),
  ];
}

export async function runBuildPackageWorkflow(
  repo: Directory,
  eventName: string,
  forceTargetsJson: string,
  prBaseSha: string,
  deployTagPrefix: string,
  artifactPrefix: string,
  options: BuildPackageWorkflowOptions,
): Promise<BuildPackageWorkflowResult> {
  logSection("Detect release targets");

  const baseContainer = await prepareRushWorkflowContainer(repo, options);
  const releaseTargets = options.releaseTargets ?? [];
  const deployCiPlan = options.skipDeployPlanning
    ? createCiPlan({
        affectedProjectsByDeployTarget: {},
        deployTargets: [],
        mode: eventName === "pull_request" ? "pull_request" : "release",
        prBaseSha: eventName === "pull_request" ? prBaseSha : "",
        releaseTargets: [],
        validateTargets: [],
      })
    : await computeCiPlan(
        repo,
        baseContainer,
        eventName,
        forceTargetsJson,
        prBaseSha,
        deployTagPrefix,
      );
  const ciPlan = createCiPlan({
    affectedProjectsByDeployTarget:
      deployCiPlan.affected_projects_by_deploy_target,
    deployTargets: deployCiPlan.deploy_targets,
    mode: deployCiPlan.mode,
    prBaseSha: deployCiPlan.pr_base_sha,
    releaseTargets,
    validateTargets: deployCiPlan.validate_targets,
  });
  const detectedContainer = buildDetectedContainer(baseContainer, ciPlan);
  const buildMode = releaseTargets.includes("npm")
    ? "all-projects"
    : "deploy-targets";
  const needsRushLifecycle =
    buildMode === "all-projects" || ciPlan.deploy_targets.length > 0;
  const packageTargets = await preparePackageTargets(
    repo,
    ciPlan.deploy_targets,
    artifactPrefix,
  );
  const applicationImageProviderActivation =
    await activateApplicationImageProvider(repo, packageTargets, {
      applicationImageProvider: options.applicationImageProvider,
      dryRun: options.dryRun ?? false,
      hostEnv: options.buildHostEnv ?? options.hostEnv,
      npmReleaseDefinition: options.npmReleaseDefinition,
      protectedEnvironmentNames:
        collectCoordinateProtectedEnvironmentNames(options),
    });

  console.log(
    `[detect] mode=${ciPlan.mode} deploy_targets=${JSON.stringify(ciPlan.deploy_targets)} release_targets=${JSON.stringify(ciPlan.release_targets)} validate_targets=${JSON.stringify(ciPlan.validate_targets)}`,
  );

  if (!needsRushLifecycle) {
    const packagedRepo = await runPackageStage(
      repo,
      detectedContainer,
      ciPlan,
      packageTargets,
      {
        applicationImageProviderActivation,
        applicationImageProvider: options.applicationImageProvider,
        dryRun: options.dryRun,
        gitSha: options.gitSha,
        hostEnv: options.buildHostEnv ?? options.hostEnv,
        sourceRepositoryUrl: options.sourceRepositoryUrl,
      },
    );

    return {
      container: detectedContainer,
      ciPlan,
      repo: packagedRepo,
    };
  }

  logSection("Rush install cache");

  const rushContainer = await installRushWithCache(
    repo,
    detectedContainer,
    options,
  );
  const buildEnv = resolvePackageBuildEnvironmentFromDefinitions(
    packageTargets,
    options.buildHostEnv ?? options.hostEnv ?? {},
    {
      dryRun: options.dryRun ?? false,
      protectedApplicationImageCredentials:
        applicationImageProviderActivation?.protectedCredentials,
      requirePackageTargets: true,
      stage: "build",
    },
  );
  const builtContainer = runBuildStage(
    rushContainer,
    ciPlan,
    buildEnv,
    buildMode,
  );
  const packagedRepo = await runPackageStage(
    repo,
    builtContainer,
    ciPlan,
    packageTargets,
    {
      applicationImageProviderActivation,
      applicationImageProvider: options.applicationImageProvider,
      dryRun: options.dryRun,
      gitSha: options.gitSha,
      hostEnv: options.buildHostEnv ?? options.hostEnv,
      sourceRepositoryUrl: options.sourceRepositoryUrl,
    },
  );

  return {
    container: builtContainer,
    ciPlan,
    repo: packagedRepo,
  };
}
