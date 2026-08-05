import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import {
  type MetadataContractRepository,
  validateMetadataContractRepository,
} from "../src/metadata/metadata-contract.ts";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..");
const exampleRoot = path.join(
  repositoryRoot,
  "examples/oci-application-image-rush-repo",
);
const deployScript = path.join(exampleRoot, "deploy/consume-image.sh");
const fixedOutputTimestamp = Date.parse("2000-01-01T00:00:00.000Z");
const digest = `sha256:${"a".repeat(64)}`;
const repository = "ghcr.io/example/rush-delivery-tutorial/control-plane-api";
const reference = `${repository}@${digest}`;
const expectedRushBootstrapHashes = {
  "common/scripts/install-run-rush-pnpm.js":
    "61dfb2736a6f487493f8ef1f7199de9da923662b2b36fa980d7b3641577a04d0",
  "common/scripts/install-run-rush.js":
    "246a659761e3fd36698c1c75c278fbbad258e8f5ba7a3d23f391b3ffef651b81",
  "common/scripts/install-run-rushx.js":
    "d4112221008de9714c18d1c0e9d686d660ee09532d63b966f2a9419070bf6951",
  "common/scripts/install-run.js":
    "892e69ccf586cfb6b3fb99435e9740b111f14d8b80caaca9aacf998022a599a3",
} as const;

const expectedFiles = [
  ".dagger/application-images/grype.yaml",
  ".dagger/application-images/providers.yaml",
  ".dagger/deploy/services-mesh.yaml",
  ".dagger/deploy/targets/control-plane-api.yaml",
  ".dagger/package/targets/control-plane-api.yaml",
  ".dagger/rush-cache/providers.yaml",
  ".gitignore",
  "apps/control-plane-api/Dockerfile",
  "apps/control-plane-api/package.json",
  "apps/control-plane-api/scripts/build.mjs",
  "apps/control-plane-api/src/payload.txt",
  "ci/oci-plan.json",
  "common/config/rush/command-line.json",
  "common/config/rush/common-versions.json",
  "common/config/rush/pnpm-config.json",
  "common/config/rush/pnpm-lock.yaml",
  "common/scripts/install-run-rush-pnpm.js",
  "common/scripts/install-run-rush.js",
  "common/scripts/install-run-rushx.js",
  "common/scripts/install-run.js",
  "deploy/consume-image.sh",
  "package.json",
  "rush.json",
].sort();

const ignoredGeneratedDirectories = new Set([
  ".dagger/runtime",
  "apps/control-plane-api/.rush/temp",
  "apps/control-plane-api/dist",
  "apps/control-plane-api/node_modules",
  "apps/control-plane-api/rush-logs",
  "common/temp",
  "node_modules",
]);

type JsonObject = Record<string, unknown>;

class LocalExampleRepository implements MetadataContractRepository {
  async entries(relativePath: string): Promise<string[]> {
    return readdir(path.join(exampleRoot, relativePath));
  }

  async exists(
    relativePath: string,
    expectedType: "directory" | "file",
  ): Promise<boolean> {
    try {
      const entry = await stat(path.join(exampleRoot, relativePath));
      return expectedType === "file" ? entry.isFile() : entry.isDirectory();
    } catch {
      return false;
    }
  }

  async isSymlink(relativePath: string): Promise<boolean> {
    try {
      return (
        await lstat(path.join(exampleRoot, relativePath))
      ).isSymbolicLink();
    } catch {
      return false;
    }
  }

  async readTextFile(relativePath: string): Promise<string> {
    return readFile(path.join(exampleRoot, relativePath), "utf8");
  }
}

async function readJson(relativePath: string): Promise<JsonObject> {
  return JSON.parse(
    await readFile(path.join(exampleRoot, relativePath), "utf8"),
  ) as JsonObject;
}

async function readYaml(relativePath: string): Promise<JsonObject> {
  return parseYaml(
    await readFile(path.join(exampleRoot, relativePath), "utf8"),
  ) as JsonObject;
}

async function listExampleFiles(
  relativeDirectory: string = "",
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(path.join(exampleRoot, relativeDirectory), {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredGeneratedDirectories.has(relativePath)) {
        files.push(...(await listExampleFiles(relativePath)));
      }
      continue;
    }

    files.push(relativePath);
  }

  return files.sort();
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => {
      const location = error.instancePath || "/";
      return `${location} ${error.message ?? "failed validation"}`;
    })
    .join("\n");
}

