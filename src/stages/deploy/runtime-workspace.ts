import type { Container, Directory } from "@dagger.io/dagger";

import { isSafeApplicationImageTarget } from "../../application-images/evidence-target.ts";
import type {
  DeployWorkspaceSpec,
  FileMountSpec,
} from "../../model/deploy-target.ts";
import {
  FRAMEWORK_EVIDENCE_PATH,
  withoutFrameworkEvidence,
} from "../../runtime/framework-runtime.ts";

export {
  FRAMEWORK_EVIDENCE_PATH,
  withoutFrameworkEvidence,
} from "../../runtime/framework-runtime.ts";

const WORKSPACE_PATH = "/workspace";
export const FRAMEWORK_EVIDENCE_WORKSPACE_PATH = `${WORKSPACE_PATH}/${FRAMEWORK_EVIDENCE_PATH}`;

export type RuntimeWorkspacePlan =
  | {
      mode: "full";
    }
  | {
      dirs: string[];
      files: string[];
      mode: "partial";
    };

function normalizeWorkspacePathForComparison(value: string): string {
  const segments: string[] = [];

  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}

function normalizeContainerMountTarget(value: string): string {
  const normalizedValue = value.replace(/\\/g, "/");
  const segments = normalizedValue.startsWith("/") ? [] : ["workspace"];

  for (const segment of normalizedValue.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return `/${segments.join("/")}`;
}

export function assertFileMountTargetDoesNotCollideWithFrameworkEvidence(
  value: string,
): void {
  const normalizedTarget = normalizeContainerMountTarget(value);
  const collides =
    normalizedTarget === "/" ||
    normalizedTarget === FRAMEWORK_EVIDENCE_WORKSPACE_PATH ||
    normalizedTarget.startsWith(`${FRAMEWORK_EVIDENCE_WORKSPACE_PATH}/`) ||
    FRAMEWORK_EVIDENCE_WORKSPACE_PATH.startsWith(`${normalizedTarget}/`);

  if (collides) {
    throw new Error(
      `Deploy runtime file mount target "${value}" collides with Rush Delivery evidence at "${FRAMEWORK_EVIDENCE_WORKSPACE_PATH}". Choose a target outside the framework evidence subtree and its parent paths.`,
    );
  }
}

export function assertRuntimeFileMountTargetsDoNotCollideWithFrameworkEvidence(
  fileMounts: FileMountSpec[],
): void {
  for (const fileMount of fileMounts) {
    assertFileMountTargetDoesNotCollideWithFrameworkEvidence(fileMount.target);
  }
}

function assertWorkspacePathDoesNotSelectFrameworkEvidence(
  value: string,
): void {
  const normalizedPath = normalizeWorkspacePathForComparison(value);

  if (
    normalizedPath === FRAMEWORK_EVIDENCE_PATH ||
    normalizedPath.startsWith(`${FRAMEWORK_EVIDENCE_PATH}/`)
  ) {
    throw new Error(
      `Deploy runtime workspace path "${value}" selects Rush Delivery evidence. Remove it and consume the current target's verified evidence through ARTIFACT_EVIDENCE_DIR instead.`,
    );
  }
}

export function assertRuntimeWorkspaceDoesNotSelectFrameworkEvidence(
  workspace: DeployWorkspaceSpec,
): void {
  for (const path of [...workspace.dirs, ...workspace.files]) {
    assertWorkspacePathDoesNotSelectFrameworkEvidence(path);
  }
}

export function buildRuntimeWorkspacePlan(
  workspace: DeployWorkspaceSpec,
): RuntimeWorkspacePlan {
  assertRuntimeWorkspaceDoesNotSelectFrameworkEvidence(workspace);

  if (workspace.mode === "full") {
    return { mode: "full" };
  }

  return {
    dirs: workspace.dirs,
    files: workspace.files,
    mode: "partial",
  };
}

export async function applyRuntimeWorkspace(
  container: Container,
  repo: Directory,
  workspace: DeployWorkspaceSpec,
): Promise<Container> {
  const plan = buildRuntimeWorkspacePlan(workspace);
  const genericRepo = await withoutFrameworkEvidence(repo);

  if (plan.mode === "full") {
    return container.withDirectory(WORKSPACE_PATH, genericRepo);
  }

  let nextContainer = container;

  for (const directoryPath of plan.dirs) {
    nextContainer = nextContainer.withDirectory(
      `${WORKSPACE_PATH}/${directoryPath}`,
      genericRepo.directory(directoryPath),
    );
  }

  for (const filePath of plan.files) {
    nextContainer = nextContainer.withFile(
      `${WORKSPACE_PATH}/${filePath}`,
      genericRepo.file(filePath),
    );
  }

  return nextContainer;
}

export function mountTargetEvidence(
  container: Container,
  packagedRepo: Directory,
  target: string,
): Container {
  if (!isSafeApplicationImageTarget(target)) {
    throw new Error(
      `OCI target "${target}" cannot be used as a framework evidence path.`,
    );
  }

  const evidencePath = `${FRAMEWORK_EVIDENCE_PATH}/${target}`;

  return container.withDirectory(
    `${WORKSPACE_PATH}/${evidencePath}`,
    packagedRepo.directory(evidencePath),
  );
}
