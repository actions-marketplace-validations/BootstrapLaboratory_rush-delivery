import type { ApplicationImageProvidersDefinition } from "../model/application-image.ts";
import type { DeployRuntimeSpec } from "../model/deploy-target.ts";
import type { NpmReleaseDefinition } from "../model/npm-release.ts";
import type { PackageBuildSpec } from "../model/package-target.ts";

export const APPLICATION_IMAGE_CREDENTIAL_FIELDS = [
  "username_env",
  "token_env",
  "signing_key_env",
  "signing_password_env",
  "verification_key_env",
] as const;

export const CURRENT_FRAMEWORK_DEPLOY_ENVIRONMENT_NAMES = [
  "ARTIFACT_PATH",
  "ARTIFACT_KIND",
  "ARTIFACT_IMAGE_NAME",
  "ARTIFACT_IMAGE_REFERENCE",
  "ARTIFACT_IMAGE_REPOSITORY",
  "ARTIFACT_IMAGE_DIGEST",
  "ARTIFACT_IMAGE_PLATFORMS_JSON",
  "ARTIFACT_SOURCE_REVISION",
  "ARTIFACT_EVIDENCE_DIR",
  "GIT_SHA",
  "DRY_RUN",
] as const;

export type ApplicationImageCredentialField =
  (typeof APPLICATION_IMAGE_CREDENTIAL_FIELDS)[number];

export type ProtectedApplicationImageCredential = {
  field: ApplicationImageCredentialField;
  name: string;
  provider: string;
};

export type PublicApplicationImageCoordinateName = {
  field: "registry_env" | "repository_prefix_env";
  name: string;
  provider: string;
};

export type ApplicationImageCredentialProjectionIssue =
  ProtectedApplicationImageCredential & {
    metadataField: string;
    target: string;
    targetKind: "deploy target" | "npm release" | "package target";
  };

export type ApplicationImageCredentialNameReuseIssue = {
  credentials: ProtectedApplicationImageCredential[];
  name: string;
};

type EnvironmentProjection = {
  metadataField: string;
  name: string;
};

export function collectApplicationImageCredentialNames(
  providers: ApplicationImageProvidersDefinition,
): ProtectedApplicationImageCredential[] {
  return Object.keys(providers.providers)
    .sort()
    .flatMap((provider) => {
      const definition = providers.providers[provider];

      return APPLICATION_IMAGE_CREDENTIAL_FIELDS.map((field) => ({
        field,
        name: definition[field],
        provider,
      }));
    });
}

export function collectApplicationImageCoordinateNames(
  providers: ApplicationImageProvidersDefinition,
): PublicApplicationImageCoordinateName[] {
  return Object.keys(providers.providers)
    .sort()
    .flatMap((provider) => {
      const definition = providers.providers[provider];

      return [
        ...(definition.registry_env === undefined
          ? []
          : [
              {
                field: "registry_env" as const,
                name: definition.registry_env,
                provider,
              },
            ]),
        ...(definition.repository_prefix_env === undefined
          ? []
          : [
              {
                field: "repository_prefix_env" as const,
                name: definition.repository_prefix_env,
                provider,
              },
            ]),
      ];
    });
}

