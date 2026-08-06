import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { Directory } from "@dagger.io/dagger";

import {
  activateApplicationImageCredentialBoundaryForDeploy,
  activateApplicationImageProvider,
} from "../src/application-images/activation.ts";
import {
  APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH,
  formatApplicationImageCredentialCapability,
} from "../src/application-images/credential-capability.ts";
import { collectApplicationImageCredentialNames } from "../src/application-images/environment-boundary.ts";
import { parseApplicationImageProviders } from "../src/application-images/parse-providers.ts";
import type { PackageManifest } from "../src/model/package-manifest.ts";
import type { PackageBuildSpec } from "../src/model/package-target.ts";
import type { PreparedPackageTarget } from "../src/stages/package-stage/package-planning.ts";

const providerYaml = [
  "providers:",
  "  release:",
  "    kind: oci_registry",
  "    registry: registry.example",
  "    repository_prefix: example/release",
  "    username_env: RELEASE_USERNAME",
  "    token_env: RELEASE_TOKEN",
  "    signing_key_env: RELEASE_SIGNING_KEY",
  "    signing_password_env: RELEASE_SIGNING_PASSWORD",
  "    verification_key_env: RELEASE_VERIFICATION_KEY",
  "  staging:",
  "    kind: oci_registry",
  "    registry: registry.example",
  "    repository_prefix: example/staging",
  "    username_env: STAGING_USERNAME",
  "    token_env: STAGING_TOKEN",
  "    signing_key_env: STAGING_SIGNING_KEY",
  "    signing_password_env: STAGING_SIGNING_PASSWORD",
  "    verification_key_env: STAGING_VERIFICATION_KEY",
  "",
].join("\n");

function emptyBuild(): PackageBuildSpec {
  return { dry_run_defaults: {}, map_env: {}, pass_env: [] };
}

function filesystemTarget(
  target: string,
  build: PackageBuildSpec = emptyBuild(),
): PreparedPackageTarget {
  return {
    definition: {
      artifact: { kind: "directory", path: `apps/${target}/dist` },
      build,
      name: target,
    },
    plan: {
      artifact: {
        deploy_path: `apps/${target}/dist`,
        kind: "directory",
        path: `apps/${target}/dist`,
      },
      commands: [],
      validations: [],
    },
    target,
  };
}

function archiveTarget(target: string): PreparedPackageTarget {
  return {
    definition: {
      artifact: {
        kind: "rush_deploy_archive",
        output: `common/deploy/${target}`,
        project: target,
        scenario: target,
      },
      build: emptyBuild(),
      name: target,
    },
    plan: {
      artifact: {
        deploy_path: `common/deploy/${target}`,
        kind: "archive",
        path: `deploy-target-${target}.tgz`,
      },
      commands: [],
      validations: [],
    },
    target,
  };
}

function ociTarget(
  target: string,
  build: PackageBuildSpec = emptyBuild(),
): PreparedPackageTarget {
  return {
    definition: {
      artifact: {
        context: `apps/${target}`,
        dockerfile: `apps/${target}/Dockerfile`,
        image: target,
        kind: "oci_image",
        platform: "linux/amd64",
        scan: { fail_on: ["high"] },
      },
      build,
      name: target,
    },
    plan: {
      commands: [],
      oci: {
        context: `apps/${target}`,
        dockerfile: `apps/${target}/Dockerfile`,
        image: target,
        platform: "linux/amd64",
        scan: { fail_on: ["high"] },
      },
      validations: [],
    },
    target,
  };
}

