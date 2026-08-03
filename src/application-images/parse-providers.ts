import { parse as parseYaml } from "yaml";

import { assertKnownKeys } from "../metadata/parse-utils.ts";
import type {
  ApplicationImageProvidersDefinition,
  OciRegistryProviderDefinition,
} from "../model/application-image.ts";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const REGISTRY_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;
const REPOSITORY_PREFIX_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

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
      "repository_prefix",
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

  const registry = parseRequiredString(
    "registry" in rawValue ? rawValue.registry : undefined,
    `Application image provider "${providerName}" registry`,
  );

  if (!REGISTRY_PATTERN.test(registry)) {
    throw new Error(
      `Application image provider "${providerName}" registry must be an OCI registry authority without a scheme or path.`,
    );
  }

  const repositoryPrefix = parseRequiredString(
    "repository_prefix" in rawValue ? rawValue.repository_prefix : undefined,
    `Application image provider "${providerName}" repository_prefix`,
  );

  if (!REPOSITORY_PREFIX_PATTERN.test(repositoryPrefix)) {
    throw new Error(
      `Application image provider "${providerName}" repository_prefix must be a normalized lowercase OCI repository path.`,
    );
  }

  return {
    kind,
    registry,
    repository_prefix: repositoryPrefix,
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

  return { providers };
}
