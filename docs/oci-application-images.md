# OCI Application Images

Rush Delivery can package a deploy target as a single-platform OCI image. The
Package stage builds the image from the already-built Dagger workspace,
generates and checks supply-chain evidence, publishes it once, signs and
attests the returned digest, verifies the result, and only then writes the
package manifest. Deploy scripts consume the immutable digest and never rebuild
the image.

This feature is opt-in. Existing projects that use only `directory` or
`rush_deploy_archive` artifacts do not need application-image metadata or new
credentials after upgrading to v0.8.0. They continue to receive the existing
unversioned manifest and `ARTIFACT_PATH` deploy handoff.

## Package Target

Declare one image for each deploy target in
`.dagger/package/targets/<target>.yaml`:

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.8.0/package-target.schema.json
name: control-plane-api

artifact:
  kind: oci_image
  context: .
  dockerfile: deploy/images/control-plane-api.Dockerfile
  image: control-plane-api
  platform: linux/amd64
  scan:
    fail_on:
      - high
      - critical
    ignore_file: .dagger/application-images/grype.yaml
```

`context`, `dockerfile`, and the optional scanner configuration are
repository-relative. The Dockerfile must be inside the declared context.
`image` is a relative repository suffix without a registry, tag, or digest.
v0.8.0 requires exactly one explicit platform.

The Package stage runs after the normal Rush build, so the Dockerfile can copy
compiled output from the workspace. The standalone `packageDeployTargets`
entrypoint also treats its input as already built.

## Registry And Signing Provider

Application image providers live at the exact path
`.dagger/application-images/providers.yaml`. They are separate from framework
toolchain-image and Rush-cache providers.

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.8.0/application-image-providers.schema.json
providers:
  release:
    kind: oci_registry
    registry: europe-west1-docker.pkg.dev
    repository_prefix: example/platform
    username_env: OCI_USERNAME
    token_env: OCI_TOKEN
    signing_key_env: OCI_SIGNING_KEY
    signing_password_env: OCI_SIGNING_PASSWORD
    verification_key_env: OCI_SIGNING_PUBLIC_KEY
```

The provider is registry-neutral: `registry` is an authority without a URL
scheme and `repository_prefix` is a repository path. Rush Delivery publishes
`<registry>/<repository_prefix>/<artifact.image>`.

Select it with `application-image-provider: release` in the GitHub Action or
`--application-image-provider=release` in a Dagger call. The default `off`
keeps existing projects unchanged. A live run with a selected OCI target and
provider `off` fails before the image is built; dry runs may keep it off.

Provider metadata contains environment variable names, never secret values.
Place the selected provider's values in `workflow-env` or `deploy-env`:

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.8.0
  with:
    dry-run: "false"
    application-image-provider: release
    deploy-env: |
      OCI_USERNAME=${{ secrets.OCI_USERNAME }}
      OCI_TOKEN=${{ secrets.OCI_TOKEN }}
      OCI_SIGNING_KEY=${{ secrets.OCI_SIGNING_KEY }}
      OCI_SIGNING_PASSWORD=${{ secrets.OCI_SIGNING_PASSWORD }}
      OCI_SIGNING_PUBLIC_KEY=${{ vars.OCI_SIGNING_PUBLIC_KEY }}
```

The signing key must be a password-protected Cosign private key and the
verification key its PEM public key. A flat env file cannot contain literal
newlines, so multiline PEM values may use literal `\n` separators; Rush
Delivery decodes and validates them before creating Dagger secrets.

Registry tokens, signing keys, and signing passwords are available only to the
Package operation. They are not Docker build arguments, workspace files,
manifest fields, evidence, workflow results, or deploy runtime variables.

## Dry Runs

Dry runs validate target and provider metadata but do not resolve credentials,
build, scan, publish, sign, or deploy. With provider `off`, output shows the
relative image and platform. With a named provider, output also shows the
planned canonical repository. Planned artifacts never contain a fabricated
digest, signature, or evidence result.

## Manifest And Deploy Handoff

Any selection containing an OCI image produces the strict
`rush-delivery-package-manifest/v2` envelope. A successful image artifact
contains a canonical `repository@sha256:...` reference, the full source
revision, its platform, and verified evidence. Mixed selections put filesystem
and OCI artifacts in the same v2 envelope without changing filesystem artifact
fields.

For a published OCI image, the selected deploy script receives:

```text
ARTIFACT_KIND=oci_image
ARTIFACT_IMAGE_NAME=<package metadata image>
ARTIFACT_IMAGE_REFERENCE=<repository>@sha256:<digest>
ARTIFACT_IMAGE_REPOSITORY=<repository>
ARTIFACT_IMAGE_DIGEST=sha256:<digest>
ARTIFACT_IMAGE_PLATFORMS_JSON=["linux/amd64"]
ARTIFACT_SOURCE_REVISION=<full-git-sha>
ARTIFACT_EVIDENCE_DIR=/workspace/.dagger/runtime/evidence/<target>
```

`ARTIFACT_PATH` is intentionally absent. Deployment scripts should pass
`ARTIFACT_IMAGE_REFERENCE` directly to Cloud Run, Docker Swarm, Kubernetes, or
another target platform. Registry pull authentication remains a responsibility
of the target platform and its runtime identity; publishing credentials never
reach Deploy.

Before a live deploy executor starts, Rush Delivery rejects planned artifacts,
mutable references, source-revision mismatches, malformed evidence, and failed
verification. It also re-hashes the target-scoped local SBOM, scan, and
provenance files and rejects evidence changed after Package.

## Evidence And Failure Policy

The live Package operation uses these immutable tool images:

| Tool   | Version | Image                                                                                                    |
| ------ | ------- | -------------------------------------------------------------------------------------------------------- |
| Syft   | 1.50.0  | `anchore/syft@sha256:1288ea4c8b38767b4e620c1e312c8cb26b6e887a99b4f07ab6cd19fc6f225026`                   |
| Grype  | 0.116.1 | `anchore/grype@sha256:1e71065c0a4cff3e6bd3b8add525ffac4343eb4971694eb90a31cf6d4d3e85db`                  |
| Cosign | 3.1.2   | `ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849` |

Syft produces validated SPDX 2.3 JSON. Grype scans the same built container and
enforces the target's normalized `fail_on` policy before publication. After
publication, Rush Delivery creates digest-bound SLSA provenance, signs the
digest, attaches the SBOM and provenance as attestations, and verifies all
three with the configured public key. Sanitized local evidence is stored below
`.dagger/runtime/evidence/<target>/` and each document hash is recorded in the
manifest.

Registry publication is not transactional. A scan or earlier failure leaves
no published image. If signing, attestation, or verification fails after the
single publish call, the registry may retain an unreferenced digest or the
`sha-<full-git-sha>` navigation tag. Rush Delivery reports that possibility,
does not write a successful manifest, and does not start Deploy.

Configure registry retention for navigation tags and unreferenced manifests.
For rollback, redeploy a previously verified digest reference; do not rebuild
or resolve a mutable tag. Preserve its manifest evidence for the same retention
window as the deployable digest.

## Split Stage Workflows

When build, package, and deploy run separately, persist the packaged Dagger
directory. It carries `.dagger/runtime/package-manifest.json` and the evidence
files. The image itself stays in the registry and is addressed only by its
digest. Pass the same `gitSha`, source URL, deploy env, and selected application
image provider into the package entrypoint.

For exact field rules, see the
[`package-target`](../schemas/package-target.schema.json),
[`application-image-providers`](../schemas/application-image-providers.schema.json),
and [`package-manifest`](../schemas/package-manifest.schema.json) schemas.