function fakeRepo(deployTargets: string[]): {
  reads: string[];
  repo: Directory;
} {
  const reads: string[] = [];
  const files: Record<string, string> = {
    ".dagger/application-images/providers.yaml": providerYaml,
  };

  for (const target of deployTargets) {
    files[`.dagger/deploy/targets/${target}.yaml`] = [
      `name: ${target}`,
      `deploy_script: deploy/${target}.sh`,
      "runtime:",
      "  image: node:24-bookworm-slim",
      "",
    ].join("\n");
  }

  const repo = {
    async exists(): Promise<boolean> {
      return false;
    },
    file(path: string) {
      reads.push(path);
      return {
        async contents(): Promise<string> {
          const contents = files[path];
          if (contents === undefined) {
            throw new Error(`Unexpected file read: ${path}`);
          }
          return contents;
        },
      };
    },
  } as unknown as Directory;

  return { reads, repo };
}

test("a no-OCI selection ignores malformed provider input without touching the repository", async () => {
  const repo = {
    file(): never {
      throw new Error("provider metadata must not be read");
    },
  } as unknown as Directory;

  assert.equal(
    await activateApplicationImageProvider(repo, [filesystemTarget("web")], {
      applicationImageProvider: "not valid!",
      dryRun: false,
    }),
    undefined,
  );
});

test("empty, archive-only, and npm-only selections remain provider-independent", async () => {
  const repo = {
    file(): never {
      throw new Error("provider metadata must not be read");
    },
  } as unknown as Directory;
  const npmReleaseDefinition = {
    auth: { kind: "token" as const, token_env: "RELEASE_TOKEN" },
    kind: "npm" as const,
    publish: { provenance: false, registry: "", tag: "latest" },
    versioning: {
      strategy: "rush-change-files" as const,
      target_branch: "main",
    },
  };

  assert.equal(
    await activateApplicationImageProvider(repo, [], {
      applicationImageProvider: "not valid!",
      dryRun: false,
    }),
    undefined,
  );
  assert.equal(
    await activateApplicationImageProvider(repo, [archiveTarget("api")], {
      applicationImageProvider: "not valid!",
      dryRun: false,
    }),
    undefined,
  );
  assert.equal(
    await activateApplicationImageProvider(repo, [], {
      applicationImageProvider: "release",
      dryRun: false,
      npmReleaseDefinition,
    }),
    undefined,
  );
});

test("provider-off OCI dry run does not read provider metadata", async () => {
  const repo = {
    file(): never {
      throw new Error("provider metadata must not be read");
    },
  } as unknown as Directory;

  assert.deepEqual(
    await activateApplicationImageProvider(repo, [ociTarget("api")], {
      applicationImageProvider: "off",
      dryRun: true,
    }),
    { name: "off", protectedCredentials: [] },
  );
});

test("provider-off live OCI fails before repository or Rush execution", async () => {
  const repo = {
    file(): never {
      throw new Error("repository must not be read after package planning");
    },
  } as unknown as Directory;

  await assert.rejects(
    () =>
      activateApplicationImageProvider(repo, [ociTarget("api")], {
        applicationImageProvider: "off",
        dryRun: false,
      }),
    /Live OCI image packaging requires applicationImageProvider/,
  );
});

test("named OCI dry run loads metadata but never requests credential values", async () => {
  const { reads, repo } = fakeRepo(["api"]);
  const activation = await activateApplicationImageProvider(
    repo,
    [ociTarget("api")],
    {
      applicationImageProvider: "release",
      dryRun: true,
    },
  );

  assert.equal(activation?.name, "release");
  assert.equal(activation?.protectedCredentials.length, 10);
  assert.deepEqual(reads, [
    ".dagger/application-images/providers.yaml",
    ".dagger/deploy/targets/api.yaml",
  ]);
});