function runDeploy(environment: NodeJS.ProcessEnv) {
  return spawnSync("bash", [deployScript], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ...environment,
    },
  });
}

function validDeployEnvironment(evidenceDirectory: string): NodeJS.ProcessEnv {
  return {
    ARTIFACT_EVIDENCE_DIR: evidenceDirectory,
    ARTIFACT_IMAGE_DIGEST: digest,
    ARTIFACT_IMAGE_NAME: "control-plane-api",
    ARTIFACT_IMAGE_PLATFORMS_JSON: '["linux/amd64"]',
    ARTIFACT_IMAGE_REFERENCE: reference,
    ARTIFACT_IMAGE_REPOSITORY: repository,
    ARTIFACT_KIND: "oci_image",
    ARTIFACT_SOURCE_REVISION: "0123456789abcdef0123456789abcdef01234567",
  };
}

test("canonical OCI example has one complete, clean source tree", async () => {
  assert.deepEqual(await listExampleFiles(), expectedFiles);

  const deployMode = (await stat(deployScript)).mode & 0o777;
  assert.equal(deployMode, 0o755);

  const gitignore = await readFile(
    path.join(exampleRoot, ".gitignore"),
    "utf8",
  );
  for (const ignoredPath of [
    "common/temp/",
    "**/.rush/temp/",
    "**/node_modules/",
    "**/rush-logs/",
    "apps/control-plane-api/dist/",
    ".dagger/runtime/",
    ".env",
    ".env.*",
    "*.key",
    "*.pem",
    "*.pub",
    "oci-package/",
    "oci-package.tar",
    "oci-package.tar.sha256",
  ]) {
    assert.match(
      gitignore,
      new RegExp(`^${ignoredPath.replaceAll("*", "\\*")}$`, "m"),
    );
  }
});

test("canonical Rush bootstrap bundles remain generated and formatter-excluded", async () => {
  const prettierIgnore = await readFile(
    path.join(repositoryRoot, ".prettierignore"),
    "utf8",
  );

  for (const [relativePath, expectedHash] of Object.entries(
    expectedRushBootstrapHashes,
  )) {
    const contents = await readFile(path.join(exampleRoot, relativePath));
    assert.equal(createHash("sha256").update(contents).digest("hex"), expectedHash);
    assert.match(
      prettierIgnore,
      new RegExp(
        `^examples/oci-application-image-rush-repo/${relativePath.replaceAll(".", "\\.")}$`,
        "m",
      ),
    );
  }
});

