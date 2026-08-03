import type { DeployTargetDefinition } from "../../model/deploy-target.ts";
import type { PackageManifestArtifact } from "../../model/package-manifest.ts";
import { buildRuntimeWorkspacePlan } from "./runtime-workspace.ts";

export type DryRunSummaryInput = {
  artifact: PackageManifestArtifact;
  artifactPath?: string;
  definition: DeployTargetDefinition;
  deployTag: string;
  dockerSocketEnabled: boolean;
  environment: string;
  envVars: Record<string, string>;
  gitSha: string;
  wave: number;
};

export function formatDryRunSummary(input: DryRunSummaryInput): string {
  const {
    artifact,
    artifactPath,
    definition,
    deployTag,
    dockerSocketEnabled,
    environment,
    envVars,
    gitSha,
    wave,
  } = input;
  const lines = [
    `[deploy-release] dry-run target=${definition.name} wave=${wave}`,
    `environment=${environment}`,
    `gitSha=${gitSha}`,
    `deploy_tag=${deployTag}`,
    `deploy_script=${definition.deploy_script}`,
    `package_artifact_kind=${artifact.kind}`,
  ];

  if (artifact.kind === "oci_image") {
    lines.push(`package_artifact_status=${artifact.status}`);
    lines.push(`package_artifact_image=${artifact.image}`);
    lines.push(
      `package_artifact_platforms=${JSON.stringify(artifact.platforms)}`,
    );
    if (artifact.repository !== undefined) {
      lines.push(`package_artifact_repository=${artifact.repository}`);
    }
    if (artifact.status === "published") {
      lines.push(`package_artifact_reference=${artifact.reference}`);
    } else {
      lines.push(
        "package_artifact_publication=no-image-or-digest-produced-dry-run",
      );
    }
  } else {
    lines.push(`package_artifact_path=${artifact.path}`);
    lines.push(`artifact_path=${artifactPath}`);
  }

  lines.push(`image=${definition.runtime.image}`);

  if (definition.runtime.install.length > 0) {
    lines.push("install:");
    lines.push(
      ...definition.runtime.install.map((command) => `  - ${command}`),
    );
  }

  const envEntries = Object.entries(envVars).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (envEntries.length > 0) {
    lines.push("env:");
    lines.push(...envEntries.map(([name, value]) => `  - ${name}=${value}`));
  }

  if (definition.runtime.file_mounts.length > 0) {
    lines.push("file_mounts:");
    lines.push(
      ...definition.runtime.file_mounts.map((mount) =>
        mount.kind === "host_path"
          ? `  - source_var=${mount.source_var} target=${mount.target}`
          : `  - source=${mount.source} target=${mount.target}`,
      ),
    );
  }

  if (dockerSocketEnabled) {
    lines.push("docker_socket:");
    lines.push("  - /var/run/docker.sock");
  }

  const workspacePlan = buildRuntimeWorkspacePlan(definition.runtime.workspace);
  lines.push("workspace:");
  if (workspacePlan.mode === "full") {
    lines.push("  mode=full");
  } else {
    lines.push("  mode=partial");
    lines.push(...workspacePlan.dirs.map((dir) => `  dir=${dir}`));
    lines.push(...workspacePlan.files.map((file) => `  file=${file}`));
  }

  return `${lines.join("\n")}\n`;
}
