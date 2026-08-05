import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

type SchemaCase = {
  metadataPaths: string[];
  schemaPath: string;
};

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "..");
const fixtureRoot = path.resolve(testDirectory, "fixtures/rush-repo");
const ociFixtureRoot = path.resolve(testDirectory, "fixtures/oci-contract");

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function readYaml(relativePath: string): Promise<unknown> {
  return parseYaml(
    await readFile(path.join(fixtureRoot, relativePath), "utf8"),
  );
}

async function listYamlFiles(relativeDirectory: string): Promise<string[]> {
  const entries = await readdir(path.join(fixtureRoot, relativeDirectory));

  return entries
    .filter((entry) => entry.endsWith(".yaml"))
    .sort()
    .map((entry) => `${relativeDirectory}/${entry}`);
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? [])
    .map((error) => {
      const pathPrefix = error.instancePath ? `${error.instancePath} ` : "";
      return `${pathPrefix}${error.message ?? "failed schema validation"}`;
    })
    .join("\n");
}

test("fixture Dagger metadata files satisfy their JSON schemas", async () => {
  const schemaCases: SchemaCase[] = [
    {
      metadataPaths: [".dagger/deploy/services-mesh.yaml"],
      schemaPath: "schemas/deploy-services-mesh.schema.json",
    },
    {
      metadataPaths: await listYamlFiles(".dagger/deploy/targets"),
      schemaPath: "schemas/deploy-target.schema.json",
    },
    {
      metadataPaths: await listYamlFiles(".dagger/package/targets"),
      schemaPath: "schemas/package-target.schema.json",
    },
    {
      metadataPaths: [".dagger/toolchain-images/providers.yaml"],
      schemaPath: "schemas/toolchain-image-providers.schema.json",
    },
    {
      metadataPaths: [".dagger/rush-cache/providers.yaml"],
      schemaPath: "schemas/rush-cache-providers.schema.json",
    },
    {
      metadataPaths: [".dagger/release/npm.yaml"],
      schemaPath: "schemas/npm-release.schema.json",
    },
    {
      metadataPaths: await listYamlFiles(".dagger/validate/targets"),
      schemaPath: "schemas/validation-target.schema.json",
    },
  ];

  for (const schemaCase of schemaCases) {
    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile(
      (await readJson(schemaCase.schemaPath)) as AnySchema,
    );

    for (const metadataPath of schemaCase.metadataPaths) {
      const valid = validate(await readYaml(metadataPath));

      assert.ok(
        valid,
        `${metadataPath} must satisfy ${schemaCase.schemaPath}\n${formatSchemaErrors(validate.errors)}`,
      );
    }
  }
});

test("OCI metadata and manifest fixtures satisfy their JSON schemas", async () => {
  const schemaCases = [
    {
      fixturePath: "package-target.yaml",
      schemaPath: "schemas/package-target.schema.json",
      yaml: true,
    },
    {
      fixturePath: "application-image-providers.yaml",
      schemaPath: "schemas/application-image-providers.schema.json",
      yaml: true,
    },
    {
      fixturePath: "package-manifest.json",
      schemaPath: "schemas/package-manifest.schema.json",
      yaml: false,
    },
  ];

  for (const schemaCase of schemaCases) {
    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile(
      (await readJson(schemaCase.schemaPath)) as AnySchema,
    );
    const source = await readFile(
      path.join(ociFixtureRoot, schemaCase.fixturePath),
      "utf8",
    );
    const value = schemaCase.yaml ? parseYaml(source) : JSON.parse(source);

    assert.ok(
      validate(value),
      `${schemaCase.fixturePath} must satisfy ${schemaCase.schemaPath}\n${formatSchemaErrors(validate.errors)}`,
    );
  }
});

