import type { Directory } from "@dagger.io/dagger";

import type { DeployTargetDefinition } from "../../model/deploy-target.ts";
import type { ServiceMesh } from "../../model/service-mesh.ts";
import { parseServicesMesh } from "../../planning/parse-services-mesh.ts";
import { servicesMeshPath, targetDefinitionPath } from "./metadata-paths.ts";
import { parseDeployTarget } from "./parse-deploy-target.ts";

export async function loadServicesMesh(repo: Directory): Promise<ServiceMesh> {
  return parseServicesMesh(await repo.file(servicesMeshPath).contents());
}

export async function loadDeployTargetDefinition(
  repo: Directory,
  target: string,
): Promise<DeployTargetDefinition> {
  const definition = parseDeployTarget(
    await repo.file(targetDefinitionPath(target)).contents(),
  );

  if (definition.name !== target) {
    throw new Error(
      `Target definition "${targetDefinitionPath(target)}" must declare name "${target}", got "${definition.name}".`,
    );
  }

  return definition;
}