export function assertApplicationImageCoordinateNameSeparation(
  providers: ApplicationImageProvidersDefinition,
  additionalProtectedNames: string[] = [],
): void {
  const coordinates = collectApplicationImageCoordinateNames(providers);
  const protectedNames = new Set([
    ...collectApplicationImageCredentialNames(providers).map(({ name }) => name),
    ...additionalProtectedNames,
    "GIT_SHA",
    "DRY_RUN",
  ]);
  const coordinateOwners = new Map<string, PublicApplicationImageCoordinateName>();
  const issues: string[] = [];

  for (const coordinate of coordinates) {
    const existing = coordinateOwners.get(coordinate.name);

    if (existing !== undefined) {
      issues.push(
        `provider "${coordinate.provider}" field "${coordinate.field}" aliases provider "${existing.provider}" field "${existing.field}" through environment name "${coordinate.name}"`,
      );
    } else {
      coordinateOwners.set(coordinate.name, coordinate);
    }

    if (
      protectedNames.has(coordinate.name) ||
      coordinate.name.startsWith("ARTIFACT_")
    ) {
      issues.push(
        `provider "${coordinate.provider}" field "${coordinate.field}" uses protected environment name "${coordinate.name}"`,
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(
      [
        "Application image provider coordinate environment names must be public and distinct:",
        ...issues.sort().map((issue) => `- ${issue}.`),
      ].join("\n"),
    );
  }
}

export function collectApplicationImageCredentialNameReuseIssues(
  providers: ApplicationImageProvidersDefinition,
): ApplicationImageCredentialNameReuseIssue[] {
  const credentialsByName = new Map<
    string,
    ProtectedApplicationImageCredential[]
  >();

  for (const credential of collectApplicationImageCredentialNames(providers)) {
    const credentials = credentialsByName.get(credential.name) ?? [];
    credentials.push(credential);
    credentialsByName.set(credential.name, credentials);
  }

  return [...credentialsByName.entries()]
    .filter(([, credentials]) => credentials.length > 1)
    .map(([name, credentials]) => ({ credentials, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function assertUniqueApplicationImageCredentialNames(
  providers: ApplicationImageProvidersDefinition,
): void {
  const issues = collectApplicationImageCredentialNameReuseIssues(providers);

  if (issues.length === 0) {
    return;
  }

  throw new Error(
    [
      "Application image provider credential environment names must be globally unique:",
      ...issues.map(
        ({ credentials, name }) =>
          `- Environment variable "${name}" is reused by ${credentials
            .map(
              ({ field, provider }) =>
                `provider "${provider}" field "${field}"`,
            )
            .join(" and ")}.`,
      ),
    ].join("\n"),
  );
}

function packageBuildProjections(
  build: PackageBuildSpec,
): EnvironmentProjection[] {
  return [
    ...build.pass_env.map((name) => ({
      metadataField: "build.pass_env",
      name,
    })),
    ...Object.keys(build.map_env).map((name) => ({
      metadataField: "build.map_env output",
      name,
    })),
    ...Object.values(build.map_env).map((name) => ({
      metadataField: "build.map_env source",
      name,
    })),
    ...Object.keys(build.dry_run_defaults).map((name) => ({
      metadataField: "build.dry_run_defaults",
      name,
    })),
  ];
}

function deployRuntimeProjections(
  runtime: DeployRuntimeSpec,
): EnvironmentProjection[] {
  return [
    ...runtime.pass_env.map((name) => ({
      metadataField: "runtime.pass_env",
      name,
    })),
    ...Object.keys(runtime.map_env).map((name) => ({
      metadataField: "runtime.map_env output",
      name,
    })),
    ...Object.values(runtime.map_env).map((name) => ({
      metadataField: "runtime.map_env source",
      name,
    })),
    ...Object.keys(runtime.env).map((name) => ({
      metadataField: "runtime.env",
      name,
    })),
    ...Object.keys(runtime.dry_run_defaults).map((name) => ({
      metadataField: "runtime.dry_run_defaults",
      name,
    })),
    ...runtime.required_host_env.map((name) => ({
      metadataField: "runtime.required_host_env",
      name,
    })),
    ...runtime.file_mounts.flatMap((mount) =>
      mount.kind === "host_path"
        ? [
            {
              metadataField: "runtime.file_mounts[].source_var",
              name: mount.source_var,
            },
          ]
        : [],
    ),
  ];
}

function collectProjectionIssues(
  projections: EnvironmentProjection[],
  credentials: ProtectedApplicationImageCredential[],
  targetKind: ApplicationImageCredentialProjectionIssue["targetKind"],
  target: string,
): ApplicationImageCredentialProjectionIssue[] {
  const credentialsByName = new Map<
    string,
    ProtectedApplicationImageCredential[]
  >();

  for (const credential of credentials) {
    const matchingCredentials = credentialsByName.get(credential.name) ?? [];
    matchingCredentials.push(credential);
    credentialsByName.set(credential.name, matchingCredentials);
  }

  return projections.flatMap((projection) =>
    (credentialsByName.get(projection.name) ?? []).map((credential) => ({
      ...credential,
      metadataField: projection.metadataField,
      target,
      targetKind,
    })),
  );
}

export function collectPackageBuildCredentialProjectionIssues(
  target: string,
  build: PackageBuildSpec,
  credentials: ProtectedApplicationImageCredential[],
): ApplicationImageCredentialProjectionIssue[] {
  return collectProjectionIssues(
    packageBuildProjections(build),
    credentials,
    "package target",
    target,
  );
}

export function collectDeployRuntimeCredentialProjectionIssues(
  target: string,
  runtime: DeployRuntimeSpec,
  credentials: ProtectedApplicationImageCredential[],
): ApplicationImageCredentialProjectionIssue[] {
  return collectProjectionIssues(
    deployRuntimeProjections(runtime),
    credentials,
    "deploy target",
    target,
  );
}

export function collectNpmReleaseCredentialProjectionIssues(
  definition: NpmReleaseDefinition,
  credentials: ProtectedApplicationImageCredential[],
): ApplicationImageCredentialProjectionIssue[] {
  return collectProjectionIssues(
    [
      {
        metadataField: "auth.token_env",
        name: definition.auth.token_env,
      },
    ],
    credentials,
    "npm release",
    "npm",
  );
}

export function formatApplicationImageCredentialProjectionIssue(
  issue: ApplicationImageCredentialProjectionIssue,
): string {
  return `Application image provider "${issue.provider}" credential field "${issue.field}" protects environment variable "${issue.name}", which ${issue.targetKind} "${issue.target}" projects through "${issue.metadataField}".`;
}

export function assertNoApplicationImageCredentialProjections(
  issues: ApplicationImageCredentialProjectionIssue[],
): void {
  if (issues.length === 0) {
    return;
  }

  throw new Error(
    [
      "Application image provider credential projection validation failed:",
      ...issues
        .map(
          (issue) =>
            `- ${formatApplicationImageCredentialProjectionIssue(issue)}`,
        )
        .sort(),
    ].join("\n"),
  );
}

export function isFrameworkOwnedDeployEnvironmentName(name: string): boolean {
  return (
    name === "GIT_SHA" || name === "DRY_RUN" || name.startsWith("ARTIFACT_")
  );
}

export function collectFrameworkOwnedDeployEnvironmentIssues(
  target: string,
  runtime: DeployRuntimeSpec,
): string[] {
  const projections = [
    ...runtime.pass_env.map((name) => ({
      metadataField: "runtime.pass_env",
      name,
    })),
    ...Object.keys(runtime.map_env).map((name) => ({
      metadataField: "runtime.map_env output",
      name,
    })),
    ...Object.keys(runtime.env).map((name) => ({
      metadataField: "runtime.env",
      name,
    })),
    ...Object.keys(runtime.dry_run_defaults).map((name) => ({
      metadataField: "runtime.dry_run_defaults",
      name,
    })),
    ...runtime.required_host_env.map((name) => ({
      metadataField: "runtime.required_host_env",
      name,
    })),
    ...runtime.file_mounts.flatMap((mount) =>
      mount.kind === "host_path"
        ? [
            {
              metadataField: "runtime.file_mounts[].source_var",
              name: mount.source_var,
            },
          ]
        : [],
    ),
  ];

  return projections
    .filter(({ name }) => isFrameworkOwnedDeployEnvironmentName(name))
    .map(
      ({ metadataField, name }) =>
        `Deploy target "${target}" field "${metadataField}" uses framework-owned environment variable "${name}". Rename it; ARTIFACT_*, GIT_SHA, and DRY_RUN are reserved for Rush Delivery.`,
    );
}

export function assertNoFrameworkOwnedDeployEnvironment(
  target: string,
  runtime: DeployRuntimeSpec,
): void {
  const issues = collectFrameworkOwnedDeployEnvironmentIssues(target, runtime);

  if (issues.length > 0) {
    throw new Error([...issues].sort().join("\n"));
  }
}
