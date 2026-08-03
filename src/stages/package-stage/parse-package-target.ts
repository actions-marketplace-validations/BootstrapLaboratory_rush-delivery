import path from "node:path";

import { parse as parseYaml } from "yaml";

import { assertKnownKeys } from "../../metadata/parse-utils.ts";
import type {
  PackageArtifactDefinition,
  PackageBuildSpec,
  PackageTargetDefinition,
  VulnerabilitySeverity,
} from "../../model/package-target.ts";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const OCI_IMAGE_NAME_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const OCI_PLATFORM_PATTERN =
  /^[a-z0-9]+\/[a-z0-9_]+(?:\/[a-z0-9._-]+)?$/;
const VULNERABILITY_SEVERITIES = new Set<VulnerabilitySeverity>([
  "critical",
  "high",
  "low",
  "medium",
  "negligible",
]);

function parseRequiredString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }

  return rawValue;
}

function parseRepositoryPath(
  rawValue: unknown,
  name: string,
  allowRepositoryRoot: boolean = false,
): string {
  const value = parseRequiredString(rawValue, name).replaceAll("\\", "/");

  if (allowRepositoryRoot && value === ".") {
    return value;
  }

  if (
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value) ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${name} must be a normalized repository-relative path.`);
  }

  return path.posix.normalize(value);
}

function parseOciImageName(rawValue: unknown, name: string): string {
  const value = parseRequiredString(rawValue, name);

  if (!OCI_IMAGE_NAME_PATTERN.test(value)) {
    throw new Error(
      `${name} must be a lowercase relative OCI repository name without a tag or digest.`,
    );
  }

  return value;
}

function parseOciPlatform(rawValue: unknown, name: string): string {
  const value = parseRequiredString(rawValue, name);

  if (!OCI_PLATFORM_PATTERN.test(value)) {
    throw new Error(`${name} must be a normalized OCI platform.`);
  }

  return value;
}

function parseVulnerabilitySeverities(
  rawValue: unknown,
  name: string,
): VulnerabilitySeverity[] {
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    throw new Error(`${name} must be a non-empty array.`);
  }

  const severities: VulnerabilitySeverity[] = [];

  for (const entry of rawValue) {
    const severity = parseRequiredString(entry, `${name} entry`);

    if (!VULNERABILITY_SEVERITIES.has(severity as VulnerabilitySeverity)) {
      throw new Error(
        `${name} entry "${severity}" must be critical, high, medium, low, or negligible.`,
      );
    }

    if (severities.includes(severity as VulnerabilitySeverity)) {
      throw new Error(`${name} entries must be unique.`);
    }

    severities.push(severity as VulnerabilitySeverity);
  }

  return severities;
}

function parseOciImageScan(rawValue: unknown) {
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw new Error("Package target OCI image scan must be a mapping.");
  }

  assertKnownKeys(
    rawValue as Record<string, unknown>,
    ["fail_on", "ignore_file"],
    "Package target OCI image scan",
  );

  return {
    fail_on: parseVulnerabilitySeverities(
      "fail_on" in rawValue ? rawValue.fail_on : undefined,
      "Package target OCI image scan fail_on",
    ),
    ...("ignore_file" in rawValue
      ? {
          ignore_file: parseRepositoryPath(
            rawValue.ignore_file,
            "Package target OCI image scan ignore_file",
          ),
        }
      : {}),
  };
}

function parseStringArray(rawValue: unknown, name: string): string[] {
  if (rawValue === undefined) {
    return [];
  }

  if (!Array.isArray(rawValue)) {
    throw new Error(`${name} must be an array.`);
  }

  return rawValue.map((entry) => parseRequiredString(entry, `${name} entry`));
}

function parseEnvNameArray(rawValue: unknown, name: string): string[] {
  const values = parseStringArray(rawValue, name);
  const normalizedValues: string[] = [];

  for (const value of values) {
    if (!ENV_NAME_PATTERN.test(value)) {
      throw new Error(`${name} entry must match ${ENV_NAME_PATTERN}.`);
    }

    if (!normalizedValues.includes(value)) {
      normalizedValues.push(value);
    }
  }

  return normalizedValues;
}

function parseStringRecord(
  rawValue: unknown,
  name: string,
): Record<string, string> {
  if (rawValue === undefined) {
    return {};
  }

  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw new Error(`${name} must be a mapping.`);
  }

  const normalizedValues: Record<string, string> = {};

  for (const [key, entry] of Object.entries(rawValue)) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new Error(`${name} key "${key}" must match ${ENV_NAME_PATTERN}.`);
    }

    if (typeof entry !== "string") {
      throw new Error(`${name} value for "${key}" must be a string.`);
    }

    normalizedValues[key] = entry;
  }

  return normalizedValues;
}

function parseEnvNameRecord(
  rawValue: unknown,
  name: string,
): Record<string, string> {
  const normalizedValues = parseStringRecord(rawValue, name);

  for (const [key, value] of Object.entries(normalizedValues)) {
    if (!ENV_NAME_PATTERN.test(value)) {
      throw new Error(
        `${name} value for "${key}" "${value}" must match ${ENV_NAME_PATTERN}.`,
      );
    }
  }

  return normalizedValues;
}

function parsePackageArtifact(rawValue: unknown): PackageArtifactDefinition {
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw new Error("Package target artifact must be a mapping.");
  }

  const kind = parseRequiredString(
    "kind" in rawValue ? rawValue.kind : undefined,
    "Package target artifact kind",
  );

  switch (kind) {
    case "directory":
      assertKnownKeys(
        rawValue as Record<string, unknown>,
        ["kind", "path"],
        "Package target artifact",
      );
      return {
        kind,
        path: parseRequiredString(
          "path" in rawValue ? rawValue.path : undefined,
          "Package target artifact path",
        ),
      };

    case "rush_deploy_archive":
      assertKnownKeys(
        rawValue as Record<string, unknown>,
        ["kind", "output", "project", "scenario"],
        "Package target artifact",
      );
      return {
        kind,
        output: parseRequiredString(
          "output" in rawValue ? rawValue.output : undefined,
          "Package target artifact output",
        ),
        project: parseRequiredString(
          "project" in rawValue ? rawValue.project : undefined,
          "Package target artifact project",
        ),
        scenario: parseRequiredString(
          "scenario" in rawValue ? rawValue.scenario : undefined,
          "Package target artifact scenario",
        ),
      };

    case "oci_image": {
      assertKnownKeys(
        rawValue as Record<string, unknown>,
        [
          "context",
          "dockerfile",
          "image",
          "kind",
          "platform",
          "scan",
        ],
        "Package target artifact",
      );
      const context = parseRepositoryPath(
        "context" in rawValue ? rawValue.context : undefined,
        "Package target OCI image context",
        true,
      );
      const dockerfile = parseRepositoryPath(
        "dockerfile" in rawValue ? rawValue.dockerfile : undefined,
        "Package target OCI image dockerfile",
      );
      const relativeDockerfile = path.posix.relative(context, dockerfile);

      if (
        relativeDockerfile.length === 0 ||
        relativeDockerfile === ".." ||
        relativeDockerfile.startsWith("../")
      ) {
        throw new Error(
          "Package target OCI image dockerfile must be inside its context.",
        );
      }

      return {
        context,
        dockerfile,
        image: parseOciImageName(
          "image" in rawValue ? rawValue.image : undefined,
          "Package target OCI image image",
        ),
        kind,
        platform: parseOciPlatform(
          "platform" in rawValue ? rawValue.platform : undefined,
          "Package target OCI image platform",
        ),
        scan: parseOciImageScan(
          "scan" in rawValue ? rawValue.scan : undefined,
        ),
      };
    }

    default:
      throw new Error(`Unsupported package target artifact kind "${kind}".`);
  }
}

function parsePackageBuild(rawValue: unknown): PackageBuildSpec {
  if (rawValue === undefined) {
    return {
      dry_run_defaults: {},
      map_env: {},
      pass_env: [],
    };
  }

  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw new Error("Package target build must be a mapping.");
  }

  assertKnownKeys(
    rawValue as Record<string, unknown>,
    ["dry_run_defaults", "map_env", "pass_env"],
    "Package target build",
  );

  return {
    dry_run_defaults: parseStringRecord(
      "dry_run_defaults" in rawValue ? rawValue.dry_run_defaults : undefined,
      "Package target build dry_run_defaults",
    ),
    map_env: parseEnvNameRecord(
      "map_env" in rawValue ? rawValue.map_env : undefined,
      "Package target build map_env",
    ),
    pass_env: parseEnvNameArray(
      "pass_env" in rawValue ? rawValue.pass_env : undefined,
      "Package target build pass_env",
    ),
  };
}

export function parsePackageTarget(
  packageTargetYaml: string,
): PackageTargetDefinition {
  const parsedValue = parseYaml(packageTargetYaml);

  if (
    typeof parsedValue !== "object" ||
    parsedValue === null ||
    Array.isArray(parsedValue)
  ) {
    throw new Error("Package target file must define a top-level mapping.");
  }

  assertKnownKeys(
    parsedValue as Record<string, unknown>,
    ["artifact", "build", "name"],
    "Package target file",
  );

  return {
    artifact: parsePackageArtifact(
      "artifact" in parsedValue ? parsedValue.artifact : undefined,
    ),
    build: parsePackageBuild(
      "build" in parsedValue ? parsedValue.build : undefined,
    ),
    name: parseRequiredString(
      "name" in parsedValue ? parsedValue.name : undefined,
      "Package target name",
    ),
  };
}
