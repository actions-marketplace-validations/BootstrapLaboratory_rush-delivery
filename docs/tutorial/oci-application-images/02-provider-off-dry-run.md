# 2. Provider-Off Dry Run

This chapter plans the OCI target without registry or signing credentials and
without publishing an image.

## Prerequisites

- Complete [Build And Scan Target](01-build-and-scan-target.md).
- Dagger CLI/engine `v0.20.7` must be running.
- Do not create an OCI env file or export any `RD_OCI_*` credentials yet.

Use the exact synthetic full SHA below for this dry-run exercise. It is valid
shape-wise but is deliberately not a production source identity.

```bash
set -euo pipefail

export RUSH_DELIVERY_MODULE="github.com/BootstrapLaboratory/rush-delivery@v0.8.1"
export TUTORIAL_DRY_SHA="0123456789abcdef0123456789abcdef01234567"
test "${#TUTORIAL_DRY_SHA}" -eq 40
```

## Validate Metadata First

Repository-wide validation checks package, provider, deploy, and cross-file
contracts without running the release workflow:

```bash
dagger -m "${RUSH_DELIVERY_MODULE}" call validate-metadata-contract \
  --repo=.
```

Sanitized expected output:

```json
{
  "deploy_targets": ["control-plane-api"],
  "package_targets": ["control-plane-api"],
  "release_targets": [],
  "rush_projects": ["control-plane-api"],
  "validation_targets": []
}
```

The important checkpoint is a successful command with exactly the expected
target/project names. A failure here means the `.dagger` files disagree; fix it
before interpreting a workflow failure as a registry or build problem.

## Run The Composed Dry Run

Provider `off` is the explicit credential-free planning mode:

```bash
dagger -m "${RUSH_DELIVERY_MODULE}" call workflow \
  --repo=. \
  --git-sha="${TUTORIAL_DRY_SHA}" \
  --event-name=workflow_call \
  --force-targets-json='["control-plane-api"]' \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --application-image-provider=off \
  --source-mode=local_copy
```

Sanitized expected output contains this package intent and deploy dry-run
summary:

```text
[package] control-plane-api: oci_image
package_artifact_kind=oci_image
package_artifact_status=planned
package_artifact_image=control-plane-api
package_artifact_platforms=["linux/amd64"]
package_artifact_publication=no-image-or-digest-produced-dry-run
```

There is no `package_artifact_repository`, digest, reference, or evidence path
because provider `off` has no destination identity.

Export the planned package so the manifest itself can be inspected:

```bash
PLAN_DIR="${TMPDIR:-/tmp}/rush-delivery-oci-provider-off-plan"
test ! -e "${PLAN_DIR}"

dagger -m "${RUSH_DELIVERY_MODULE}" call \
  build-and-package-deploy-targets \
  --repo=. \
  --ci-plan-file=ci/oci-plan.json \
  --artifact-prefix=deploy-target \
  --git-sha="${TUTORIAL_DRY_SHA}" \
  --source-repository-url=https://github.com/example/control-plane.git \
  --dry-run=true \
  --application-image-provider=off \
  export --path="${PLAN_DIR}"

jq . "${PLAN_DIR}/.dagger/runtime/package-manifest.json"
```

Sanitized expected manifest (this is also a complete schema-valid planned v2
manifest):

```json
{
  "schema_version": "rush-delivery-package-manifest/v2",
  "artifacts": {
    "control-plane-api": {
      "image": "control-plane-api",
      "kind": "oci_image",
      "platforms": ["linux/amd64"],
      "source_revision": "0123456789abcdef0123456789abcdef01234567",
      "status": "planned"
    }
  }
}
```

## What Did And Did Not Run

| Selection       | Provider mode                                     | Dry-run behavior                                                                           |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Filesystem-only | `off`, malformed unused file, or no provider file | Provider metadata and OCI credentials are irrelevant.                                      |
| OCI             | `off`                                             | Plans relative image, platform, and source revision; no repository.                        |
| OCI             | named provider                                    | Parses that provider and plans its repository; requires and resolves no credential values. |

The provider-off dry run performs no application-image Docker build, no
destination-registry request, no Syft or Grype execution, no Cosign execution,
no provider credential read, no signing, and no live Deploy script or deploy-tag
side effect. The composed workflow still acquires source, installs dependencies,
runs the normal Rush build, packages a plan, and formats a Deploy dry-run
summary. Source acquisition, module/base-image pulls, dependency installation,
and Rush Build can therefore use the network depending on the selected
entrypoint and cache state.

A short SHA fails before planning. A live run with an OCI selection and provider
`off` fails before Rush Build/image preparation with an instruction to select a
configured provider. A dry-run failure mentioning Syft, Grype, Cosign, or a
registry request indicates a regression: none belongs to this path.

## Checkpoint

```bash
jq -e \
  '.artifacts["control-plane-api"]
   | .status == "planned"
     and .source_revision == "0123456789abcdef0123456789abcdef01234567"
     and (has("repository") | not)
     and (has("digest") | not)
     and (has("evidence") | not)' \
  "${PLAN_DIR}/.dagger/runtime/package-manifest.json"
```

`jq` should print `true` and exit zero.

Next: [Registry And Cosign Bootstrap](03-registry-and-cosign-bootstrap.md).
