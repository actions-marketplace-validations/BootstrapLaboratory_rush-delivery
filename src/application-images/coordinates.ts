import type {
  OciRegistryProviderDefinition,
  ResolvedApplicationImageCoordinates,
} from "../model/application-image.ts";

export const APPLICATION_IMAGE_REGISTRY_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;
export const APPLICATION_IMAGE_REPOSITORY_PREFIX_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

export function assertApplicationImageRegistry(
  value: string,
  providerName: string,
  sourceName: string,
): void {
  if (!APPLICATION_IMAGE_REGISTRY_PATTERN.test(value)) {
    throw new Error(
      `Application image provider "${providerName}" registry from ${sourceName} must be an OCI registry authority without a scheme or path.`,
    );
  }
}

export function assertApplicationImageRepositoryPrefix(
  value: string,
  providerName: string,
  sourceName: string,
): void {
  if (!APPLICATION_IMAGE_REPOSITORY_PREFIX_PATTERN.test(value)) {
    throw new Error(
      `Application image provider "${providerName}" repository_prefix from ${sourceName} must be a normalized lowercase OCI repository path.`,
    );
  }
}

function requireCoordinateEnvironmentValue(
  hostEnv: Record<string, string>,
  providerName: string,
  role: "registry" | "repository_prefix",
  environmentName: string,
): string {
  const value = hostEnv[environmentName];

  if (value === undefined || value.length === 0) {
    throw new Error(
      `Application image provider "${providerName}" ${role} requires public routing env ${environmentName}.`,
    );
  }

  return value;
}

function requireCoordinateEnvironmentName(
  environmentName: string | undefined,
  providerName: string,
): string {
  if (environmentName === undefined) {
    throw new Error(
      `Application image provider "${providerName}" coordinate metadata is not a valid XOR definition.`,
    );
  }

  return environmentName;
}

export function resolveApplicationImageCoordinates(
  providerName: string,
  definition: OciRegistryProviderDefinition,
  hostEnv: Record<string, string>,
): ResolvedApplicationImageCoordinates {
  if (
    (definition.registry === undefined) ===
      (definition.registry_env === undefined) ||
    (definition.repository_prefix === undefined) ===
      (definition.repository_prefix_env === undefined)
  ) {
    throw new Error(
      `Application image provider "${providerName}" coordinate metadata is not a valid XOR definition.`,
    );
  }

  const registry =
    definition.registry ??
    requireCoordinateEnvironmentValue(
      hostEnv,
      providerName,
      "registry",
      requireCoordinateEnvironmentName(definition.registry_env, providerName),
    );
  const repositoryPrefix =
    definition.repository_prefix ??
    requireCoordinateEnvironmentValue(
      hostEnv,
      providerName,
      "repository_prefix",
      requireCoordinateEnvironmentName(
        definition.repository_prefix_env,
        providerName,
      ),
    );

  assertApplicationImageRegistry(
    registry,
    providerName,
    definition.registry === undefined
      ? `environment ${definition.registry_env}`
      : "static metadata",
  );
  assertApplicationImageRepositoryPrefix(
    repositoryPrefix,
    providerName,
    definition.repository_prefix === undefined
      ? `environment ${definition.repository_prefix_env}`
      : "static metadata",
  );

  return { registry, repositoryPrefix };
}
