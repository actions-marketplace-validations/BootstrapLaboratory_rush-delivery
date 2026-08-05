# 8 - Environment-Selected Repository Profiles

This tutorial keeps one application-image provider definition unchanged while
staging and production select different public registry coordinates. Package
resolves the chosen coordinates once; Deploy consumes only the packaged digest
and never reconstructs a repository from the current environment.

Complete the [provider-off](02-provider-off-dry-run.md) and
[publication](04-publish-and-inspect.md) chapters first.

## 1. Define One Provider

Use exactly one registry field and one repository-prefix field. This example
selects both from the environment while keeping credential roles separate. The
repository keeps the same provider and coordinate-only env files under the
[deployment compatibility examples](../../../examples/deployment-environment-compatibility):

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/application-image-providers.schema.json
providers:
  release:
    kind: oci_registry
    registry_env: APP_IMAGE_REGISTRY
    repository_prefix_env: APP_IMAGE_REPOSITORY_PREFIX
    username_env: APP_IMAGE_USERNAME
    token_env: APP_IMAGE_TOKEN
    signing_key_env: APP_IMAGE_SIGNING_KEY
    signing_password_env: APP_IMAGE_SIGNING_PASSWORD
    verification_key_env: APP_IMAGE_VERIFICATION_KEY
```

`APP_IMAGE_REGISTRY` and `APP_IMAGE_REPOSITORY_PREFIX` are public routing
values. The five credential values remain protected Package capabilities. A
coordinate name cannot alias either coordinate role, any application/Rush
cache/toolchain/npm/source credential name, `GIT_SHA`, `DRY_RUN`, or the
framework-owned `ARTIFACT_` namespace.

Static/environment mixed definitions are also valid. For example, keep
`registry: ghcr.io` while using only `repository_prefix_env`.

## 2. Create Deployment Profiles

Use separate protected CI environment files. The sample coordinate values are
public; the placeholders are not usable credentials:

```dotenv title="staging.env"
APP_IMAGE_REGISTRY=ghcr.io
APP_IMAGE_REPOSITORY_PREFIX=example-inc/staging
APP_IMAGE_USERNAME=ci-staging
APP_IMAGE_TOKEN=replace-in-secret-store
APP_IMAGE_SIGNING_KEY=replace-in-secret-store
APP_IMAGE_SIGNING_PASSWORD=replace-in-secret-store
APP_IMAGE_VERIFICATION_KEY=replace-in-secret-store
```

```dotenv title="production.env"
APP_IMAGE_REGISTRY=ghcr.io
APP_IMAGE_REPOSITORY_PREFIX=example-inc/production
APP_IMAGE_USERNAME=ci-production
APP_IMAGE_TOKEN=replace-in-secret-store
APP_IMAGE_SIGNING_KEY=replace-in-secret-store
APP_IMAGE_SIGNING_PASSWORD=replace-in-secret-store
APP_IMAGE_VERIFICATION_KEY=replace-in-secret-store
```

Never commit real tokens, private keys, or passwords. Multiline key values in
Action env content use literal `\n` separators as described in the
[production guide](../../oci-application-images.md).

Registry values are authorities such as `ghcr.io` or `registry.example:5443`,
without scheme, userinfo, or path. Repository prefixes are normalized lowercase
OCI paths without tag, digest, whitespace, or traversal. Invalid dynamic values
produce an error naming the provider, role, and environment variable—not the
raw value.

## 3. Run Credential-Free Named Dry Runs

A named dry run resolves the selected public coordinates but reads none of the
five provider credential values. Make a coordinate-only file for planning:

```dotenv title="staging-plan.env"
APP_IMAGE_REGISTRY=ghcr.io
APP_IMAGE_REPOSITORY_PREFIX=example-inc/staging
```

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  call build-and-package-deploy-targets \
  --repo=. \
  --ci-plan-file=ci/oci-plan.json \
  --deploy-env-file=staging-plan.env \
  --git-sha="$(git rev-parse HEAD)" \
  --source-repository-url=https://github.com/example-inc/platform.git \
  --application-image-provider=release \
  --dry-run=true \
  --export=staging-plan
```

Inspect `.dagger/runtime/package-manifest.json`. The planned OCI artifact must
name `ghcr.io/example-inc/staging/<image-name>`, have status `planned`, and have
no published digest/reference.

Repeat with production coordinate values and confirm only the planned
repository changes. The source revision and package target remain unchanged.

Provider `off` dry runs do not read provider metadata or coordinates and emit
relative image intent. A selection with no OCI target reads no provider data at
all, even when a global provider input is present.

## 4. Understand Environment Ownership

The composed `workflow` merges `workflow-env` with the deploy overlay before
Package. A key present in both files is accepted only when its value is equal;
different duplicates fail instead of treating deploy values as overrides.

Standalone `package-deploy-targets` and
`build-and-package-deploy-targets` resolve coordinates only from
`deploy-env-file`. Release env, project Build projections, resolved Deploy
runtime env, and runtime-file bundles are not coordinate sources.

Coordinate values are never projected automatically into project Build or
Deploy code. Add a separate target-owned mapping only if project code has an
independent need for a public value.

## 5. Publish Staging

Load staging coordinates and credentials through the selected CI environment,
then run live Package:

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  call build-and-package-deploy-targets \
  --repo=. \
  --ci-plan-file=ci/oci-plan.json \
  --deploy-env-file=staging.env \
  --git-sha="$(git rev-parse HEAD)" \
  --source-repository-url=https://github.com/example-inc/platform.git \
  --application-image-provider=release \
  --dry-run=false \
  --export=staging-package
```

Verify the manifest, signature, provenance attestation, SBOM attestation, scan
evidence, and canonical digest exactly as in
[publish and inspect](04-publish-and-inspect.md). Every record must use the same
resolved staging repository.

## 6. Deploy The Packaged Digest

Pass the packaged workspace and its manifest to Deploy. Do not supply a new
provider or ask Deploy to read the production profile:

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  call deploy-release \
  --repo=staging-package \
  --git-sha="$(git rev-parse HEAD)" \
  --release-targets-json='["control-plane-api"]' \
  --environment=staging \
  --dry-run=false \
  --package-manifest-file=staging-package/.dagger/runtime/package-manifest.json
```

Deploy receives `ARTIFACT_IMAGE_REFERENCE` as the verified
`repository@sha256:...`. Promotion to production means running Package with the
production profile and verifying that new publication; it is not a mutable tag
rewrite during Deploy.

## 7. Production Gate

Before promotion, require:

- both named dry runs select the intended normalized repositories;
- dry runs succeed with credential values absent;
- environment protection separates staging and production credentials;
- the live subject and every signature/attestation/evidence record agree on one
  canonical repository and digest;
- Deploy consumes the packaged manifest and never reloads provider metadata;
- partial-publication cleanup is scoped to the resolved repository; and
- a rollback retains the original packaged manifest/evidence and deploys the
  verified digest, not a reconstructed tag.

For failures, use the
[application-image troubleshooting guide](../../oci-application-image-troubleshooting.md)
and [registry recipes](../../oci-registry-recipes.md).
