import type {
  ApplicationImageProvidersDefinition,
  OciRegistryProviderDefinition,
} from "../model/application-image.ts";
import { assertUniqueApplicationImageCredentialNames } from "./environment-boundary.ts";
import { parseApplicationImageProvider } from "./options.ts";

export type SelectedApplicationImageProvider = {
  definition?: OciRegistryProviderDefinition;
  name: string;
};

export type ApplicationImageCredentialValues = {
  signingKey: string;
  signingPassword: string;
  token: string;
  username: string;
  verificationKey: string;
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

function decodePemEnvironmentValue(
  value: string,
  beginMarker: string,
  endMarker: string,
  envName: string,
): string {
  const decoded = value.replaceAll("\\n", "\n");

  if (!decoded.includes(beginMarker) || !decoded.includes(endMarker)) {
    throw new Error(
      `Application image signing env ${envName} must contain the expected PEM key. Store multiline values with literal \\n separators in env files.`,
    );
  }

  return decoded;
}

export function selectApplicationImageProvider(
  providerName: string,
  providers: ApplicationImageProvidersDefinition | undefined,
): SelectedApplicationImageProvider {
  const name = parseApplicationImageProvider(providerName);

  if (name === "off") {
    return { name };
  }

  if (providers !== undefined) {
    assertUniqueApplicationImageCredentialNames(providers);
  }

  const definition =
    providers !== undefined && Object.hasOwn(providers.providers, name)
      ? providers.providers[name]
      : undefined;

  if (definition === undefined) {
    throw new Error(
      `Application image provider metadata does not define selected provider "${name}".`,
    );
  }

  return { definition, name };
}

export function resolveApplicationImageCredentialValues(
  selected: SelectedApplicationImageProvider & {
    definition: OciRegistryProviderDefinition;
  },
  hostEnv: Record<string, string>,
): ApplicationImageCredentialValues {
  const context = `Application image provider "${selected.name}"`;
  const username = requireHostEnv(
    hostEnv,
    selected.definition.username_env,
    context,
  );
  const token = requireHostEnv(hostEnv, selected.definition.token_env, context);
  const signingKey = decodePemEnvironmentValue(
    requireHostEnv(hostEnv, selected.definition.signing_key_env, context),
    "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
    "-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
    selected.definition.signing_key_env,
  );
  const signingPassword = requireHostEnv(
    hostEnv,
    selected.definition.signing_password_env,
    context,
  );
  const verificationKey = decodePemEnvironmentValue(
    requireHostEnv(hostEnv, selected.definition.verification_key_env, context),
    "-----BEGIN PUBLIC KEY-----",
    "-----END PUBLIC KEY-----",
    selected.definition.verification_key_env,
  );

  return {
    signingKey,
    signingPassword,
    token,
    username,
    verificationKey,
  };
}
