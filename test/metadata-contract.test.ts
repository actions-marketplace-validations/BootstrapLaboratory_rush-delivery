import * as assert from "node:assert/strict";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  type MetadataContractRepository,
  validateMetadataContractRepository,
} from "../src/metadata/metadata-contract.ts";
import { buildDeploymentPlan } from "../src/planning/build-deployment-plan.ts";
import { parseServicesMesh } from "../src/planning/parse-services-mesh.ts";
import { buildPackageActionPlan } from "../src/stages/package-stage/package-action-plan.ts";
import { parsePackageTarget } from "../src/stages/package-stage/parse-package-target.ts";

class LocalMetadataRepository implements MetadataContractRepository {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async entries(relativePath: string): Promise<string[]> {
    return readdir(path.join(this.root, relativePath));
  }

  async exists(
    relativePath: string,
    expectedType: "directory" | "file",
  ): Promise<boolean> {
    try {
      const entry = await stat(path.join(this.root, relativePath));
      return expectedType === "file" ? entry.isFile() : entry.isDirectory();
    } catch {
      return false;
    }
  }

  async isSymlink(relativePath: string): Promise<boolean> {
    try {
      return (await lstat(path.join(this.root, relativePath))).isSymbolicLink();
    } catch {
      return false;
    }
  }

  async readTextFile(relativePath: string): Promise<string> {
    return readFile(path.join(this.root, relativePath), "utf8");
  }
}

class MemoryMetadataRepository implements MetadataContractRepository {
  private readonly files: Record<string, string>;

  constructor(files: Record<string, string>) {
    this.files = files;
  }

  async entries(relativePath: string): Promise<string[]> {
    const prefix = relativePath.endsWith("/")
      ? relativePath
      : `${relativePath}/`;
    const entries = new Set<string>();

    for (const filePath of Object.keys(this.files)) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }

      const remainingPath = filePath.slice(prefix.length);
      if (remainingPath.length === 0) {
        continue;
      }

      entries.add(remainingPath.split("/")[0]);
    }

    return [...entries].sort();
  }

  async exists(
    relativePath: string,
    expectedType: "directory" | "file",
  ): Promise<boolean> {
    if (expectedType === "file") {
      return relativePath in this.files;
    }

    if (relativePath === ".") {
      return true;
    }

    const prefix = relativePath.endsWith("/")
      ? relativePath
      : `${relativePath}/`;
    return Object.keys(this.files).some((filePath) =>
      filePath.startsWith(prefix),
    );
  }

  async isSymlink(_relativePath: string): Promise<boolean> {
    return false;
  }

  async readTextFile(relativePath: string): Promise<string> {
    const contents = this.files[relativePath];
    if (contents === undefined) {
      throw new Error(`Missing file ${relativePath}`);
    }

    return contents;
  }
}

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "fixtures/rush-repo");

