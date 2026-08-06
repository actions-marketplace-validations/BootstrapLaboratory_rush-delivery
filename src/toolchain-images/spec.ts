import { createHash } from "node:crypto";

import type { DeployTargetDefinition } from "../model/deploy-target.ts";
import type {
  NormalizedToolchainImageSpec,
  ToolchainImageSpec,
} from "../model/toolchain-image.ts";
import type { RushToolchainDefinition } from "../model/rush-toolchain.ts";

export const TOOLCHAIN_IMAGE_SPEC_VERSION = "rush-delivery-toolchain-image/v1";
export const CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION =
  "rush-delivery-toolchain-image/v2";
export const TOOLCHAIN_IMAGE_HASH_LENGTH = 16;

export function deployTargetToolchainImageSpec(
  definition: DeployTargetDefinition,
): ToolchainImageSpec {
  return {
    baseImage: definition.runtime.image,
    env: {},
    install: [...definition.runtime.install],
    kind: "deploy-executor",
    name: definition.name,
    version: TOOLCHAIN_IMAGE_SPEC_VERSION,
  };
}

export function rushToolchainImageSpec(
  baseImage: string,
  install: string[],
  definition?: RushToolchainDefinition,
): ToolchainImageSpec {
  if (definition !== undefined) {
    return {
      baseImage: definition.base_image,
      downloads: definition.downloads.map((download) => ({ ...download })),
      env: {},
      install: [...install],
      kind: "rush",
      name: "workflow",
      platform: definition.platform,
      version: CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION,
    };
  }

  return {
    baseImage,
    env: {},
    install: [...install],
    kind: "rush",
    name: "workflow",
    version: TOOLCHAIN_IMAGE_SPEC_VERSION,
  };
}

export function normalizeToolchainImageSpec(
  spec: ToolchainImageSpec,
): NormalizedToolchainImageSpec {
  const normalized: NormalizedToolchainImageSpec = {
    base_image: spec.baseImage,
    env: Object.fromEntries(
      Object.entries(spec.env).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    install: [...spec.install],
    kind: spec.kind,
    name: spec.name,
    version: spec.version,
  };

  if (spec.version === CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION) {
    normalized.downloads = (spec.downloads ?? []).map((download) => ({
      ...download,
    }));
    normalized.platform = spec.platform;
  }

  return normalized;
}

export function hashToolchainImageSpec(spec: ToolchainImageSpec): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeToolchainImageSpec(spec)))
    .digest("hex")
    .slice(0, TOOLCHAIN_IMAGE_HASH_LENGTH);
}

export function toolchainImageTag(spec: ToolchainImageSpec): string {
  return `sha256-${hashToolchainImageSpec(spec)}`;
}

export function toolchainImageName(spec: ToolchainImageSpec): string {
  switch (spec.kind) {
    case "deploy-executor":
      return `deploy-${spec.name}`;
    case "rush":
      return `rush-${spec.name}`;
  }
}
