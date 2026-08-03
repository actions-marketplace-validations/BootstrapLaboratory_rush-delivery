import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import * as assert from "node:assert/strict";
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

test("v0.8.0 snapshots every current schema with only a versioned id", async () => {
  const schemaNames = (await readdir(path.join(repoRoot, "schemas")))
    .filter((entry) => entry.endsWith(".schema.json"))
    .sort();
  const snapshotNames = (await readdir(path.join(repoRoot, "schemas/v0.8.0")))
    .filter((entry) => entry.endsWith(".schema.json"))
    .sort();

  assert.deepEqual(snapshotNames, schemaNames);

  for (const schemaName of schemaNames) {
    const current = (await readJson(`schemas/${schemaName}`)) as Record<
      string,
      unknown
    >;
    const snapshot = (await readJson(`schemas/v0.8.0/${schemaName}`)) as Record<
      string,
      unknown
    >;

    assert.equal(
      snapshot.$id,
      `https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.8.0/${schemaName}`,
    );
    assert.deepEqual(
      { ...snapshot, $id: current.$id },
      current,
      `${schemaName} snapshot must differ from the root schema only by $id`,
    );
  }
});
