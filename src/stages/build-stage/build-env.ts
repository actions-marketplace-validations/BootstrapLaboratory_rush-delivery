import type { Directory } from "@dagger.io/dagger";

import { resolvePassThroughEnvironment } from "../../env/pass-through.ts";
import type { HostEnv } from "../../model/env.ts";
import type { PackageTargetDefinition } from "../../model/package-target.ts";
import {
  assertNoApplicationImageCredentialProjections,
  collectPackageBuildCredentialProjectionIssues,
  type ProtectedApplicationImageCredential,
} from "../../application-images/environment-boundary.ts";
import { loadPackageTargetDefinition } from "../package-stage/load-package-metadata.ts";
import { packageTargetDefinitionPath } from "../package-stage/metadata-paths.ts";

type ResolveBuildEnvironmentOptions = {
  dryRun: boolean;
  protectedApplicationImageCredentials?: ProtectedApplicationImageCredential[];
  requirePackageTargets: boolean;
  stage: string;
};

export type NamedPackageTargetDefinition = {
  definition: PackageTargetDefinition;
  target: string;
};

function assignBuildEnvValue(
  envVars: Record<string, string>,
  name: string,
  value: string,
  target: string,
): void {
  const existingValue = envVars[name];

  if (existingValue !== undefined && existingValue !== value) {
    throw new Error(
      `Build environment variable "${name}" is resolved with different values across selected targets; conflict found at package target "${target}".`,
    );
  }

  envVars[name] = value;
}

export async function resolvePackageBuildEnvironment(
  repo: Directory,
  targets: string[],
  hostEnv: HostEnv,
  options: ResolveBuildEnvironmentOptions,
): Promise<Record<string, string>> {
  const definitions: NamedPackageTargetDefinition[] = [];

  for (const target of targets) {
    if (!(await repo.exists(packageTargetDefinitionPath(target)))) {
      if (options.requirePackageTargets) {
        throw new Error(
          `Package target metadata "${packageTargetDefinitionPath(target)}" is required for ${options.stage}.`,
        );
      }

      continue;
    }

    definitions.push({
      definition: await loadPackageTargetDefinition(repo, target),
      target,
    });
  }

  return resolvePackageBuildEnvironmentFromDefinitions(
    definitions,
    hostEnv,
    options,
  );
}

export function resolvePackageBuildEnvironmentFromDefinitions(
  definitions: NamedPackageTargetDefinition[],
  hostEnv: HostEnv,
  options: ResolveBuildEnvironmentOptions,
): Record<string, string> {
  const envVars: Record<string, string> = {};
  const protectedCredentials =
    options.protectedApplicationImageCredentials ?? [];

  assertNoApplicationImageCredentialProjections(
    definitions.flatMap(({ definition, target }) =>
      collectPackageBuildCredentialProjectionIssues(
        target,
        definition.build,
        protectedCredentials,
      ),
    ),
  );

  for (const { definition, target } of definitions) {
    const targetEnv = resolvePassThroughEnvironment({
      context: "package target build",
      dryRun: options.dryRun,
      hostEnv,
      spec: definition.build,
      target,
    });

    for (const [name, value] of Object.entries(targetEnv)) {
      assignBuildEnvValue(envVars, name, value, target);
    }
  }

  return envVars;
}

export function withBuildEnvironment<
  TContainer extends {
    withEnvVariable(name: string, value: string): TContainer;
  },
>(container: TContainer, envVars: Record<string, string>): TContainer {
  let nextContainer = container;

  for (const [name, value] of Object.entries(envVars)) {
    nextContainer = nextContainer.withEnvVariable(name, value);
  }

  return nextContainer;
}
