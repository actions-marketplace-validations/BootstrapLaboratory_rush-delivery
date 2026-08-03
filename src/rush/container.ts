import { Container, dag, Directory } from "@dagger.io/dagger";
import type {
  ToolchainImageProvider,
  ToolchainImagePolicy,
  ToolchainImageProvidersDefinition,
} from "../model/toolchain-image.ts";
import {
  buildResolvedToolchainContainer,
  resolveToolchainImage,
} from "../toolchain-images/resolve.ts";
import { rushToolchainImageSpec } from "../toolchain-images/spec.ts";

export const RUSH_WORKDIR = "/workspace";

const RUSH_IMAGE = "node:24-bookworm-slim";
const RUSH_INSTALL_COMMANDS = [
  "apt-get update",
  "apt-get install -y ca-certificates git",
];
const RUSH_INSTALL_ARGS = [
  "node",
  "common/scripts/install-run-rush.js",
  "install",
  "--max-install-attempts",
  "1",
];

export type RushInstallOptions = {
  beforeInstallCommand?: string;
};

export type RushToolchainImageOptions = {
  hostEnv?: Record<string, string>;
  policy?: ToolchainImagePolicy;
  provider?: ToolchainImageProvider;
  providers?: ToolchainImageProvidersDefinition;
};

export function rushWorkflowToolchainSpec() {
  return rushToolchainImageSpec(RUSH_IMAGE, RUSH_INSTALL_COMMANDS);
}

export function prepareRushWorkspaceContainer(repo: Directory): Container {
  return dag
    .container()
    .from(RUSH_IMAGE)
    .withDirectory(RUSH_WORKDIR, repo)
    .withWorkdir(RUSH_WORKDIR);
}

export async function prepareRushContainer(
  repo: Directory,
  options: RushToolchainImageOptions = {},
): Promise<Container> {
  const toolchainImage = await resolveToolchainImage(
    rushWorkflowToolchainSpec(),
    options,
  );

  return buildResolvedToolchainContainer(toolchainImage)
    .withDirectory(RUSH_WORKDIR, repo)
    .withWorkdir(RUSH_WORKDIR);
}

export function installRush(
  container: Container,
  options: RushInstallOptions = {},
): Container {
  if (options.beforeInstallCommand !== undefined) {
    return container.withExec(
      [
        "bash",
        "-lc",
        `${options.beforeInstallCommand} && ${RUSH_INSTALL_ARGS.join(" ")}`,
      ],
      {
        expand: false,
      },
    );
  }

  return container.withExec(RUSH_INSTALL_ARGS, {
    expand: false,
  });
}