test("application provider schema matches coordinate XOR combinations", async () => {
  const schema = (await readJson(
    "schemas/application-image-providers.schema.json",
  )) as AnySchema;
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const baseProvider = {
    kind: "oci_registry",
    signing_key_env: "OCI_SIGNING_KEY",
    signing_password_env: "OCI_SIGNING_PASSWORD",
    token_env: "OCI_TOKEN",
    username_env: "OCI_USERNAME",
    verification_key_env: "OCI_VERIFICATION_KEY",
  };

  for (const coordinates of [
    { registry: "registry.example", repository_prefix: "example/platform" },
    {
      registry: "registry.example",
      repository_prefix_env: "OCI_REPOSITORY",
    },
    {
      registry_env: "OCI_REGISTRY",
      repository_prefix: "example/platform",
    },
    {
      registry_env: "OCI_REGISTRY",
      repository_prefix_env: "OCI_REPOSITORY",
    },
  ]) {
    assert.equal(
      validate({ providers: { release: { ...baseProvider, ...coordinates } } }),
      true,
      formatSchemaErrors(validate.errors),
    );
  }

  for (const coordinates of [
    { repository_prefix: "example/platform" },
    {
      registry: "registry.example",
      registry_env: "OCI_REGISTRY",
      repository_prefix: "example/platform",
    },
    { registry: "registry.example" },
    {
      registry: "registry.example",
      repository_prefix: "example/platform",
      repository_prefix_env: "OCI_REPOSITORY",
    },
  ]) {
    assert.equal(
      validate({ providers: { release: { ...baseProvider, ...coordinates } } }),
      false,
    );
  }
});

test("Rush toolchain fixture satisfies its strict root schema", async () => {
  const schema = (await readJson(
    "schemas/rush-toolchain.schema.json",
  )) as AnySchema;
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const fixture = parseYaml(
    await readFile(
      path.join(testDirectory, "fixtures/rush-toolchain.yaml"),
      "utf8",
    ),
  );

  assert.equal(validate(fixture), true, formatSchemaErrors(validate.errors));
  for (const mutation of [
    { ...fixture, command: "curl" },
    { ...fixture, base_image: "node:24-bookworm-slim" },
    { ...fixture, platform: "linux/arm64" },
  ]) {
    assert.equal(validate(mutation), false);
  }
});

test("OCI package target schema requires a safe evidence target and normalized paths", async () => {
  const schema = (await readJson(
    "schemas/package-target.schema.json",
  )) as AnySchema;
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  const target = {
    artifact: {
      context: "apps/server",
      dockerfile: "apps/server/Dockerfile",
      image: "server",
      kind: "oci_image",
      platform: "linux/amd64",
      scan: { fail_on: ["high"] },
    },
    name: "server",
  };

  assert.equal(validate(target), true, formatSchemaErrors(validate.errors));

  for (const unsafeName of [".", "..", "nested/server", "nested\\server"]) {
    const value = structuredClone(target);
    value.name = unsafeName;
    assert.equal(
      validate(value),
      false,
      `OCI target name ${JSON.stringify(unsafeName)} must be rejected`,
    );
  }

  for (const [field, unsafePath] of [
    ["context", "apps/server/"],
    ["dockerfile", "apps/server/."],
    ["dockerfile", "apps/server/Dockerfile/"],
  ] as const) {
    const value = structuredClone(target);
    value.artifact[field] = unsafePath;
    assert.equal(
      validate(value),
      false,
      `OCI ${field} ${JSON.stringify(unsafePath)} must be rejected`,
    );
  }

  assert.equal(
    validate({
      artifact: { kind: "directory", path: "apps/server/dist" },
      name: "nested/server",
    }),
    true,
    formatSchemaErrors(validate.errors),
  );
});

