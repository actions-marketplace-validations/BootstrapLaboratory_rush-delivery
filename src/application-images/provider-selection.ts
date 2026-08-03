import type {
  ApplicationImageProvidersDefinition,
  OciRegistryProviderDefinition,
} from "../model/application-image.ts";
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

export function selectApplicationImageProvider(
  providerName: string,
  providers: ApplicationImageProvidersDefinition | undefined,
): SelectedApplicationImageProvider {
  const name = parseApplicationImageProvider(providerName);

  if (name === "off") {
    return { name };
  }

  const definition = providers?.providers[name];

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
  const token = requireHostEnv(
    hostEnv,
    selected.definition.token_env,
    context,
  );
  const signingKey = requireHostEnv(
    hostEnv,
    selected.definition.signing_key_env,
    context,
  );
  const signingPassword = requireHostEnv(
    hostEnv,
    selected.definition.signing_password_env,
    context,
  );
  const verificationKey = requireHostEnv(
    hostEnv,
    selected.definition.verification_key_env,
    context,
  );

  return {
    signingKey,
    signingPassword,
    token,
    username,
    verificationKey,
  };
}
