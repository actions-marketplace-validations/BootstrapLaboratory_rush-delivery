import {
  dag,
  type Container,
  type Directory,
  type File,
} from "@dagger.io/dagger";

import { withFreshExecutionCache } from "../../execution/cache-buster.ts";
import type { NpmReleaseDefinition } from "../../model/npm-release.ts";
import type { GitSourcePlan, SourcePlan } from "../../model/source.ts";
import { formatMetadataContractValidationResult } from "../../metadata/metadata-contract.ts";
import { validateMetadataContract } from "../../metadata/dagger-metadata-contract.ts";
import { buildRushAllProjectsLifecycleSteps } from "../../rush/rush-command-plan.ts";
import {
  requiresRushCacheProviderMetadata,
  resolveRushProviderOptions,
} from "../../rush/provider-options.ts";
import {
  installRushWithCache,
  prepareRushWorkflowContainer,
  type RushWorkflowContainerOptions,
} from "../../rush/workflow-container.ts";
import { resolveSource } from "../../source/resolve-source.ts";
import { buildSourceAcquisitionPlan } from "../../source/source-options.ts";
import { logSection } from "../../logging/sections.ts";
import {
  RELEASE_GIT_REPOSITORY_URL_ENV,
  RELEASE_GIT_TARGET_BRANCH_ENV,
  RELEASE_GIT_TOKEN_ENV,
  RELEASE_GIT_USERNAME_ENV,
} from "./git-auth-env.ts";
import {
  RELEASE_GIT_ASKPASS_PATH,
  releaseGitAskpassScript,
} from "./git-askpass.ts";
import { parseEnvFileContents } from "../../env/env-file.ts";
import { loadOptionalNpmReleaseMetadata } from "./load-release-metadata.ts";
import { buildNpmReleaseExecutionPlan } from "./release-command-plan.ts";

export type ReleasePackagesInput = {
  dryRun?: boolean;
  gitSha?: string;
  releaseEnvFile?: File;
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
};

type ReleasePackagesSummary = {
  dry_run: boolean;
  publish: {
    access?: string;
    provenance: boolean;
    registry: string;
    tag: string;
  };
  release_target: "npm";
  versioning: {
    strategy: string;
    target_branch: string;
  };
};

type GitPushAuth = {
  repositoryUrl: string;
  token: string;
  username: string;
};

