import type { Directory, ExistsType } from "@dagger.io/dagger";

import { assertKnownKeys } from "../metadata/parse-utils.ts";
import {
  APPLICATION_IMAGE_CREDENTIAL_FIELDS,
  type ApplicationImageCredentialField,
  type ProtectedApplicationImageCredential,
} from "./environment-boundary.ts";

export const APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH =
  ".dagger/runtime/application-image-credential-capability.json";

const APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_SCHEMA =
  "rush-delivery-application-image-credential-capability/v1";
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const CREDENTIAL_FIELD_SET = new Set<string>(
  APPLICATION_IMAGE_CREDENTIAL_FIELDS,
);
const REGULAR_FILE_TYPE = "REGULAR_TYPE" as ExistsType;

type ApplicationImageCredentialCapability = {
  credentials: ProtectedApplicationImageCredential[];
  schema_version: typeof APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_SCHEMA;
};

function parseObject(
  rawValue: unknown,
  context: string,
): Record<string, unknown> {
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw new Error(`${context} must be a JSON object.`);
  }

  return rawValue as Record<string, unknown>;
}

function parseRequiredString(rawValue: unknown, context: string): string {
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }

  return rawValue;
}

function parseCredentialField(
  rawValue: unknown,
  context: string,
): ApplicationImageCredentialField {
  const field = parseRequiredString(rawValue, context);

  if (!CREDENTIAL_FIELD_SET.has(field)) {
    throw new Error(`${context} is not a supported credential field.`);
  }

  return field as ApplicationImageCredentialField;
}

function canonicalizeCredentials(
  credentials: ProtectedApplicationImageCredential[],
): ProtectedApplicationImageCredential[] {
  if (credentials.length === 0) {
    throw new Error(
      "Application image credential capability must protect at least one provider.",
    );
  }

  const credentialNames = new Set<string>();
  const fieldsByProvider = new Map<
    string,
    Set<ApplicationImageCredentialField>
  >();

  for (const { field, name, provider } of credentials) {
    if (!CREDENTIAL_FIELD_SET.has(field)) {
      throw new Error(
        `Application image credential capability field "${field}" is not supported.`,
      );
    }

    if (!PROVIDER_NAME_PATTERN.test(provider) || provider === "off") {
      throw new Error(
        `Application image credential capability provider "${provider}" is invalid or reserved.`,
      );
    }

    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(
        `Application image credential capability environment name "${name}" must match ${ENV_NAME_PATTERN}.`,
      );
    }

    if (credentialNames.has(name)) {
      throw new Error(
        `Application image credential capability environment name "${name}" must be globally unique.`,
      );
    }
    credentialNames.add(name);

    const providerFields = fieldsByProvider.get(provider) ?? new Set();
    if (providerFields.has(field)) {
      throw new Error(
        `Application image credential capability provider "${provider}" repeats field "${field}".`,
      );
    }
    providerFields.add(field);
    fieldsByProvider.set(provider, providerFields);
  }

  for (const [provider, providerFields] of fieldsByProvider) {
    const missingFields = APPLICATION_IMAGE_CREDENTIAL_FIELDS.filter(
      (field) => !providerFields.has(field),
    );

    if (missingFields.length > 0) {
      throw new Error(
        `Application image credential capability provider "${provider}" is missing field${missingFields.length === 1 ? "" : "s"}: ${missingFields.join(", ")}.`,
      );
    }
  }

  const fieldOrder = new Map(
    APPLICATION_IMAGE_CREDENTIAL_FIELDS.map((field, index) => [field, index]),
  );

  return [...credentials].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      fieldOrder.get(left.field)! - fieldOrder.get(right.field)!,
  );
}

export function createApplicationImageCredentialCapability(
  credentials: ProtectedApplicationImageCredential[],
): ApplicationImageCredentialCapability {
  return {
    credentials: canonicalizeCredentials(credentials),
    schema_version: APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_SCHEMA,
  };
}

export function formatApplicationImageCredentialCapability(
  credentials: ProtectedApplicationImageCredential[],
): string {
  return `${JSON.stringify(
    createApplicationImageCredentialCapability(credentials),
    null,
    2,
  )}\n`;
}

export function parseApplicationImageCredentialCapability(
  source: string,
): ProtectedApplicationImageCredential[] {
  let rawValue: unknown;

  try {
    rawValue = JSON.parse(source);
  } catch {
    throw new Error(
      "Application image credential capability must be valid JSON.",
    );
  }

  const capability = parseObject(
    rawValue,
    "Application image credential capability",
  );
  assertKnownKeys(
    capability,
    ["credentials", "schema_version"],
    "Application image credential capability",
  );

  if (
    capability.schema_version !== APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_SCHEMA
  ) {
    throw new Error(
      `Application image credential capability schema_version must be "${APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_SCHEMA}".`,
    );
  }

  if (!Array.isArray(capability.credentials)) {
    throw new Error(
      "Application image credential capability credentials must be an array.",
    );
  }

  const credentials = capability.credentials.map((rawCredential, index) => {
    const context = `Application image credential capability credentials[${index}]`;
    const credential = parseObject(rawCredential, context);
    assertKnownKeys(credential, ["field", "name", "provider"], context);

    return {
      field: parseCredentialField(credential.field, `${context} field`),
      name: parseRequiredString(credential.name, `${context} name`),
      provider: parseRequiredString(credential.provider, `${context} provider`),
    };
  });

  return canonicalizeCredentials(credentials);
}

export async function loadOptionalApplicationImageCredentialCapability(
  repo: Directory,
): Promise<ProtectedApplicationImageCredential[] | undefined> {
  if (
    !(await repo.exists(APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH, {
      doNotFollowSymlinks: true,
    }))
  ) {
    return undefined;
  }

  if (
    !(await repo.exists(APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH, {
      doNotFollowSymlinks: true,
      expectedType: REGULAR_FILE_TYPE,
    }))
  ) {
    throw new Error(
      `Application image credential capability "${APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH}" must be a regular file.`,
    );
  }

  return parseApplicationImageCredentialCapability(
    await repo.file(APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH).contents(),
  );
}