function validMetadataFiles(): Record<string, string> {
  return {
    ".dagger/deploy/services-mesh.yaml": [
      "services:",
      "  server:",
      "    deploy_after: []",
      "  webapp:",
      "    deploy_after:",
      "      - server",
      "",
    ].join("\n"),
    ".dagger/deploy/targets/server.yaml": [
      "name: server",
      "deploy_script: deploy/server.sh",
      "runtime:",
      "  image: node:24-bookworm-slim",
      "  pass_env:",
      "    - CLOUD_RUN_REGION",
      "  dry_run_defaults:",
      "    CLOUD_RUN_REGION: europe-west4",
      "",
    ].join("\n"),
    ".dagger/deploy/targets/webapp.yaml": [
      "name: webapp",
      "deploy_script: deploy/webapp.sh",
      "runtime:",
      "  image: node:24-bookworm-slim",
      "",
    ].join("\n"),
    ".dagger/package/targets/server.yaml": [
      "name: server",
      "artifact:",
      "  kind: rush_deploy_archive",
      "  project: server",
      "  scenario: server",
      "  output: common/deploy/server",
      "",
    ].join("\n"),
    ".dagger/package/targets/webapp.yaml": [
      "name: webapp",
      "build:",
      "  pass_env:",
      "    - WEBAPP_URL",
      "  map_env:",
      "    VITE_GRAPHQL_HTTP: WEBAPP_VITE_GRAPHQL_HTTP",
      "  dry_run_defaults:",
      "    WEBAPP_URL: https://webapp.example.test",
      "    WEBAPP_VITE_GRAPHQL_HTTP: https://api.example.test/graphql",
      "artifact:",
      "  kind: directory",
      "  path: apps/webapp/dist",
      "",
    ].join("\n"),
    ".dagger/validate/targets/server.yaml": [
      "name: server",
      "steps:",
      "  - name: smoke",
      "    command: npm",
      "    args: [--version]",
      "",
    ].join("\n"),
    ".dagger/release/npm.yaml": [
      "kind: npm",
      "versioning:",
      "  strategy: rush-change-files",
      "  target_branch: main",
      "auth:",
      "  kind: token",
      "  token_env: NPM_TOKEN",
      "publish:",
      "  registry: https://registry.npmjs.org/",
      "  tag: latest",
      "  access: public",
      "  provenance: true",
      "",
    ].join("\n"),
    ".dagger/rush-cache/providers.yaml": [
      "cache:",
      "  version: v1",
      "  paths:",
      "    - common/temp/node_modules",
      "    - common/temp/pnpm-store",
      "providers:",
      "  github:",
      "    kind: github_container_registry",
      "    repository_env: GITHUB_REPOSITORY",
      "    token_env: GITHUB_TOKEN",
      "    username_env: GITHUB_ACTOR",
      "",
    ].join("\n"),
    "common/config/rush/.npmrc-publish":
      "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
    "common/config/rush/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "apps/server/package.json": "{}",
    "apps/webapp/package.json": "{}",
    "deploy/server.sh": "#!/usr/bin/env bash\n",
    "deploy/webapp.sh": "#!/usr/bin/env bash\n",
    "rush.json": JSON.stringify({
      projects: [
        { packageName: "server", projectFolder: "apps/server" },
        { packageName: "webapp", projectFolder: "apps/webapp" },
      ],
    }),
  };
}

function releaseOnlyMetadataFiles(): Record<string, string> {
  return {
    ".dagger/release/npm.yaml": [
      "kind: npm",
      "versioning:",
      "  strategy: rush-change-files",
      "  target_branch: main",
      "auth:",
      "  kind: token",
      "  token_env: NPM_TOKEN",
      "publish:",
      "  registry: https://registry.npmjs.org/",
      "  tag: latest",
      "  access: public",
      "  provenance: true",
      "",
    ].join("\n"),
    "common/config/rush/.npmrc-publish":
      "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
    "packages/library/package.json": "{}",
    "rush.json": JSON.stringify({
      projects: [
        {
          packageName: "@example/library",
          projectFolder: "packages/library",
        },
      ],
    }),
  };
}

test("validates the fixture repository metadata contract", async () => {
  const result = await validateMetadataContractRepository(
    new LocalMetadataRepository(repoRoot),
  );

  assert.deepEqual(result.deploy_targets, ["server", "webapp"]);
  assert.deepEqual(result.package_targets, ["server", "webapp"]);
  assert.deepEqual(result.release_targets, ["npm"]);
  assert.deepEqual(result.validation_targets, ["server"]);
  assert.ok(result.rush_projects.includes("server"));
  assert.ok(result.rush_projects.includes("webapp"));
});

test("accepts a complete framework metadata contract", async () => {
  const result = await validateMetadataContractRepository(
    new MemoryMetadataRepository(validMetadataFiles()),
  );

  assert.deepEqual(result.deploy_targets, ["server", "webapp"]);
  assert.deepEqual(result.package_targets, ["server", "webapp"]);
  assert.deepEqual(result.release_targets, ["npm"]);
  assert.deepEqual(result.validation_targets, ["server"]);
});