function requireHostEnv(
  hostEnv: Record<string, string>,
  name: string,
  context: string,
): string {
  const value = hostEnv[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${context} requires host env ${name}.`);
  }

  return value;
}

function requireGitSourcePlan(
  sourcePlan: SourcePlan,
  context: string,
): GitSourcePlan {
  if (sourcePlan.mode !== "git") {
    throw new Error(`${context} requires git source mode.`);
  }

  if (sourcePlan.auth === undefined) {
    throw new Error(`${context} requires Git source auth.`);
  }

  return sourcePlan;
}

function resolveGitPushAuth(
  sourcePlan: SourcePlan,
  hostEnv: Record<string, string>,
  dryRun: boolean,
): GitPushAuth | undefined {
  if (dryRun) {
    return undefined;
  }

  const gitSourcePlan = requireGitSourcePlan(sourcePlan, "NPM package release");
  const token = requireHostEnv(
    hostEnv,
    gitSourcePlan.auth!.tokenEnv,
    "NPM package release Git push",
  );

  return {
    repositoryUrl: gitSourcePlan.repositoryUrl,
    token,
    username: gitSourcePlan.auth!.username,
  };
}

function withNpmPublishAuth(
  container: Container,
  definition: NpmReleaseDefinition,
  hostEnv: Record<string, string>,
  dryRun: boolean,
): Container {
  if (dryRun) {
    return container;
  }

  const token = requireHostEnv(
    hostEnv,
    definition.auth.token_env,
    "NPM package release",
  );

  return container.withSecretVariable(
    definition.auth.token_env,
    dag.setSecret("rush-delivery-npm-token", token),
  );
}

function withNpmPublishEnvironment(
  container: Container,
  definition: NpmReleaseDefinition,
  dryRun: boolean,
): Container {
  if (dryRun || !definition.publish.provenance) {
    return container;
  }

  return container.withEnvVariable("NPM_CONFIG_PROVENANCE", "true");
}

function withGitAuthorIdentity(
  container: Container,
  dryRun: boolean,
): Container {
  if (dryRun) {
    return container;
  }

  return container.withExec(
    [
      "bash",
      "-lc",
      [
        'git config --local user.name "${GIT_AUTHOR_NAME:-rush-delivery}"',
        'git config --local user.email "${GIT_AUTHOR_EMAIL:-rush-delivery@users.noreply.github.com}"',
      ].join(" && "),
    ],
    {
      expand: false,
    },
  );
}

function withGitPushAuth(container: Container, auth: GitPushAuth): Container {
  const tokenSecret = dag.setSecret("rush-delivery-git-push-token", auth.token);

  return container
    .withNewFile(
      RELEASE_GIT_ASKPASS_PATH,
      releaseGitAskpassScript(RELEASE_GIT_USERNAME_ENV, RELEASE_GIT_TOKEN_ENV),
    )
    .withExec(["chmod", "0500", RELEASE_GIT_ASKPASS_PATH])
    .withEnvVariable(RELEASE_GIT_REPOSITORY_URL_ENV, auth.repositoryUrl)
    .withExec(
      [
        "bash",
        "-lc",
        [
          `case "\${${RELEASE_GIT_REPOSITORY_URL_ENV}}" in http://*|https://*) ;; *) echo "NPM package release requires an HTTP(S) Git source URL for token push auth." >&2; exit 1 ;; esac`,
          `if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "\${${RELEASE_GIT_REPOSITORY_URL_ENV}}"; else git remote add origin "\${${RELEASE_GIT_REPOSITORY_URL_ENV}}"; fi`,
        ].join(" && "),
      ],
      {
        expand: false,
      },
    )
    .withSecretVariable(RELEASE_GIT_TOKEN_ENV, tokenSecret)
    .withEnvVariable(RELEASE_GIT_USERNAME_ENV, auth.username)
    .withEnvVariable("GIT_ASKPASS", RELEASE_GIT_ASKPASS_PATH)
    .withEnvVariable("GIT_TERMINAL_PROMPT", "0");
}

function withGitTargetBranch(
  container: Container,
  targetBranch: string,
): Container {
  return container
    .withEnvVariable(RELEASE_GIT_TARGET_BRANCH_ENV, targetBranch)
    .withExec(
      [
        "bash",
        "-lc",
        [
          `target="\${${RELEASE_GIT_TARGET_BRANCH_ENV}}"`,
          'git fetch origin "+refs/heads/${target}:refs/remotes/origin/${target}"',
          'if git show-ref --verify --quiet "refs/heads/${target}"; then git branch --set-upstream-to="origin/${target}" "${target}"; else git branch --track "${target}" "origin/${target}"; fi',
        ].join(" && "),
      ],
      {
        expand: false,
      },
    );
}

function prepareNpmReleaseContainer(
  container: Container,
  definition: NpmReleaseDefinition,
  hostEnv: Record<string, string>,
  dryRun: boolean,
): Container {
  return withNpmPublishEnvironment(
    withNpmPublishAuth(
      withGitAuthorIdentity(container, dryRun),
      definition,
      hostEnv,
      dryRun,
    ),
    definition,
    dryRun,
  );
}

function runRushLifecycle(container: Container): Container {
  logSection("Rush release build");

  let nextContainer = container.withEnvVariable("FAILURE_MODE", "release");

  for (const { command, args } of buildRushAllProjectsLifecycleSteps()) {
    console.log(`[release-packages] Rush command: ${args[1]}`);
    nextContainer = nextContainer.withExec([command, ...args], {
      expand: false,
    });
  }

  return nextContainer;
}

