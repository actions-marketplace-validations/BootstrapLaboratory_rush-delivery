import { dag, type Container, type Secret } from "@dagger.io/dagger";

import type {
  ToolchainImageProvidersDefinition,
  ToolchainImageProvider,
  ToolchainImagePolicy,
  ToolchainImageResolution,
  ToolchainImageSpec,
} from "../model/toolchain-image.ts";
import { buildGithubToolchainImageReference } from "./github-reference.ts";
import {
  isMissingToolchainImageError,
  resolveOffToolchainImage,
  shouldPublishToolchainImage,
} from "./resolve-plan.ts";
import { toolchainImageName, toolchainImageTag } from "./spec.ts";
import { CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION } from "./spec.ts";
import { buildConfiguredRushToolchainContainer } from "../rush-toolchain/build.ts";

export type ResolveToolchainImageOptions = {
  hostEnv?: Record<string, string>;
  policy?: ToolchainImagePolicy;
  provider?: ToolchainImageProvider;
  providers?: ToolchainImageProvidersDefinition;
};

type RegistryAuth = {
  address: string;
  secret: Secret;
  username: string;
};

export type ResolvedToolchainImage = ToolchainImageResolution & {
  container?: Container;
  registryAuth?: RegistryAuth;
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

async function buildToolchainContainer(
  spec: ToolchainImageSpec,
): Promise<Container> {
  if (spec.version === CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION) {
    return buildConfiguredRushToolchainContainer(spec);
  }

  let container = dag.container().from(spec.baseImage);

  if (spec.install.length > 0) {
    container = container.withExec(["bash", "-lc", spec.install.join(" && ")]);
  }

  return container;
}

export async function resolveToolchainImage(
  spec: ToolchainImageSpec,
  options: ResolveToolchainImageOptions = {},
): Promise<ResolvedToolchainImage> {
  const provider = options.provider ?? "off";

  switch (provider) {
    case "off":
      if (spec.version === CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION) {
        return {
          container: await buildToolchainContainer(spec),
          image: spec.baseImage,
          install: [],
          prebuilt: true,
          provider,
        };
      }
      return resolveOffToolchainImage(spec);
    case "github":
      return resolveGithubToolchainImage(spec, options);
  }
}

async function resolveGithubToolchainImage(
  spec: ToolchainImageSpec,
  options: ResolveToolchainImageOptions,
): Promise<ResolvedToolchainImage> {
  const githubProvider = options.providers?.providers.github;

  if (githubProvider === undefined) {
    throw new Error(
      "GitHub toolchain image provider metadata is required when provider is github.",
    );
  }

  const hostEnv = options.hostEnv ?? {};
  const repository = requireHostEnv(
    hostEnv,
    githubProvider.repository_env,
    "GitHub toolchain image provider",
  );
  const token = requireHostEnv(
    hostEnv,
    githubProvider.token_env,
    "GitHub toolchain image provider",
  );
  const username = requireHostEnv(
    hostEnv,
    githubProvider.username_env,
    "GitHub toolchain image provider",
  );
  const reference = buildGithubToolchainImageReference({
    imageName: toolchainImageName(spec),
    imageNamespace: githubProvider.image_namespace,
    registry: githubProvider.registry,
    repository,
    tag: toolchainImageTag(spec),
  });
  const secret = dag.setSecret(
    `toolchain-image-${spec.kind}-${spec.name}-github-token`,
    token,
  );
  const registryAuth = {
    address: githubProvider.registry,
    secret,
    username,
  };
  const authenticatedContainer = dag
    .container()
    .withRegistryAuth(registryAuth.address, username, secret);

  try {
    await authenticatedContainer.from(reference.reference).sync();
    console.log(`[toolchain-images] using ${reference.reference}`);
  } catch (error) {
    if (!isMissingToolchainImageError(error)) {
      throw error;
    }

    const publish = shouldPublishToolchainImage(options.policy);
    console.log(
      `[toolchain-images] building ${reference.reference}${publish ? "" : " locally"}`,
    );

    let builtContainer = await buildToolchainContainer(spec);

    if (publish) {
      builtContainer = builtContainer
        .withLabel(
          "org.opencontainers.image.source",
          `https://github.com/${repository}`,
        )
        .withRegistryAuth(registryAuth.address, username, secret);

      const publishedReference = await builtContainer.publish(
        reference.reference,
      );

      console.log(`[toolchain-images] published ${publishedReference}`);
    }

    return {
      container: builtContainer,
      image: reference.reference,
      install: [],
      prebuilt: true,
      provider: "github",
      reference,
      registryAuth,
    };
  }

  return {
    image: reference.reference,
    install: [],
    prebuilt: true,
    provider: "github",
    reference,
    registryAuth,
  };
}

function applyToolchainImageRegistryAuth(
  container: Container,
  resolution: ResolvedToolchainImage,
): Container {
  if (resolution.registryAuth === undefined) {
    return container;
  }

  return container.withRegistryAuth(
    resolution.registryAuth.address,
    resolution.registryAuth.username,
    resolution.registryAuth.secret,
  );
}

function applyToolchainImageResolution(
  container: Container,
  resolution: ResolvedToolchainImage,
): Container {
  if (resolution.install.length === 0) {
    return container;
  }

  return container.withExec(["bash", "-lc", resolution.install.join(" && ")]);
}

export function buildResolvedToolchainContainer(
  resolution: ResolvedToolchainImage,
): Container {
  if (resolution.container !== undefined) {
    return resolution.container;
  }

  const container = applyToolchainImageRegistryAuth(
    dag.container(),
    resolution,
  ).from(resolution.image);

  return applyToolchainImageResolution(container, resolution);
}
