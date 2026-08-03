import { Directory, ExistsType } from "@dagger.io/dagger";

import type { PackageValidation } from "./package-action-plan.ts";

export async function assertPackageValidation(
  repo: Directory,
  validation: PackageValidation,
  target: string,
): Promise<void> {
  switch (validation.kind) {
    case "directory":
      if (
        await repo.exists(validation.path, {
          expectedType: ExistsType.DirectoryType,
        })
      ) {
        return;
      }

      throw new Error(
        `Package target "${target}" expected directory "${validation.path}" to exist.`,
      );

    case "file":
      if (
        await repo.exists(validation.path, {
          expectedType: ExistsType.RegularType,
        })
      ) {
        return;
      }

      throw new Error(
        `Package target "${target}" expected file "${validation.path}" to exist.`,
      );
  }
}
