export type OciRegistryProviderDefinition = {
  kind: "oci_registry";
  registry: string;
  repository_prefix: string;
  signing_key_env: string;
  signing_password_env: string;
  token_env: string;
  username_env: string;
  verification_key_env: string;
};

export type ApplicationImageProvidersDefinition = {
  providers: Record<string, OciRegistryProviderDefinition>;
};

export type ApplicationImageProvider = "off" | string;