test("released v0.8.0 schema snapshots remain byte-immutable", async () => {
  const expectedDigests: Record<string, string> = {
    "application-image-providers.schema.json":
      "87b2d40f02729f2ca3856936eabd27499439dfbff69991da9443d09d3e863b3e",
    "deploy-services-mesh.schema.json":
      "51008a4ec3792f0c1837fb96aa9d8fc0133ff46c5b111460491ddf362a054377",
    "deploy-target.schema.json":
      "993f198da25fe0ebaecfa49fabf8aaa0f0b1d7f09ca54c63672e44f407f20556",
    "npm-release.schema.json":
      "0d61b701788aea978a266463861c37bdf3a008669bc01f271c657470717ca8c4",
    "package-manifest.schema.json":
      "1e96db402f755c03300378d71936bafdb10da2b8cc781ee515623d51aeb7bab8",
    "package-target.schema.json":
      "14872ba6b87bce53efd36b902edb2c339eaa32a107a5ffad573f0ad8cf8b456d",
    "rush-cache-providers.schema.json":
      "422f0566a72fe3f3da84803d4946b747b6ac184cec7f4528754126ac6a00e3dc",
    "toolchain-image-providers.schema.json":
      "fc096a9ae0d15fc8888021acd5b6249b2939461a3d7552c8731ebabf99aeb98b",
    "validation-target.schema.json":
      "c6ccb72799c2ee0faf584bc1612b1bfd62ff75703b52bdaaf0915780f9a2e707",
  };
  const snapshotNames = (await readdir(path.join(repoRoot, "schemas/v0.8.0")))
    .filter((entry) => entry.endsWith(".schema.json"))
    .sort();

  assert.deepEqual(snapshotNames, Object.keys(expectedDigests).sort());

  for (const schemaName of snapshotNames) {
    const contents = await readFile(
      path.join(repoRoot, "schemas/v0.8.0", schemaName),
    );
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      expectedDigests[schemaName],
      `${schemaName} must remain byte-identical to the released v0.8.0 snapshot`,
    );
  }
});

test("released v0.8.1 schema snapshots remain byte-immutable", async () => {
  const expectedDigests: Record<string, string> = {
    "application-image-providers.schema.json":
      "1a7c65eff5e47e52fa90554add5af10736a6deacc3472773f290673ff42d35c5",
    "deploy-services-mesh.schema.json":
      "74702820f5be65ed94a533f8d830fd17061254f42c2bb90d9596fdb34d3ce42c",
    "deploy-target.schema.json":
      "4d51fd7c98f95867f38d655c4192383eb0fa47ad3d714699e516b15356ec8ef4",
    "npm-release.schema.json":
      "e2c879ebb7b9bf6e31f25f6a95340c00272728624f9469e485e5e43758f620d7",
    "package-manifest.schema.json":
      "1d2ff5771be9150d322249316567592a8ffe15ce7ef1690c16b1483f50097425",
    "package-target.schema.json":
      "00bc0dad0f6b878878146ee7241238e93a2b3ade92111d82a112cead358a66fd",
    "rush-cache-providers.schema.json":
      "576a27b5de68c7e500cb71c476b25a6b260842190f86117dcff3876cc25b9f2c",
    "toolchain-image-providers.schema.json":
      "f4c5fdf204ed97789aa1256537b05ccaed4b222defe921c30ce67ab45d93d5c2",
    "validation-target.schema.json":
      "f4e9d7bdd6fc37392ad4ee964cdb37c0ac4193db4574c52de2c8f89fde84450a",
  };
  const snapshotNames = (await readdir(path.join(repoRoot, "schemas/v0.8.1")))
    .filter((entry) => entry.endsWith(".schema.json"))
    .sort();

  assert.deepEqual(snapshotNames, Object.keys(expectedDigests).sort());

  for (const schemaName of snapshotNames) {
    const contents = await readFile(
      path.join(repoRoot, "schemas/v0.8.1", schemaName),
    );
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      expectedDigests[schemaName],
      `${schemaName} must remain byte-identical to the released v0.8.1 snapshot`,
    );
  }
});

