import { Directory } from "@dagger.io/dagger";

import type { ApplicationImageProvidersDefinition } from "../model/application-image.ts";
import { applicationImageProvidersPath } from "./metadata-paths.ts";
import { parseApplicationImageProviders } from "./parse-providers.ts";

export async function loadApplicationImageProviders(
  repo: Directory,
): Promise<ApplicationImageProvidersDefinition> {
  return parseApplicationImageProviders(
    await repo.file(applicationImageProvidersPath).contents(),
  );
}