test("canonical OCI example metadata parses and agrees on one target", async () => {
  const examplePackage = await readJson("package.json");
  const rush = await readJson("rush.json");
  const projectPackage = await readJson("apps/control-plane-api/package.json");
  const commandLine = await readJson("common/config/rush/command-line.json");
  const plan = await readJson("ci/oci-plan.json");
  const mesh = await readYaml(".dagger/deploy/services-mesh.yaml");
  const deployTarget = await readYaml(
    ".dagger/deploy/targets/control-plane-api.yaml",
  );
  const packageTarget = await readYaml(
    ".dagger/package/targets/control-plane-api.yaml",
  );
  const providers = await readYaml(".dagger/application-images/providers.yaml");
  const grype = await readYaml(".dagger/application-images/grype.yaml");
  const rushCache = await readYaml(".dagger/rush-cache/providers.yaml");

  await readJson("common/config/rush/common-versions.json");
  await readJson("common/config/rush/pnpm-config.json");
  await readYaml("common/config/rush/pnpm-lock.yaml");

  assert.deepEqual(examplePackage, {
    name: "rush-delivery-oci-application-image-example",
    private: true,
    type: "commonjs",
  });
  assert.equal(rush.rushVersion, "5.160.0");
  assert.equal(rush.pnpmVersion, "9.15.9");
  assert.equal(rush.nodeSupportedVersionRange, ">=24.0.0 <25.0.0");
  assert.deepEqual(rush.projects, [
    {
      packageName: "control-plane-api",
      projectFolder: "apps/control-plane-api",
    },
  ]);
  assert.equal(projectPackage.name, "control-plane-api");
  assert.equal(projectPackage.private, true);
  assert.deepEqual(mesh.services, {
    "control-plane-api": { deploy_after: [] },
  });
  assert.equal(deployTarget.name, "control-plane-api");
  assert.equal(deployTarget.deploy_script, "deploy/consume-image.sh");
  assert.deepEqual((deployTarget.runtime as JsonObject).workspace, {
    files: ["deploy/consume-image.sh"],
  });
  assert.equal(packageTarget.name, "control-plane-api");
  assert.deepEqual(packageTarget.artifact, {
    kind: "oci_image",
    context: "apps/control-plane-api",
    dockerfile: "apps/control-plane-api/Dockerfile",
    image: "control-plane-api",
    platform: "linux/amd64",
    scan: {
      fail_on: ["high", "critical"],
      ignore_file: ".dagger/application-images/grype.yaml",
    },
  });
  assert.deepEqual(plan.deploy_targets, ["control-plane-api"]);
  assert.deepEqual(plan.affected_projects_by_deploy_target, {
    "control-plane-api": ["control-plane-api"],
  });
  assert.equal(plan.mode, "release");
  assert.deepEqual(plan.release_targets, []);
  assert.deepEqual(plan.validate_targets, []);
  assert.deepEqual(grype, { ignore: [] });
  assert.deepEqual((providers.providers as JsonObject).ghcr, {
    kind: "oci_registry",
    registry: "ghcr.io",
    repository_prefix: "example/rush-delivery-tutorial",
    signing_key_env: "RD_OCI_COSIGN_PRIVATE_KEY",
    signing_password_env: "RD_OCI_COSIGN_PASSWORD",
    token_env: "RD_OCI_GHCR_TOKEN",
    username_env: "RD_OCI_GHCR_USERNAME",
    verification_key_env: "RD_OCI_COSIGN_PUBLIC_KEY",
  });
  assert.deepEqual(rushCache, {
    cache: {
      version: "v1",
      paths: ["common/temp/node_modules"],
    },
    providers: {
      github: {
        kind: "github_container_registry",
        repository_env: "GITHUB_REPOSITORY",
        token_env: "RUSH_CACHE_GITHUB_TOKEN",
        username_env: "RUSH_CACHE_GITHUB_USERNAME",
      },
    },
  });
  assert.deepEqual(
    (commandLine.commands as JsonObject[]).map((command) => command.name),
    ["lint", "test", "verify"],
  );

  const result = await validateMetadataContractRepository(
    new LocalExampleRepository(),
  );
  assert.deepEqual(result.deploy_targets, ["control-plane-api"]);
  assert.deepEqual(result.package_targets, ["control-plane-api"]);
  assert.deepEqual(result.rush_projects, ["control-plane-api"]);
});

test("canonical OCI metadata validates against root and v0.8.1 schemas", async () => {
  const schemaCases = [
    {
      metadataPath: ".dagger/application-images/providers.yaml",
      schemaName: "application-image-providers.schema.json",
    },
    {
      metadataPath: ".dagger/deploy/services-mesh.yaml",
      schemaName: "deploy-services-mesh.schema.json",
    },
    {
      metadataPath: ".dagger/deploy/targets/control-plane-api.yaml",
      schemaName: "deploy-target.schema.json",
    },
    {
      metadataPath: ".dagger/package/targets/control-plane-api.yaml",
      schemaName: "package-target.schema.json",
    },
    {
      metadataPath: ".dagger/rush-cache/providers.yaml",
      schemaName: "rush-cache-providers.schema.json",
    },
  ];

  for (const { metadataPath, schemaName } of schemaCases) {
    const metadata = await readYaml(metadataPath);
    const source = await readFile(path.join(exampleRoot, metadataPath), "utf8");
    const schemaUrl = `https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.8.1/${schemaName}`;
    assert.match(
      source,
      new RegExp(
        `yaml-language-server: \\$schema=${schemaUrl.replaceAll(".", "\\.")}`,
      ),
    );

    for (const schemaDirectory of ["schemas", "schemas/v0.8.1"]) {
      const schema = JSON.parse(
        await readFile(
          path.join(repositoryRoot, schemaDirectory, schemaName),
          "utf8",
        ),
      ) as AnySchema;
      const ajv = new Ajv2020({ allErrors: true });
      const validate = ajv.compile(schema);

      assert.ok(
        validate(metadata),
        `${metadataPath} must satisfy ${schemaDirectory}/${schemaName}\n${formatSchemaErrors(validate.errors)}`,
      );
    }
  }
});

