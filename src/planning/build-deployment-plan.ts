import type { DeploymentPlan } from "../model/deployment-plan.ts";
import type { ServiceMesh } from "../model/service-mesh.ts";

export function buildDeploymentPlan(
  mesh: ServiceMesh,
  selectedTargets: string[],
): DeploymentPlan {
  const selectedTargetSet = new Set(selectedTargets);

  for (const target of selectedTargets) {
    if (!Object.hasOwn(mesh.services, target)) {
      throw new Error(`Unknown release target "${target}" in services mesh.`);
    }
  }

  for (const [target, service] of Object.entries(mesh.services)) {
    for (const dependency of service.deploy_after) {
      if (!Object.hasOwn(mesh.services, dependency)) {
        throw new Error(
          `Unknown dependency "${dependency}" referenced by "${target}".`,
        );
      }
    }
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const target of selectedTargets) {
    inDegree.set(target, 0);
    dependents.set(target, []);
  }

  for (const target of selectedTargets) {
    const service = mesh.services[target];
    for (const dependency of service.deploy_after) {
      if (!selectedTargetSet.has(dependency)) {
        continue;
      }

      dependents.get(dependency)?.push(target);
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }

  const remainingTargets = new Set(selectedTargets);
  const waves: DeploymentPlan["waves"] = [];

  while (remainingTargets.size > 0) {
    const waveTargets = [...remainingTargets]
      .filter((target) => (inDegree.get(target) ?? 0) === 0)
      .sort();

    if (waveTargets.length === 0) {
      throw new Error("Cycle detected in services mesh deploy_after graph.");
    }

    waves.push(
      waveTargets.map((target) => ({
        target,
      })),
    );

    for (const target of waveTargets) {
      remainingTargets.delete(target);
      for (const dependent of dependents.get(target) ?? []) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
      }
    }
  }

  return {
    selectedTargets,
    waves,
  };
}
