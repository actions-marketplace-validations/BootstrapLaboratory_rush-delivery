import type { EnvPassthroughSpec } from "./env.ts";

export type VulnerabilitySeverity =
  | "critical"
  | "high"
  | "low"
  | "medium"
  | "negligible";

export type OciImageScanSpec = {
  fail_on: VulnerabilitySeverity[];
  ignore_file?: string;
};

export type PackageArtifactDefinition =
  | {
      kind: "directory";
      path: string;
    }
  | {
      kind: "rush_deploy_archive";
      output: string;
      project: string;
      scenario: string;
    }
  | {
      context: string;
      dockerfile: string;
      image: string;
      kind: "oci_image";
      platform: string;
      scan: OciImageScanSpec;
    };

export type PackageBuildSpec = EnvPassthroughSpec;

export type PackageTargetDefinition = {
  artifact: PackageArtifactDefinition;
  build: PackageBuildSpec;
  name: string;
};
