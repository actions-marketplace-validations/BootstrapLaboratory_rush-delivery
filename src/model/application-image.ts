export type OciRegistryProviderDefinition = {
  kind: "oci_registry";
  registry?: string;
  registry_env?: string;
  repository_prefix?: string;
  repository_prefix_env?: string;
  signing_key_env: string;
  signing_password_env: string;
  token_env: string;
  username_env: string;
  verification_key_env: string;
};

export type ResolvedApplicationImageCoordinates = {
  registry: string;
  repositoryPrefix: string;
};

export type ApplicationImageProvidersDefinition = {
  providers: Record<string, OciRegistryProviderDefinition>;
};

export type ApplicationImageProvider = "off" | string;
