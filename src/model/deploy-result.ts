import type { DeploymentPlan } from "./deployment-plan.ts";

type DeployTargetResultBase = {
  output: string;
  status: "success";
  target: string;
  wave: number;
};

export type FilesystemDeployTargetResult = DeployTargetResultBase & {
  artifactPath: string;
};

export type OciImageDeployTargetResult = DeployTargetResultBase & {
  artifactImage: string;
  artifactKind: "oci_image";
  artifactReference?: string;
};

export type DeployTargetResult =
  | FilesystemDeployTargetResult
  | OciImageDeployTargetResult;

export type DeployReleaseResult = {
  dryRun: boolean;
  environment: string;
  plan: DeploymentPlan;
  results: DeployTargetResult[];
};