test("validates OCI package files and optional application image provider metadata", async () => {
  const files = validMetadataFiles();
  files[".dagger/package/targets/server.yaml"] = [
    "name: server",
    "artifact:",
    "  kind: oci_image",
    "  context: apps/server",
    "  dockerfile: apps/server/Dockerfile",
    "  image: platform/server",
    "  platform: linux/amd64",
    "  scan:",
    "    fail_on: [high, critical]",
    "    ignore_file: .dagger/application-images/grype.yaml",
    "",
  ].join("\n");
  files["apps/server/Dockerfile"] = "FROM scratch\n";
  files[".dagger/application-images/grype.yaml"] = "ignore: []\n";
  files[".dagger/application-images/providers.yaml"] = [
    "providers:",
    "  release:",
    "    kind: oci_registry",
    "    registry: registry.example",
    "    repository_prefix: example/platform",
    "    username_env: OCI_USERNAME",
    "    token_env: OCI_TOKEN",
    "    signing_key_env: OCI_SIGNING_KEY",
    "    signing_password_env: OCI_SIGNING_PASSWORD",
    "    verification_key_env: OCI_SIGNING_PUBLIC_KEY",
    "",
  ].join("\n");

  const result = await validateMetadataContractRepository(
    new MemoryMetadataRepository(files),
    { require_application_image_provider_metadata: true },
  );

  assert.ok(result.package_targets.includes("server"));
});

test("does not require application image provider metadata for existing projects", async () => {
  const result = await validateMetadataContractRepository(
    new MemoryMetadataRepository(validMetadataFiles()),
    { require_application_image_provider_metadata: false },
  );

  assert.deepEqual(result.package_targets, ["server", "webapp"]);
});

test("accepts release-only metadata without deploy or cache metadata when scoped for package release", async () => {
  const result = await validateMetadataContractRepository(
    new MemoryMetadataRepository(releaseOnlyMetadataFiles()),
    {
      require_deploy_metadata: false,
      require_rush_cache_metadata: false,
    },
  );

  assert.deepEqual(result.deploy_targets, []);
  assert.deepEqual(result.package_targets, []);
  assert.deepEqual(result.release_targets, ["npm"]);
  assert.deepEqual(result.rush_projects, ["@example/library"]);
  assert.deepEqual(result.validation_targets, []);
});

test("still validates optional Rush cache metadata when present", async () => {
  const files = validMetadataFiles();

  files[".dagger/rush-cache/providers.yaml"] += "unexpected: true\n";

  await assert.rejects(
    () =>
      validateMetadataContractRepository(new MemoryMetadataRepository(files), {
        require_rush_cache_metadata: false,
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Rush cache provider metadata file ".+providers\.yaml" is invalid: Rush cache providers file has unsupported field: unexpected\./,
      );
      return true;
    },
  );
});

test("requires Rush cache metadata only when requested", async () => {
  const files = validMetadataFiles();

  delete files[".dagger/rush-cache/providers.yaml"];

  await assert.rejects(
    () =>
      validateMetadataContractRepository(new MemoryMetadataRepository(files)),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Rush cache provider metadata file ".+providers\.yaml" must exist\./,
      );
      return true;
    },
  );

  const result = await validateMetadataContractRepository(
    new MemoryMetadataRepository(files),
    {
      require_rush_cache_metadata: false,
    },
  );

  assert.deepEqual(result.deploy_targets, ["server", "webapp"]);
  assert.deepEqual(result.release_targets, ["npm"]);
});

test("accepts adding a deploy target through metadata only", async () => {
  const files = validMetadataFiles();

  files["rush.json"] = JSON.stringify({
    projects: [
      { packageName: "server", projectFolder: "apps/server" },
      { packageName: "webapp", projectFolder: "apps/webapp" },
      { packageName: "worker", projectFolder: "apps/worker" },
    ],
  });
  files[".dagger/deploy/services-mesh.yaml"] = [
    "services:",
    "  server:",
    "    deploy_after: []",
    "  webapp:",
    "    deploy_after:",
    "      - server",
    "  worker:",
    "    deploy_after:",
    "      - server",
    "",
  ].join("\n");
  files[".dagger/deploy/targets/worker.yaml"] = [
    "name: worker",
    "deploy_script: deploy/worker.sh",
    "runtime:",
    "  image: node:24-bookworm-slim",
    "  pass_env:",
    "    - WORKER_REGION",
    "  dry_run_defaults:",
    "    WORKER_REGION: local",
    "",
  ].join("\n");
  files[".dagger/package/targets/worker.yaml"] = [
    "name: worker",
    "artifact:",
    "  kind: directory",
    "  path: apps/worker/dist",
    "",
  ].join("\n");
  files[".dagger/validate/targets/worker.yaml"] = [
    "name: worker",
    "steps:",
    "  - name: smoke",
    "    command: npm",
    "    args: [--prefix, apps/worker, run, ci:smoke]",
    "",
  ].join("\n");
  files["apps/worker/package.json"] = "{}";
  files["deploy/worker.sh"] = "#!/usr/bin/env bash\n";

  const result = await validateMetadataContractRepository(
    new MemoryMetadataRepository(files),
  );
  assert.deepEqual(result.deploy_targets, ["server", "webapp", "worker"]);
  assert.deepEqual(result.package_targets, ["server", "webapp", "worker"]);
  assert.deepEqual(result.release_targets, ["npm"]);
  assert.deepEqual(result.validation_targets, ["server", "worker"]);
  assert.deepEqual(result.rush_projects, ["server", "webapp", "worker"]);

  assert.deepEqual(
    buildDeploymentPlan(
      parseServicesMesh(files[".dagger/deploy/services-mesh.yaml"]),
      result.deploy_targets,
    ),
    {
      selectedTargets: ["server", "webapp", "worker"],
      waves: [
        [{ target: "server" }],
        [{ target: "webapp" }, { target: "worker" }],
      ],
    },
  );
  assert.deepEqual(
    buildPackageActionPlan(
      "worker",
      parsePackageTarget(files[".dagger/package/targets/worker.yaml"]),
      "deploy-target",
    ),
    {
      artifact: {
        deploy_path: "apps/worker/dist",
        kind: "directory",
        path: "apps/worker/dist",
      },
      commands: [],
      validations: [{ kind: "directory", path: "apps/worker/dist" }],
    },
  );
});