test("current root schemas match the complete v0.9.0 snapshot", async () => {
  const rootNames = (
    await readdir(path.join(repoRoot, "schemas"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
    .map((entry) => entry.name)
    .sort();
  const snapshotNames = (await readdir(path.join(repoRoot, "schemas/v0.9.0")))
    .filter((entry) => entry.endsWith(".schema.json"))
    .sort();

  assert.deepEqual(snapshotNames, rootNames);
  for (const schemaName of rootNames) {
    const rootSchema = await readFile(
      path.join(repoRoot, "schemas", schemaName),
      "utf8",
    );
    const snapshotSchema = await readFile(
      path.join(repoRoot, "schemas/v0.9.0", schemaName),
      "utf8",
    );
    assert.equal(
      snapshotSchema.replace("/schemas/v0.9.0/", "/schemas/"),
      rootSchema,
      `${schemaName} must differ only by the immutable v0.9.0 $id`,
    );
  }
});

test("deploy target schema reserves framework-owned output names", async () => {
  const schema = (await readJson(
    "schemas/deploy-target.schema.json",
  )) as AnySchema;
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  const reservedNames = [
    "ARTIFACT_PATH",
    "ARTIFACT_KIND",
    "ARTIFACT_IMAGE_NAME",
    "ARTIFACT_IMAGE_REFERENCE",
    "ARTIFACT_IMAGE_REPOSITORY",
    "ARTIFACT_IMAGE_DIGEST",
    "ARTIFACT_IMAGE_PLATFORMS_JSON",
    "ARTIFACT_SOURCE_REVISION",
    "ARTIFACT_EVIDENCE_DIR",
    "ARTIFACT_FUTURE_NAME",
    "GIT_SHA",
    "DRY_RUN",
  ];

  for (const name of reservedNames) {
    const runtimes = [
      { image: "node:24-bookworm-slim", pass_env: [name] },
      {
        image: "node:24-bookworm-slim",
        map_env: { [name]: "SAFE_SOURCE" },
      },
      { env: { [name]: "value" }, image: "node:24-bookworm-slim" },
      {
        dry_run_defaults: { [name]: "value" },
        image: "node:24-bookworm-slim",
      },
      {
        image: "node:24-bookworm-slim",
        required_host_env: [name],
      },
      {
        file_mounts: [{ source_var: name, target: "/run/value" }],
        image: "node:24-bookworm-slim",
      },
    ];

    for (const runtime of runtimes) {
      assert.equal(
        validate({
          deploy_script: "deploy/server.sh",
          name: "server",
          runtime,
        }),
        false,
        `${name} must be rejected from ${JSON.stringify(runtime)}`,
      );
    }
  }

  assert.equal(
    validate({
      deploy_script: "deploy/server.sh",
      name: "server",
      runtime: {
        image: "node:24-bookworm-slim",
        map_env: { PROJECT_GIT_SHA: "GIT_SHA" },
      },
    }),
    true,
    formatSchemaErrors(validate.errors),
  );

  for (const target of [
    "/",
    "/workspace",
    "/workspace/.dagger",
    "/workspace/.dagger/runtime",
    "/workspace/.dagger/runtime/evidence",
    "/workspace/.dagger/runtime/evidence/server/scan.json",
    ".dagger",
    ".dagger/runtime",
    ".dagger/runtime/evidence",
    ".dagger/runtime/evidence/server/scan.json",
  ]) {
    assert.equal(
      validate({
        deploy_script: "deploy/server.sh",
        name: "server",
        runtime: {
          file_mounts: [{ source: "credential.json", target }],
          image: "node:24-bookworm-slim",
        },
      }),
      false,
      `unsafe file mount target ${JSON.stringify(target)} must be rejected`,
    );
  }

  for (const target of [
    "/tmp\\credential.json",
    "/tmp//credential.json",
    "/tmp/../credential.json",
  ]) {
    assert.equal(
      validate({
        deploy_script: "deploy/server.sh",
        name: "server",
        runtime: {
          file_mounts: [{ source: "credential.json", target }],
          image: "node:24-bookworm-slim",
        },
      }),
      true,
      `non-colliding legacy mount target ${JSON.stringify(target)} must remain schema-compatible: ${formatSchemaErrors(validate.errors)}`,
    );
  }
});

test("package manifest schema preserves filesystem target keys and rejects unsafe OCI evidence paths", async () => {
  const schema = (await readJson(
    "schemas/package-manifest.schema.json",
  )) as AnySchema;
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  const digest = `sha256:${"a".repeat(64)}`;
  const repository = "registry.example/example/server";
  const manifest = {
    artifacts: {
      server: {
        digest,
        evidence: {
          provenance: {
            digest,
            format: "slsa-provenance-v1",
            path: ".dagger/runtime/evidence/server/provenance.json",
            subject_digest: digest,
          },
          sbom: {
            digest,
            format: "spdx-json",
            path: ".dagger/runtime/evidence/server/sbom.spdx.json",
            subject_digest: digest,
          },
          scan: {
            digest,
            path: ".dagger/runtime/evidence/server/scan.json",
            policy: ["high", "critical"],
            result: "passed",
            scanner: "grype-0.116.1",
          },
          signature: {
            kind: "sigstore",
            reference: `${repository}@${digest}`,
            verified: true,
          },
        },
        image: "server",
        kind: "oci_image",
        platforms: ["linux/amd64"],
        reference: `${repository}@${digest}`,
        repository,
        source_revision: "0123456789abcdef0123456789abcdef01234567",
        status: "published",
      },
    },
    schema_version: "rush-delivery-package-manifest/v2",
  };

  assert.equal(validate(manifest), true, formatSchemaErrors(validate.errors));

  assert.equal(
    validate({
      artifacts: {
        "legacy/filesystem-target": {
          deploy_path: "apps/web/dist",
          kind: "directory",
          path: "apps/web/dist",
        },
      },
      schema_version: "rush-delivery-package-manifest/v2",
    }),
    true,
    formatSchemaErrors(validate.errors),
  );

  for (const unsafeTarget of [
    "",
    ".",
    "..",
    "nested/server",
    "nested\\server",
  ]) {
    const value = structuredClone(manifest) as {
      artifacts: Record<string, unknown>;
    };
    value.artifacts[unsafeTarget] = value.artifacts.server;
    delete value.artifacts.server;

    assert.equal(
      validate(value),
      false,
      `OCI artifact target ${JSON.stringify(unsafeTarget)} must be rejected`,
    );
  }

  for (const unsafePath of [
    ".dagger/runtime/evidence/../server/sbom.spdx.json",
    ".dagger/runtime/evidence/./sbom.spdx.json",
    ".dagger/runtime/evidence/server//sbom.spdx.json",
    ".dagger/runtime/evidence/server/../sbom.spdx.json",
    ".dagger\\runtime\\evidence\\server\\sbom.spdx.json",
    ".dagger/runtime/evidence/server/sbom file.spdx.json",
    ".dagger/runtime/evidence/server/sbom.spdx.json/",
  ]) {
    const value = structuredClone(manifest);
    value.artifacts.server.evidence.sbom.path = unsafePath;

    assert.equal(
      validate(value),
      false,
      `evidence path ${JSON.stringify(unsafePath)} must be rejected`,
    );
  }

  for (const [document, unsafeFormat] of [
    ["provenance", "spdx-json"],
    ["sbom", "slsa-provenance-v1"],
  ] as const) {
    const value = structuredClone(manifest);
    value.artifacts.server.evidence[document].format = unsafeFormat;

    assert.equal(
      validate(value),
      false,
      `${document} format ${JSON.stringify(unsafeFormat)} must be rejected`,
    );
  }

  for (const field of ["deploy_path", "path"] as const) {
    const value = {
      artifacts: {
        webapp: {
          deploy_path: "apps/web/dist",
          kind: "directory",
          path: "apps/web/dist",
        },
      },
      schema_version: "rush-delivery-package-manifest/v2",
    };
    value.artifacts.webapp[field] += "/";

    assert.equal(
      validate(value),
      false,
      `filesystem artifact ${field} with a trailing slash must be rejected`,
    );
  }
});
