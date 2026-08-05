import { parse as parseYaml } from "yaml";

import { assertKnownKeys } from "../metadata/parse-utils.ts";
import type {
  ApplicationImageProvidersDefinition,
  OciRegistryProviderDefinition,
} from "../model/application-image.ts";
import {
  assertApplicationImageCoordinateNameSeparation,
  assertUniqueApplicationImageCredentialNames,
} from "./environment-boundary.ts";
import {
  APPLICATION_IMAGE_REGISTRY_PATTERN,
  APPLICATION_IMAGE_REPOSITORY_PREFIX_PATTERN,
} from "./coordinates.ts";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

function parseRequiredString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return rawValue;
}

function parseEnvName(rawValue: unknown, name: string): string {
  const value = parseRequiredString(rawValue, name);

  if (!ENV_NAME_PATTERN.test(value)) {
    throw new Error(`${name} "${value}" must match ${ENV_NAME_PATTERN}.`);
  }

  return value;
}

function parseProvider(
  rawValue: unknown,
  providerName: string,
): OciRegistryProviderDefinition {
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw new Error(
      `Application image provider "${providerName}" must be a mapping.`,
    );
  }

  assertKnownKeys(
    rawValue as Record<string, unknown>,
    [
      "kind",
      "registry",
      "registry_env",
      "repository_prefix",
      "repository_prefix_env",
      "signing_key_env",
      "signing_password_env",
      "token_env",
      "username_env",
      "verification_key_env",
    ],
    `Application image provider "${providerName}"`,
  );

  const kind = parseRequiredString(
    "kind" in rawValue ? rawValue.kind : undefined,
    `Application image provider "${providerName}" kind`,
  );

  if (kind !== "oci_registry") {
    throw new Error(
      `Application image provider "${providerName}" kind must be "oci_registry".`,
    );
  }

  const hasRegistry = "registry" in rawValue;
  const hasRegistryEnv = "registry_env" in rawValue;
  const hasRepositoryPrefix = "repository_prefix" in rawValue;
  const hasRepositoryPrefixEnv = "repository_prefix_env" in rawValue;

  if (hasRegistry === hasRegistryEnv) {
    throw new Error(
      `Application image provider "${providerName}" must define exactly one of registry or registry_env.`,
    );
  }

  if (hasRepositoryPrefix === hasRepositoryPrefixEnv) {
    throw new Error(
      `Application image provider "${providerName}" must define exactly one of repository_prefix or repository_prefix_env.`,
    );
  }

  const registry = hasRegistry
    ? parseRequiredString(
        rawValue.registry,
        `Application image provider "${providerName}" registry`,
      )
    : undefined;
  const registryEnv = hasRegistryEnv
    ? parseEnvName(
        rawValue.registry_env,
        `Application image provider "${providerName}" registry_env`,
      )
    : undefined;

  if (
    registry !== undefined &&
    !APPLICATION_IMAGE_REGISTRY_PATTERN.test(registry)
  ) {
    throw new Error(
      `Application image provider "${providerName}" registry must be an OCI registry authority without a scheme or path.`,
    );
  }

  const repositoryPrefix = hasRepositoryPrefix
    ? parseRequiredString(
        rawValue.repository_prefix,
        `Application image provider "${providerName}" repository_prefix`,
      )
    : undefined;
  const repositoryPrefixEnv = hasRepositoryPrefixEnv
    ? parseEnvName(
        rawValue.repository_prefix_env,
        `Application image provider "${providerName}" repository_prefix_env`,
      )
    : undefined;

  if (
    repositoryPrefix !== undefined &&
    !APPLICATION_IMAGE_REPOSITORY_PREFIX_PATTERN.test(repositoryPrefix)
  ) {
    throw new Error(
      `Application image provider "${providerName}" repository_prefix must be a normalized lowercase OCI repository path.`,
    );
  }

  return {
    kind,
    ...(registry === undefined ? {} : { registry }),
    ...(registryEnv === undefined ? {} : { registry_env: registryEnv }),
    ...(repositoryPrefix === undefined
      ? {}
      : { repository_prefix: repositoryPrefix }),
    ...(repositoryPrefixEnv === undefined
      ? {}
      : { repository_prefix_env: repositoryPrefixEnv }),
    signing_key_env: parseEnvName(
      "signing_key_env" in rawValue ? rawValue.signing_key_env : undefined,
      `Application image provider "${providerName}" signing_key_env`,
    ),
    signing_password_env: parseEnvName(
      "signing_password_env" in rawValue
        ? rawValue.signing_password_env
        : undefined,
      `Application image provider "${providerName}" signing_password_env`,
    ),
    token_env: parseEnvName(
      "token_env" in rawValue ? rawValue.token_env : undefined,
      `Application image provider "${providerName}" token_env`,
    ),
    username_env: parseEnvName(
      "username_env" in rawValue ? rawValue.username_env : undefined,
      `Application image provider "${providerName}" username_env`,
    ),
    verification_key_env: parseEnvName(
      "verification_key_env" in rawValue
        ? rawValue.verification_key_env
        : undefined,
      `Application image provider "${providerName}" verification_key_env`,
    ),
  };
}

export function parseApplicationImageProviders(
  providersYaml: string,
): ApplicationImageProvidersDefinition {
  const parsedValue = parseYaml(providersYaml);

  if (
    typeof parsedValue !== "object" ||
    parsedValue === null ||
    Array.isArray(parsedValue)
  ) {
    throw new Error(
      "Application image providers file must define a top-level mapping.",
    );
  }

  assertKnownKeys(
    parsedValue as Record<string, unknown>,
    ["providers"],
    "Application image providers file",
  );
  const rawProviders =
    "providers" in parsedValue ? parsedValue.providers : undefined;

  if (
    typeof rawProviders !== "object" ||
    rawProviders === null ||
    Array.isArray(rawProviders)
  ) {
    throw new Error("Application image providers must be a mapping.");
  }

  const providers: Record<string, OciRegistryProviderDefinition> = {};

  for (const [providerName, rawProvider] of Object.entries(rawProviders)) {
    if (providerName === "off" || !PROVIDER_NAME_PATTERN.test(providerName)) {
      throw new Error(
        `Application image provider name "${providerName}" is invalid or reserved.`,
      );
    }

    providers[providerName] = parseProvider(rawProvider, providerName);
  }

  const definition = { providers };
  assertUniqueApplicationImageCredentialNames(definition);
  assertApplicationImageCoordinateNameSeparation(definition);
  return definition;
}
