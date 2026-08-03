import { dag, type Secret } from "@dagger.io/dagger";

import type {
  ApplicationImageProvidersDefinition,
  OciRegistryProviderDefinition,
} from "../model/application-image.ts";
import {
  resolveApplicationImageCredentialValues,
  selectApplicationImageProvider,
} from "./provider-selection.ts";

export type ResolvedApplicationImageProvider = {
  definition?: OciRegistryProviderDefinition;
  dockerConfig?: Secret;
  name: string;
  registryToken?: Secret;
  signingKey?: Secret;
  signingPassword?: Secret;
  username?: string;
  verificationKey?: Secret;
};

function secretName(providerName: string, purpose: string): string {
  return `application-image-${providerName}-${purpose}`;
}

export function resolveApplicationImageProvider(
  providerName: string,
  providers: ApplicationImageProvidersDefinition | undefined,
  hostEnv: Record<string, string>,
  dryRun: boolean,
): ResolvedApplicationImageProvider {
  const selected = selectApplicationImageProvider(providerName, providers);
  const { definition, name } = selected;

  if (name === "off") {
    return { name };
  }

  if (dryRun) {
    return { definition, name };
  }

  const liveDefinition = definition!;
  const { signingKey, signingPassword, token, username, verificationKey } =
    resolveApplicationImageCredentialValues(
      { definition: liveDefinition, name },
      hostEnv,
    );

  return {
    definition: liveDefinition,
    dockerConfig: dag.setSecret(
      secretName(name, "docker-config"),
      JSON.stringify({
        auths: {
          [liveDefinition.registry]: {
            auth: Buffer.from(`${username}:${token}`, "utf8").toString("base64"),
          },
        },
      }),
    ),
    name,
    registryToken: dag.setSecret(secretName(name, "registry-token"), token),
    signingKey: dag.setSecret(secretName(name, "signing-key"), signingKey),
    signingPassword: dag.setSecret(
      secretName(name, "signing-password"),
      signingPassword,
    ),
    username,
    verificationKey: dag.setSecret(
      secretName(name, "verification-key"),
      verificationKey,
    ),
  };
}
