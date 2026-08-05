import { Container, Directory, File } from "@dagger.io/dagger";

import { formatCiPlan } from "../../ci-plan/parse-ci-plan.ts";
import { computeCiPlan } from "../detect/compute-ci-plan.ts";
import type { CiPlan } from "../../model/ci-plan.ts";
import { assertMetadataContract } from "../../metadata/dagger-metadata-contract.ts";
import { parseDeployEnvFile } from "../deploy/runtime-env.ts";
import { resolveSource } from "../../source/resolve-source.ts";
import { buildSourceAcquisitionPlan } from "../../source/source-options.ts";
import { buildRushValidationSteps } from "../build-stage/rush-build-plan.ts";
import { RUSH_WORKDIR } from "../../rush/container.ts";
import {
  requiresRushCacheProviderMetadata,
  resolveRushProviderOptions,
} from "../../rush/provider-options.ts";
import {
  installRushWithCache,
  prepareRushWorkflowContainer,
  type RushWorkflowContainerOptions,
} from "../../rush/workflow-container.ts";
import {
  resolvePackageBuildEnvironment,
  withBuildEnvironment,
} from "../build-stage/build-env.ts";
import {
  createManualValidationCiPlan,
  createValidationSummary,
  formatValidationSummary,
  parseValidateTargetsJson,
  shouldUseManualValidationTargets,
} from "./validation-result.ts";
import { runValidationMetadataStage } from "./validation-runner.ts";
import { logSection } from "../../logging/sections.ts";
import {
  hasReleaseReadinessValidation,
  runReleaseReadinessValidation,
} from "../release/release-readiness.ts";

const CI_PLAN_PATH = ".dagger/runtime/ci-plan.json";

export type ValidateInput = {
  deployEnvFile?: File;
  eventName?: string;
  gitSha?: string;
  prBaseSha?: string;
  repo?: Directory;
  rushCachePolicy?: string;
  rushCacheProvider?: string;
  sourceAuthTokenEnv?: string;
  sourceAuthUsername?: string;
  sourceMode?: string;
  sourceRef?: string;
  sourceRepositoryUrl?: string;
  toolchainImagePolicy?: string;
  toolchainImageProvider?: string;
  validateTargetsJson?: string;
};

type ValidationContext = {
  baseContainer?: Container;
  ciPlan: CiPlan;
};

function runValidationStage(container: Container, ciPlan: CiPlan): Container {
  if (ciPlan.validate_targets.length === 0) {
    console.log("[validate] no validate targets selected");
    return container;
  }

  logSection("Rush validation");
  console.log(`[validate] Rush targets: ${ciPlan.validate_targets.join(", ")}`);

  let nextContainer = container.withEnvVariable("FAILURE_MODE", "validate");

  for (const { command, args } of buildRushValidationSteps(ciPlan)) {
    console.log(`[validate] Rush command: ${args[1]}`);
    nextContainer = nextContainer.withExec([command, ...args], {
      expand: false,
    });
  }

  return nextContainer;
}

async function runValidationStages(
  repo: Directory,
  container: Container,
  ciPlan: CiPlan,
  hostEnv: Record<string, string>,
): Promise<Container> {
  const buildEnv = await resolvePackageBuildEnvironment(
    repo,
    ciPlan.validate_targets,
    hostEnv,
    {
      dryRun: false,
      requirePackageTargets: false,
      stage: "validate",
    },
  );

  if (Object.keys(buildEnv).length > 0) {
    console.log(
      `[validate] Environment: ${Object.keys(buildEnv).sort().join(", ")}`,
    );
  }

  const rushValidatedContainer = runValidationStage(
    withBuildEnvironment(container, buildEnv),
    ciPlan,
  );

  if (ciPlan.validate_targets.length === 0) {
    return rushValidatedContainer;
  }

  logSection("Metadata validation");

  return (
    await runValidationMetadataStage(
      repo,
      rushValidatedContainer,
      ciPlan.validate_targets,
    )
  ).container;
}

