import type { Directory } from "@dagger.io/dagger";

import type { PackageTargetDefinition } from "../../model/package-target.ts";
import { packageTargetDefinitionPath } from "./metadata-paths.ts";
import { parsePackageTarget } from "./parse-package-target.ts";

export async function loadPackageTargetDefinition(
  repo: Directory,
  target: string,
): Promise<PackageTargetDefinition> {
  const definition = parsePackageTarget(
    await repo.file(packageTargetDefinitionPath(target)).contents(),
  );

  if (definition.name !== target) {
    throw new Error(
      `Package target definition "${packageTargetDefinitionPath(target)}" must declare name "${target}", got "${definition.name}".`,
    );
  }

  return definition;
}
