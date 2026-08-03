import path from "node:path";

import type { PackageManifestArtifact } from "../../model/package-manifest.ts";
import type {
  OciImageScanSpec,
  PackageTargetDefinition,
} from "../../model/package-target.ts";

export type PackageCommand = {
  args: string[];
  command: "node" | "tar";
};

export type PackageValidation = {
  kind: "directory" | "file";
  path: string;
};

type FilesystemPackageActionPlan = {
  artifact: PackageManifestArtifact;
  commands: PackageCommand[];
  validations: PackageValidation[];
};

export type OciImagePackagePlan = {
  context: string;
  dockerfile: string;
  image: string;
  platform: string;
  scan: OciImageScanSpec;
};

type OciPackageActionPlan = {
  commands: [];
  oci: OciImagePackagePlan;
  validations: PackageValidation[];
};

export type PackageActionPlan =
  | FilesystemPackageActionPlan
  | OciPackageActionPlan;

export function buildPackageActionPlan(
  target: string,
  definition: PackageTargetDefinition,
  artifactPrefix: string,
): PackageActionPlan {
  if (definition.name !== target) {
    throw new Error(
      `Package target metadata for "${target}" must declare name "${target}", got "${definition.name}".`,
    );
  }

  switch (definition.artifact.kind) {
    case "directory":
      return {
        artifact: {
          deploy_path: definition.artifact.path,
          kind: "directory",
          path: definition.artifact.path,
        },
        commands: [],
        validations: [
          {
            kind: "directory",
            path: definition.artifact.path,
          },
        ],
      };

    case "rush_deploy_archive": {
      const archivePath = `${artifactPrefix}-${target}.tgz`;
      const outputParent = path.posix.dirname(definition.artifact.output);
      const outputName = path.posix.basename(definition.artifact.output);

      return {
        artifact: {
          deploy_path: definition.artifact.output,
          kind: "archive",
          path: archivePath,
        },
        commands: [
          {
            args: [
              "common/scripts/install-run-rush.js",
              "deploy",
              "-p",
              definition.artifact.project,
              "-s",
              definition.artifact.scenario,
              "-t",
              definition.artifact.output,
              "--overwrite",
            ],
            command: "node",
          },
          {
            args: ["-czf", archivePath, "-C", outputParent, outputName],
            command: "tar",
          },
        ],
        validations: [],
      };
    }

    case "oci_image":
      return {
        commands: [],
        oci: {
          context: definition.artifact.context,
          dockerfile: path.posix.relative(
            definition.artifact.context,
            definition.artifact.dockerfile,
          ),
          image: definition.artifact.image,
          platform: definition.artifact.platform,
          scan: definition.artifact.scan,
        },
        validations: [
          {
            kind: "directory",
            path: definition.artifact.context,
          },
          {
            kind: "file",
            path: definition.artifact.dockerfile,
          },
          ...(definition.artifact.scan.ignore_file === undefined
            ? []
            : [
                {
                  kind: "file" as const,
                  path: definition.artifact.scan.ignore_file,
                },
              ]),
        ],
      };

    default:
      throw new Error("Unsupported package target artifact kind.");
  }
}