async function resolveValidationContext(
  repo: Directory,
  eventName: string,
  prBaseSha: string,
  validateTargetsJson: string,
  rushOptions: RushWorkflowContainerOptions,
): Promise<ValidationContext> {
  const validateTargets = parseValidateTargetsJson(validateTargetsJson);

  if (shouldUseManualValidationTargets(eventName, validateTargets)) {
    return {
      ciPlan: createManualValidationCiPlan(
        eventName,
        prBaseSha,
        validateTargets,
      ),
    };
  }

  const baseContainer = await prepareRushWorkflowContainer(repo, rushOptions);

  return {
    baseContainer,
    ciPlan: await computeCiPlan(
      repo,
      baseContainer,
      eventName,
      "[]",
      prBaseSha,
    ),
  };
}

export async function validate(input: ValidateInput): Promise<string> {
  const {
    deployEnvFile,
    eventName = "pull_request",
    gitSha = "",
    prBaseSha = "",
    repo,
    rushCachePolicy = "pull-or-build",
    rushCacheProvider = "off",
    sourceAuthTokenEnv = "",
    sourceAuthUsername = "",
    sourceMode = "local_copy",
    sourceRef = "",
    sourceRepositoryUrl = "",
    toolchainImagePolicy = "pull-or-build",
    toolchainImageProvider = "off",
    validateTargetsJson = "[]",
  } = input;
  const hostEnv = deployEnvFile
    ? parseDeployEnvFile(await deployEnvFile.contents())
    : {};
  const sourcePlan = buildSourceAcquisitionPlan({
    gitSha,
    prBaseSha,
    sourceAuthTokenEnv,
    sourceAuthUsername,
    sourceMode,
    sourceRef,
    sourceRepositoryUrl,
  });

  logSection("Source acquisition");
  console.log(`[source] mode=${sourcePlan.mode}`);
  const sourceRepo = await resolveSource(sourcePlan, { hostEnv, repo });

  await assertMetadataContract(sourceRepo, {
    require_rush_cache_metadata: requiresRushCacheProviderMetadata({
      rushCacheProvider,
    }),
    validate_application_image_provider_metadata: false,
  });

  const rushOptions = {
    hostEnv,
    ...(await resolveRushProviderOptions(sourceRepo, {
      rushCachePolicy,
      rushCacheProvider,
      toolchainImagePolicy,
      toolchainImageProvider,
    })),
  };

  const { baseContainer, ciPlan } = await resolveValidationContext(
    sourceRepo,
    eventName,
    prBaseSha,
    validateTargetsJson,
    rushOptions,
  );
  const shouldRunReleaseReadiness =
    eventName === "pull_request" &&
    (await hasReleaseReadinessValidation(sourceRepo));

  if (ciPlan.validate_targets.length === 0 && !shouldRunReleaseReadiness) {
    console.log("[validate] no validate targets selected");
    return formatValidationSummary(createValidationSummary(ciPlan));
  }

  const validationContainer =
    baseContainer ??
    (await prepareRushWorkflowContainer(sourceRepo, rushOptions));
  const detectedContainer = validationContainer
    .withExec(["mkdir", "-p", `${RUSH_WORKDIR}/.dagger/runtime`], {
      expand: false,
    })
    .withNewFile(`${RUSH_WORKDIR}/${CI_PLAN_PATH}`, formatCiPlan(ciPlan));
  const rushContainer = await installRushWithCache(
    sourceRepo,
    detectedContainer,
    rushOptions,
  );
  const releaseReadyContainer = shouldRunReleaseReadiness
    ? await runReleaseReadinessValidation(sourceRepo, rushContainer)
    : rushContainer;

  await (
    await runValidationStages(
      sourceRepo,
      releaseReadyContainer,
      ciPlan,
      hostEnv,
    )
  ).sync();

  return formatValidationSummary(createValidationSummary(ciPlan));
}