function runNpmRelease(
  container: Container,
  definition: NpmReleaseDefinition,
  sourcePlan: SourcePlan,
  hostEnv: Record<string, string>,
  dryRun: boolean,
): Container {
  logSection("NPM package release");

  const gitPushAuth = resolveGitPushAuth(sourcePlan, hostEnv, dryRun);
  let nextContainer = prepareNpmReleaseContainer(
    container,
    definition,
    hostEnv,
    dryRun,
  );
  nextContainer = withFreshExecutionCache(nextContainer, "npm-release");

  for (const step of buildNpmReleaseExecutionPlan(definition, dryRun)) {
    switch (step.kind) {
      case "git-push-auth": {
        nextContainer = withGitPushAuth(nextContainer, gitPushAuth!);
        break;
      }

      case "git-target-branch": {
        nextContainer = withGitTargetBranch(nextContainer, step.targetBranch);
        break;
      }

      case "rush-publish": {
        const publishStep = step.commandStep;
        console.log(
          `[release-packages] Rush command: ${publishStep.args.slice(1).join(" ")}`,
        );
        nextContainer = nextContainer.withExec(
          [publishStep.command, ...publishStep.args],
          {
            expand: false,
          },
        );
        break;
      }
    }
  }

  return nextContainer;
}

function releaseSummary(
  definition: NpmReleaseDefinition,
  dryRun: boolean,
): ReleasePackagesSummary {
  return {
    dry_run: dryRun,
    publish: {
      ...(definition.publish.access === undefined
        ? {}
        : { access: definition.publish.access }),
      provenance: definition.publish.provenance,
      registry: definition.publish.registry,
      tag: definition.publish.tag,
    },
    release_target: "npm",
    versioning: {
      strategy: definition.versioning.strategy,
      target_branch: definition.versioning.target_branch,
    },
  };
}

export async function executeNpmPackageRelease(
  container: Container,
  definition: NpmReleaseDefinition,
  sourcePlan: SourcePlan,
  hostEnv: Record<string, string>,
  dryRun: boolean,
): Promise<string> {
  await runNpmRelease(
    container,
    definition,
    sourcePlan,
    hostEnv,
    dryRun,
  ).sync();

  return JSON.stringify(releaseSummary(definition, dryRun), null, 2);
}

export async function releasePackages(
  input: ReleasePackagesInput,
): Promise<string> {
  const {
    dryRun = true,
    gitSha = "",
    releaseEnvFile,
    repo,
    rushCachePolicy = "lazy",
    rushCacheProvider = "off",
    sourceAuthTokenEnv = "",
    sourceAuthUsername = "",
    sourceMode = "local_copy",
    sourceRef = "",
    sourceRepositoryUrl = "",
    toolchainImagePolicy = "lazy",
    toolchainImageProvider = "off",
  } = input;
  const hostEnv = releaseEnvFile
    ? parseEnvFileContents(await releaseEnvFile.contents(), "release env")
    : {};
  const sourcePlan = buildSourceAcquisitionPlan({
    gitSha,
    sourceAuthTokenEnv,
    sourceAuthUsername,
    sourceMode,
    sourceRef,
    sourceRepositoryUrl,
  });

  logSection("Source acquisition");
  console.log(`[source] mode=${sourcePlan.mode}`);
  const sourceRepo = await resolveSource(sourcePlan, { hostEnv, repo });

  logSection("Metadata contract");
  console.log(
    formatMetadataContractValidationResult(
      await validateMetadataContract(sourceRepo, {
        require_deploy_metadata: false,
        require_rush_cache_metadata: requiresRushCacheProviderMetadata({
          rushCacheProvider,
        }),
        validate_application_image_provider_metadata: false,
      }),
    ),
  );

  const definition = await loadOptionalNpmReleaseMetadata(sourceRepo);
  if (definition === undefined) {
    console.log("[release-packages] no NPM release metadata configured");
    return JSON.stringify(
      {
        dry_run: dryRun,
        release_target: "npm",
        skipped: true,
      },
      null,
      2,
    );
  }

  const rushOptions: RushWorkflowContainerOptions = {
    hostEnv,
    ...(await resolveRushProviderOptions(sourceRepo, {
      rushCachePolicy,
      rushCacheProvider,
      toolchainImagePolicy,
      toolchainImageProvider,
    })),
  };
  const baseContainer = await prepareRushWorkflowContainer(
    sourceRepo,
    rushOptions,
  );
  const rushContainer = await installRushWithCache(
    sourceRepo,
    baseContainer,
    rushOptions,
  );
  const builtContainer = runRushLifecycle(rushContainer);

  return executeNpmPackageRelease(
    builtContainer,
    definition,
    sourcePlan,
    hostEnv,
    dryRun,
  );
}