test("named OCI dry run resolves only selected public coordinates before Build", async () => {
  const { reads, repo } = fakeRepo(["api"]);
  const originalFile = repo.file.bind(repo);
  const dynamicRepo = {
    exists: repo.exists.bind(repo),
    file(path: string) {
      if (path === ".dagger/application-images/providers.yaml") {
        reads.push(path);
        return {
          async contents(): Promise<string> {
            return providerYaml
              .replace(
                "registry: registry.example",
                "registry_env: RELEASE_REGISTRY",
              )
              .replace(
                "repository_prefix: example/release",
                "repository_prefix_env: RELEASE_REPOSITORY",
              );
          },
        };
      }
      return originalFile(path);
    },
  } as unknown as Directory;
  const environmentReads: string[] = [];
  const hostEnv = new Proxy(
    {
      RELEASE_REGISTRY: "registry.dynamic.example",
      RELEASE_REPOSITORY: "dynamic/release",
    },
    {
      get(target, property, receiver) {
        if (typeof property === "string") {
          environmentReads.push(property);
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );

  const activation = await activateApplicationImageProvider(
    dynamicRepo,
    [ociTarget("api")],
    {
      applicationImageProvider: "release",
      dryRun: true,
      hostEnv,
    },
  );

  assert.deepEqual(activation?.coordinates, {
    registry: "registry.dynamic.example",
    repositoryPrefix: "dynamic/release",
  });
  assert.deepEqual(environmentReads, [
    "RELEASE_REGISTRY",
    "RELEASE_REPOSITORY",
  ]);
});

test("selecting one provider protects credentials from every declared provider", async () => {
  const { repo } = fakeRepo(["api"]);

  await assert.rejects(
    () =>
      activateApplicationImageProvider(
        repo,
        [
          ociTarget("api", {
            ...emptyBuild(),
            pass_env: ["STAGING_TOKEN"],
          }),
        ],
        {
          applicationImageProvider: "release",
          dryRun: true,
        },
      ),
    /provider "staging".+STAGING_TOKEN.+package target "api"/s,
  );
});

test("an active provider validates selected filesystem targets in a mixed plan", async () => {
  const { repo } = fakeRepo(["api", "web"]);

  await assert.rejects(
    () =>
      activateApplicationImageProvider(
        repo,
        [
          ociTarget("api"),
          filesystemTarget("web", {
            ...emptyBuild(),
            map_env: { SAFE_TOKEN: "RELEASE_TOKEN" },
          }),
        ],
        {
          applicationImageProvider: "release",
          dryRun: true,
        },
      ),
    /provider "release".+RELEASE_TOKEN.+package target "web".+map_env source/s,
  );
});

test("standalone filesystem and provider-off OCI deploys ignore provider metadata", async () => {
  const repo = {
    file(): never {
      throw new Error("provider metadata must not be read");
    },
  } as unknown as Directory;
  const filesystemManifest: PackageManifest = {
    artifacts: {
      web: {
        deploy_path: "apps/web/dist",
        kind: "directory",
        path: "apps/web/dist",
      },
    },
  };
  const providerOffManifest: PackageManifest = {
    artifacts: {
      api: {
        image: "api",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        source_revision: "a".repeat(40),
        status: "planned",
      },
    },
    schema_version: "rush-delivery-package-manifest/v2",
  };

  assert.deepEqual(
    await activateApplicationImageCredentialBoundaryForDeploy(
      repo,
      filesystemManifest,
      ["web"],
    ),
    [],
  );
  assert.deepEqual(
    await activateApplicationImageCredentialBoundaryForDeploy(
      repo,
      providerOffManifest,
      ["api"],
    ),
    [],
  );
});

test("standalone named-provider OCI deploy protects every provider credential", async () => {
  const { reads, repo } = fakeRepo(["api"]);
  const originalFile = repo.file.bind(repo);
  const guardedRepo = {
    exists: repo.exists.bind(repo),
    file(path: string) {
      if (path === ".dagger/deploy/targets/api.yaml") {
        reads.push(path);
        return {
          async contents(): Promise<string> {
            return [
              "name: api",
              "deploy_script: deploy/api.sh",
              "runtime:",
              "  image: node:24-bookworm-slim",
              "  pass_env: [STAGING_TOKEN]",
              "",
            ].join("\n");
          },
        };
      }

      return originalFile(path);
    },
  } as unknown as Directory;
  const manifest: PackageManifest = {
    artifacts: {
      api: {
        image: "api",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        repository: "registry.example/example/release/api",
        source_revision: "a".repeat(40),
        status: "planned",
      },
    },
    schema_version: "rush-delivery-package-manifest/v2",
  };

  await assert.rejects(
    () =>
      activateApplicationImageCredentialBoundaryForDeploy(
        guardedRepo,
        manifest,
        ["api"],
      ),
    /provider "staging".+STAGING_TOKEN.+deploy target "api"/s,
  );
  assert.deepEqual(reads, [
    ".dagger/application-images/providers.yaml",
    ".dagger/deploy/targets/api.yaml",
  ]);
});

test("frozen Package capability defeats a malicious Build metadata rewrite", async () => {
  const originalCredentials = collectApplicationImageCredentialNames(
    parseApplicationImageProviders(providerYaml),
  );
  const files: Record<string, string> = {
    [APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH]:
      formatApplicationImageCredentialCapability(originalCredentials),
    ".dagger/application-images/providers.yaml": providerYaml.replaceAll(
      /(?:RELEASE|STAGING)_[A-Z_]+/gu,
      "MUTATED_CREDENTIAL",
    ),
    ".dagger/deploy/targets/api.yaml": [
      "name: api",
      "deploy_script: deploy/api.sh",
      "runtime:",
      "  image: node:24-bookworm-slim",
      "  pass_env: [RELEASE_TOKEN]",
      "",
    ].join("\n"),
  };
  const reads: string[] = [];
  const maliciousBuiltRepo = {
    async exists(path: string, options?: unknown): Promise<boolean> {
      if (path !== APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH) {
        return false;
      }

      return options === undefined || files[path] !== undefined;
    },
    file(path: string) {
      reads.push(path);
      return {
        async contents(): Promise<string> {
          const contents = files[path];
          if (contents === undefined) {
            throw new Error(`Unexpected file read: ${path}`);
          }
          return contents;
        },
      };
    },
  } as unknown as Directory;
  const manifest: PackageManifest = {
    artifacts: {
      api: {
        image: "api",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        repository: "registry.example/example/release/api",
        source_revision: "a".repeat(40),
        status: "planned",
      },
    },
    schema_version: "rush-delivery-package-manifest/v2",
  };

  await assert.rejects(
    () =>
      activateApplicationImageCredentialBoundaryForDeploy(
        maliciousBuiltRepo,
        manifest,
        ["api"],
      ),
    /provider "release".+RELEASE_TOKEN.+deploy target "api"/s,
  );
  assert.deepEqual(reads, [
    APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH,
    ".dagger/deploy/targets/api.yaml",
  ]);
  assert.equal(
    reads.includes(".dagger/application-images/providers.yaml"),
    false,
    "Deploy must not recompute a weaker boundary from Build-mutated provider metadata",
  );
});

test("Deploy never falls back when a frozen capability exists but is invalid", async () => {
  const reads: string[] = [];
  const repo = {
    async exists(): Promise<boolean> {
      return true;
    },
    file(path: string) {
      reads.push(path);
      return {
        async contents(): Promise<string> {
          if (path === APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH) {
            return JSON.stringify({
              credentials: [],
              schema_version:
                "rush-delivery-application-image-credential-capability/v1",
            });
          }

          throw new Error(`Unexpected fallback read: ${path}`);
        },
      };
    },
  } as unknown as Directory;
  const manifest: PackageManifest = {
    artifacts: {
      api: {
        image: "api",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        repository: "registry.example/example/release/api",
        source_revision: "a".repeat(40),
        status: "planned",
      },
    },
    schema_version: "rush-delivery-package-manifest/v2",
  };

  await assert.rejects(
    () =>
      activateApplicationImageCredentialBoundaryForDeploy(repo, manifest, [
        "api",
      ]),
    /must protect at least one provider/u,
  );
  assert.deepEqual(reads, [APPLICATION_IMAGE_CREDENTIAL_CAPABILITY_PATH]);
});
