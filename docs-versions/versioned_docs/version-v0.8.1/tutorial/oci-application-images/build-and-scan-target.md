---
title: "1 - Build And Scan Target"
sidebar_label: "1 - Build And Scan Target"
---

This chapter defines what Package builds and what vulnerability policy must pass
before Rush Delivery can publish anything.

## Prerequisites

- Complete the [tutorial setup](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/docs/tutorial/oci-application-images/README.md#create-a-clean-tutorial-repository).
- Work from the root of the exported canonical example.
- Keep the repository clean so generated output is easy to distinguish.

## Choose The Artifact Boundary

Choose one artifact kind per deploy target:

| Kind                  | Choose it when                                                                                               | Deploy handoff                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `oci_image`           | The service is delivered as a container image and must be scanned, signed, attested, and deployed by digest. | `ARTIFACT_IMAGE_REFERENCE` plus target-scoped evidence |
| `directory`           | A platform consumes a built directory, such as static web assets.                                            | `ARTIFACT_PATH`                                        |
| `rush_deploy_archive` | A Node.js service needs Rush's deploy scenario materialized as an archive/directory.                         | `ARTIFACT_PATH`                                        |

Only `oci_image` activates the application-image provider contract. Mixing OCI
and filesystem artifacts is supported; the manifest becomes v2 while the
filesystem artifact fields remain unchanged.

## The Complete Build And Image Inputs

The example's complete deterministic build script is
[`apps/control-plane-api/scripts/build.mjs`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/examples/oci-application-image-rush-repo/apps/control-plane-api/scripts/build.mjs):

```js
import {
  chmod,
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourcePath = path.join(projectDirectory, "src/payload.txt");
const outputDirectory = path.join(projectDirectory, "dist");
const outputPath = path.join(outputDirectory, "payload.txt");
const outputMode = 0o644;
const outputTimestamp = new Date("2000-01-01T00:00:00.000Z");
const providerEnvironmentNames = [
  "RD_OCI_GHCR_USERNAME",
  "RD_OCI_GHCR_TOKEN",
  "RD_OCI_COSIGN_PRIVATE_KEY",
  "RD_OCI_COSIGN_PASSWORD",
  "RD_OCI_COSIGN_PUBLIC_KEY",
];

for (const name of providerEnvironmentNames) {
  if (Object.hasOwn(process.env, name)) {
    throw new Error(
      `Tutorial Rush Build received framework-owned provider environment name ${name}.`,
    );
  }
}

const source = await readFile(sourcePath, "utf8");

if (process.argv.includes("--check")) {
  const output = await readFile(outputPath, "utf8");
  const outputStats = await stat(outputPath);

  if (output !== source) {
    throw new Error("Built tutorial payload does not match its source.");
  }
  if ((outputStats.mode & 0o777) !== outputMode) {
    throw new Error("Built tutorial payload does not have mode 0644.");
  }
  if (outputStats.mtimeMs !== outputTimestamp.getTime()) {
    throw new Error(
      "Built tutorial payload does not have its fixed timestamp.",
    );
  }

  process.stdout.write("Deterministic tutorial payload verified.\n");
} else {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, source, { encoding: "utf8", mode: outputMode });
  await chmod(outputPath, outputMode);
  await utimes(outputPath, outputTimestamp, outputTimestamp);
  process.stdout.write("Deterministic tutorial payload built.\n");
}
```

The complete
[`apps/control-plane-api/Dockerfile`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/examples/oci-application-image-rush-repo/apps/control-plane-api/Dockerfile)
copies only that built output:

```dockerfile
# checkov:skip=CKV_DOCKER_2:Intentional non-service scratch image has no executable health endpoint
FROM scratch

COPY --chmod=0444 dist/payload.txt /payload.txt
USER 65532:65532
```

The complete package target is
[`control-plane-api.yaml`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/examples/oci-application-image-rush-repo/.dagger/package/targets/control-plane-api.yaml):

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.8.1/package-target.schema.json
name: control-plane-api
artifact:
  kind: oci_image
  context: apps/control-plane-api
  dockerfile: apps/control-plane-api/Dockerfile
  image: control-plane-api
  platform: linux/amd64
  scan:
    fail_on:
      - high
      - critical
    ignore_file: .dagger/application-images/grype.yaml
```

The complete governed Grype configuration is
[`grype.yaml`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/examples/oci-application-image-rush-repo/.dagger/application-images/grype.yaml):

```yaml
# Grype 0.116.1 reads this configuration during OCI packaging. The tutorial
# starts with no vulnerability suppressions. Govern every future exception with
# an owner, reason, review/expiry date, and removal follow-up in adjacent comments.
ignore: []
```

The normal `workflow` and `build-and-package-deploy-targets` paths run the Rush
build before Package. The standalone `package-deploy-targets` function does
not: its `repo` input must already contain the complete built workspace. Do not
point standalone Package at a clean checkout whose Dockerfile copies `dist`.

`context` and `dockerfile` are repository-relative. The Dockerfile must be
strictly inside its context, so this target resolves it as
`apps/control-plane-api/Dockerfile` inside `apps/control-plane-api`. `image` is
only a lowercase repository suffix; the selected provider later prefixes it
with the registry and repository namespace. `v0.8.1` requires exactly one
explicit normalized platform, here `linux/amd64`.

Package adds `org.opencontainers.image.revision=<full-40-character-sha>` and,
when supplied, `org.opencontainers.image.source=<trusted-source-url>`. The
source URL must not contain credentials, whitespace, or control characters.
The live SHA should be the immutable revision of the exact source being built.

The `scan.fail_on` list is an exact set, not a severity threshold. A policy of
only `high` rejects High findings but does not implicitly reject Critical
findings. The production example lists both `high` and `critical` intentionally.

Rush Delivery pins the Grype executable image, but Grype's vulnerability
database/cache changes over time. A previously clean image can therefore fail a
later scan. Treat that as new security information. If an exception is required,
use a supported Grype `ignore` entry and record its vulnerability ID, owner,
reason, review/expiry date, and removal follow-up beside it. Review exceptions
and the database/cache retention policy independently from the pinned scanner
version.

The supported `v0.8.1` image-build surface is the schema above: one context,
one contained Dockerfile, one image suffix, one platform, trusted source labels,
and the documented scan policy. Do not infer support for metadata-driven build
arguments, secrets, SSH forwarding, extra contexts, multi-platform indexes, or
custom Dockerfile frontends. See the
[package-target schema](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/schemas/v0.8.1/package-target.schema.json) and
[OCI application-image contract](../../../oci-application-images) for the
bounded surface.

## Exercise The Deterministic Build

```bash
set -euo pipefail

node common/scripts/install-run-rush.js install --max-install-attempts 1
node common/scripts/install-run-rush.js build --to control-plane-api
cmp \
  apps/control-plane-api/src/payload.txt \
  apps/control-plane-api/dist/payload.txt
```

Sanitized expected output:

```text
Rush Multi-Project Build Tool <version>
... control-plane-api ... SUCCESS ...
```

If Rush install fails, resolve package-manager/network trust before proceeding.
If `cmp` fails or `dist/payload.txt` is absent, Package would later fail the
Docker build; repair the normal Rush build rather than generating output in the
Dockerfile.

## Checkpoint

```bash
test "$(cat apps/control-plane-api/dist/payload.txt)" = \
  "$(cat apps/control-plane-api/src/payload.txt)"
git check-ignore apps/control-plane-api/dist/payload.txt
```

The second command should print `apps/control-plane-api/dist/payload.txt`,
confirming that generated build output is not committed.

Next: [Provider-Off Dry Run](../provider-off-dry-run).