test("canonical Rush lifecycle produces and verifies deterministic output", async () => {
  const packageJson = await readJson("apps/control-plane-api/package.json");
  const expectedScripts = {
    build: "node scripts/build.mjs",
    lint: "node scripts/build.mjs --check",
    test: "node scripts/build.mjs --check",
    verify: "node scripts/build.mjs --check",
  } as const;

  assert.deepEqual(packageJson.scripts, expectedScripts);

  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-oci-example-build-"),
  );
  const projectDirectory = path.join(tempDirectory, "control-plane-api");

  try {
    await cp(
      path.join(exampleRoot, "apps/control-plane-api"),
      projectDirectory,
      {
        recursive: true,
        filter: (sourcePath) => path.basename(sourcePath) !== "dist",
      },
    );

    const firstBuild = await execFileAsync(
      process.execPath,
      ["scripts/build.mjs"],
      { cwd: projectDirectory },
    );
    assert.equal(firstBuild.stdout, "Deterministic tutorial payload built.\n");

    for (const lifecycle of ["lint", "test", "verify"] as const) {
      const lifecycleResult = await execFileAsync(
        process.execPath,
        expectedScripts[lifecycle].split(" ").slice(1),
        { cwd: projectDirectory },
      );
      assert.equal(
        lifecycleResult.stdout,
        "Deterministic tutorial payload verified.\n",
      );
    }

    const outputPath = path.join(projectDirectory, "dist/payload.txt");
    const firstOutput = await readFile(outputPath);
    const firstDigest = createHash("sha256").update(firstOutput).digest("hex");
    const firstStats = await stat(outputPath);
    assert.equal(firstStats.mode & 0o777, 0o644);
    assert.equal(firstStats.mtimeMs, fixedOutputTimestamp);

    await writeFile(outputPath, "tampered\n", "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/build.mjs", "--check"], {
        cwd: projectDirectory,
      }),
    );
    await execFileAsync(process.execPath, ["scripts/build.mjs"], {
      cwd: projectDirectory,
    });

    const rebuiltOutput = await readFile(outputPath);
    const rebuiltDigest = createHash("sha256")
      .update(rebuiltOutput)
      .digest("hex");
    const rebuiltStats = await stat(outputPath);
    assert.equal(rebuiltDigest, firstDigest);
    assert.equal(rebuiltStats.mode & 0o777, 0o644);
    assert.equal(rebuiltStats.mtimeMs, fixedOutputTimestamp);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("canonical Dockerfile contains only the deterministic scratch payload", async () => {
  assert.equal(
    await readFile(
      path.join(exampleRoot, "apps/control-plane-api/Dockerfile"),
      "utf8",
    ),
    [
      "FROM scratch",
      "",
      "COPY --chmod=0444 dist/payload.txt /payload.txt",
      "USER 65532:65532",
      "",
    ].join("\n"),
  );
});

