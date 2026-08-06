import type { RushToolchainDownload } from "./rush-toolchain.ts";

export type ToolchainImageKind = "deploy-executor" | "rush";

export type ToolchainImageProvider = "off" | "github";

export type ToolchainImagePolicy = "lazy" | "pull-or-build";

export type ToolchainImageSpec = {
  baseImage: string;
  downloads?: RushToolchainDownload[];
  env: Record<string, string>;
  install: string[];
  kind: ToolchainImageKind;
  name: string;
  platform?: "linux/amd64";
  version: string;
};

export type NormalizedToolchainImageSpec = {
  base_image: string;
  downloads?: RushToolchainDownload[];
  env: Record<string, string>;
  install: string[];
  kind: ToolchainImageKind;
  name: string;
  platform?: "linux/amd64";
  version: string;
};

export type ToolchainImageReference = {
  imagePath: string;
  reference: string;
  registry: string;
  repository: string;
  tag: string;
};

export type GithubToolchainImageProviderDefinition = {
  image_namespace: string;
  kind: "github_container_registry";
  registry: string;
  repository_env: string;
  token_env: string;
  username_env: string;
};

export type ToolchainImageProvidersDefinition = {
  providers: {
    github?: GithubToolchainImageProviderDefinition;
  };
};

export type ToolchainImageResolution = {
  image: string;
  install: string[];
  prebuilt: boolean;
  provider: ToolchainImageProvider;
  reference?: ToolchainImageReference;
};