test("reports cross-file metadata contract issues together", async () => {
  const files = validMetadataFiles();

  delete files[".dagger/package/targets/webapp.yaml"];
  files[".dagger/deploy/targets/orphan.yaml"] =
    files[".dagger/deploy/targets/webapp.yaml"];
  files[".dagger/validate/targets/ghost.yaml"] = "name: ghost\nsteps: []\n";
  files[".dagger/deploy/targets/server.yaml"] += "unexpected: true\n";
  files[".dagger/rush-cache/providers.yaml"] += "unexpected: true\n";

  await assert.rejects(
    () =>
      validateMetadataContractRepository(new MemoryMetadataRepository(files)),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Deploy target "server" metadata file ".+server\.yaml" is invalid: Deploy target file has unsupported field: unexpected\./,
      );
      assert.match(
        error.message,
        /Package target "webapp" metadata file ".+webapp\.yaml" must exist\./,
      );
      assert.match(
        error.message,
        /Deploy target metadata ".+orphan\.yaml" is not referenced by services mesh\./,
      );
      assert.match(
        error.message,
        /Validation target "ghost" must match a Rush project packageName\./,
      );
      assert.match(
        error.message,
        /Rush cache provider metadata file ".+providers\.yaml" is invalid: Rush cache providers file has unsupported field: unexpected\./,
      );
      return true;
    },
  );
});

test("reports invalid NPM release metadata", async () => {
  const files = validMetadataFiles();

  files[".dagger/release/npm.yaml"] += "unexpected: true\n";
  delete files["common/config/rush/.npmrc-publish"];

  await assert.rejects(
    () =>
      validateMetadataContractRepository(new MemoryMetadataRepository(files)),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /NPM release metadata file ".+npm\.yaml" is invalid: NPM release file has unsupported field: unexpected\./,
      );
      return true;
    },
  );
});

test("requires .npmrc-publish for NPM token release metadata", async () => {
  const files = validMetadataFiles();

  delete files["common/config/rush/.npmrc-publish"];

  await assert.rejects(
    () =>
      validateMetadataContractRepository(new MemoryMetadataRepository(files)),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /NPM release token auth \.npmrc-publish file "common\/config\/rush\/\.npmrc-publish" must exist\./,
      );
      return true;
    },
  );
});

test("reports unsafe deploy runtime workspace paths", async () => {
  const files = validMetadataFiles();

  files[".dagger/deploy/targets/server.yaml"] = [
    "name: server",
    "deploy_script: deploy/server.sh",
    "runtime:",
    "  image: node:24-bookworm-slim",
    "  workspace:",
    "    dirs:",
    "      - ../server-artifact",
    "",
  ].join("\n");

  await assert.rejects(
    () =>
      validateMetadataContractRepository(new MemoryMetadataRepository(files)),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Deploy target "server" metadata file ".+server\.yaml" is invalid: Deploy target runtime workspace dirs entry must stay inside the repository\./,
      );
      return true;
    },
  );
});