test("canonical deploy consumer accepts only a complete immutable handoff", async () => {
  const evidenceDirectory = await mkdtemp(
    path.join(tmpdir(), "rush-delivery-oci-example-evidence-"),
  );

  try {
    for (const fileName of ["sbom.spdx.json", "scan.json", "provenance.json"]) {
      await writeFile(path.join(evidenceDirectory, fileName), "{}\n", "utf8");
    }

    const environment = validDeployEnvironment(evidenceDirectory);
    const success = runDeploy(environment);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(
      success.stdout,
      `control-plane-api accepted immutable image: ${reference}\n`,
    );
    assert.equal(success.stderr, "");

    for (const requiredName of [
      "ARTIFACT_KIND",
      "ARTIFACT_IMAGE_NAME",
      "ARTIFACT_IMAGE_REFERENCE",
      "ARTIFACT_IMAGE_REPOSITORY",
      "ARTIFACT_IMAGE_DIGEST",
      "ARTIFACT_IMAGE_PLATFORMS_JSON",
      "ARTIFACT_SOURCE_REVISION",
      "ARTIFACT_EVIDENCE_DIR",
    ]) {
      const missing = { ...environment };
      delete missing[requiredName];
      const result = runDeploy(missing);
      assert.notEqual(result.status, 0, `${requiredName} must be required`);
      assert.match(result.stderr, new RegExp(`${requiredName} is required`));
      assert.equal(result.stdout, "");
    }

    const invalidCases: Array<{
      environment: NodeJS.ProcessEnv;
      expected: RegExp;
      name: string;
    }> = [
      {
        environment: { ...environment, ARTIFACT_KIND: "directory" },
        expected: /ARTIFACT_KIND must be oci_image/,
        name: "wrong artifact kind",
      },
      {
        environment: { ...environment, ARTIFACT_IMAGE_NAME: "other" },
        expected: /ARTIFACT_IMAGE_NAME must match/,
        name: "wrong image name",
      },
      {
        environment: {
          ...environment,
          ARTIFACT_IMAGE_REPOSITORY: "GHCR.IO/example/control-plane-api",
        },
        expected: /ARTIFACT_IMAGE_REPOSITORY must be a normalized/,
        name: "non-normalized repository",
      },
      {
        environment: {
          ...environment,
          ARTIFACT_IMAGE_DIGEST: `sha256:${"A".repeat(64)}`,
        },
        expected: /ARTIFACT_IMAGE_DIGEST must be a canonical/,
        name: "non-canonical digest",
      },
      {
        environment: {
          ...environment,
          ARTIFACT_SOURCE_REVISION: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
        },
        expected: /ARTIFACT_SOURCE_REVISION must be a full lowercase/,
        name: "non-canonical source revision",
      },
      {
        environment: {
          ...environment,
          ARTIFACT_IMAGE_PLATFORMS_JSON: '["linux/arm64"]',
        },
        expected: /ARTIFACT_IMAGE_PLATFORMS_JSON must match/,
        name: "wrong platform",
      },
      {
        environment: {
          ...environment,
          ARTIFACT_IMAGE_REFERENCE: `${repository}:latest`,
        },
        expected: /ARTIFACT_IMAGE_REFERENCE must equal repository@digest/,
        name: "mutable tag reference",
      },
      {
        environment: { ...environment, ARTIFACT_PATH: "" },
        expected: /ARTIFACT_PATH must be absent/,
        name: "filesystem artifact projection",
      },
      {
        environment: {
          ...environment,
          ARTIFACT_EVIDENCE_DIR: "relative/evidence",
        },
        expected: /ARTIFACT_EVIDENCE_DIR must be an absolute path/,
        name: "relative evidence directory",
      },
    ];

    for (const invalidCase of invalidCases) {
      const result = runDeploy(invalidCase.environment);
      assert.notEqual(result.status, 0, invalidCase.name);
      assert.match(result.stderr, invalidCase.expected, invalidCase.name);
      assert.equal(result.stdout, "", invalidCase.name);
    }

    await unlink(path.join(evidenceDirectory, "scan.json"));
    const missingEvidence = runDeploy(environment);
    assert.notEqual(missingEvidence.status, 0);
    assert.match(missingEvidence.stderr, /is missing scan\.json/);

    const sentinel = `secret-${process.pid}-${Date.now()}`;
    const sanitized = runDeploy({
      ...environment,
      ARTIFACT_IMAGE_REFERENCE: sentinel,
    });
    assert.notEqual(sanitized.status, 0);
    assert.equal(
      `${sanitized.stdout}${sanitized.stderr}`.includes(sentinel),
      false,
    );
  } finally {
    await rm(evidenceDirectory, { force: true, recursive: true });
  }
});

test("OCI acceptance is wired to build the public canonical example", async () => {
  const acceptance = await readFile(
    path.join(repositoryRoot, "test/scripts/run-oci-acceptance.sh"),
    "utf8",
  );

  assert.match(
    acceptance,
    /OCI_ACCEPTANCE_FIXTURE_SOURCE="\$\{OCI_ACCEPTANCE_REPO_ROOT\}\/examples\/oci-application-image-rush-repo"/,
  );
  assert.match(
    acceptance,
    /dagger --silent call build-and-package-deploy-targets/,
  );
  for (const excludedPath of [
    "./.dagger/runtime",
    "./apps/control-plane-api/.rush",
    "./apps/control-plane-api/dist",
    "./apps/control-plane-api/node_modules",
    "./apps/control-plane-api/rush-logs",
    "./common/temp",
    "./node_modules",
  ]) {
    assert.match(acceptance, new RegExp(`--exclude='${excludedPath}'`));
  }
  assert.doesNotMatch(acceptance, /test\/fixtures\/oci-rush-repo/);
});

test("canonical example shell entrypoints pass Bash syntax validation", async () => {
  const scripts = [
    deployScript,
    path.join(repositoryRoot, "test/scripts/run-oci-example-dry-run.sh"),
  ];

  for (const script of scripts) {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
