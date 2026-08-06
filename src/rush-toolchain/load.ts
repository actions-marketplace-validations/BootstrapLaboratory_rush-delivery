import { ExistsType, type Directory } from "@dagger.io/dagger";

import type { RushToolchainDefinition } from "../model/rush-toolchain.ts";
import { rushToolchainPath } from "./metadata-paths.ts";
import { parseRushToolchain } from "./parse.ts";

export async function loadOptionalRushToolchain(
  repo: Directory,
): Promise<RushToolchainDefinition | undefined> {
  const exists = await repo.exists(rushToolchainPath, {
    expectedType: ExistsType.RegularType,
  });
  return exists
    ? parseRushToolchain(await repo.file(rushToolchainPath).contents())
    : undefined;
}
