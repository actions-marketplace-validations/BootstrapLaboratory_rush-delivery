# GitHub Actions

Rush Delivery is a Dagger module for Rush-based release workflows. It owns the
release path from source acquisition through detect, validate, build, package,
and deploy while keeping project-specific behavior in metadata.

Use the GitHub Action for normal GitHub CI. It prepares the Dagger CLI, deploy
env file, runtime files bundle, Git source coordinates, and source auth token
plumbing for you.

Pin Rush Delivery to a released tag and advance that tag intentionally when you
want new behavior.

## Pull Request Validation

Use `entrypoint: validate` for PR CI. The action resolves the pull request
source through Git source mode, so the workflow does not need to check out the
repository for normal validation. Give PRs read-only package access and use
the validate defaults so provider artifacts can be reused without publishing
from PR runs.

```yaml
name: ci-validate

on:
  pull_request:

permissions:
  contents: read
  packages: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: BootstrapLaboratory/rush-delivery@v0.8.0
        with:
          entrypoint: validate
          toolchain-image-provider: github
          rush-cache-provider: github
```

If package target build metadata allows env through `pass_env` or `map_env`,
add those source values to `deploy-env` in the validation step as well.

If `.dagger/release/npm.yaml` exists, the same validation step also verifies
Rush change files so package releases cannot reach `main` without versioning
metadata.

## Release Workflow

Use the default `workflow` entrypoint for release CI.

```yaml
permissions:
  contents: write
  id-token: write
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - id: auth
        name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

      - name: Rush Delivery
        uses: BootstrapLaboratory/rush-delivery@v0.8.0
        with:
          dry-run: "false"
          force-targets-json: ${{ inputs.force_targets_json || '[]' }}
          environment: prod
          deploy-tag-prefix: deploy/prod
          artifact-prefix: deploy-target
          toolchain-image-provider: github
          toolchain-image-policy: lazy
          rush-cache-provider: github
          rush-cache-policy: lazy
          application-image-provider: release
          release-targets-json: '["npm"]'
          release-env: |
            NPM_TOKEN=${{ secrets.NPM_TOKEN }}
          deploy-env: |
            OCI_USERNAME=${{ secrets.OCI_USERNAME }}
            OCI_TOKEN=${{ secrets.OCI_TOKEN }}
            OCI_SIGNING_KEY=${{ secrets.OCI_SIGNING_KEY }}
            OCI_SIGNING_PASSWORD=${{ secrets.OCI_SIGNING_PASSWORD }}
            OCI_SIGNING_PUBLIC_KEY=${{ vars.OCI_SIGNING_PUBLIC_KEY }}
            GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}
            GCP_ARTIFACT_REGISTRY_REPOSITORY=${{ vars.GCP_ARTIFACT_REGISTRY_REPOSITORY }}
          runtime-file-map: |
            ${{ steps.auth.outputs.credentials_file_path }}=>gcp-credentials.json
```

Next, see [CI Using Command Line](ci-cli.md) if you want to call the module
directly from a custom CI script.

The `application-image-provider` line is needed only when a selected package
target uses `artifact.kind: oci_image`. Existing directory/archive projects can
omit it and keep the default `off`. OCI image builds use Dagger directly and do
not require the action's Docker socket input. See
[OCI application images](../oci-application-images.md) for provider metadata,
Cosign credentials, and digest-only deploy behavior.

## Package Release

Use `release-targets-json: '["npm"]'` in the main workflow when package release
should share the same source acquisition, Rush install cache, and build
lifecycle as deploy. Deploy tags stay on the original source SHA; Rush package
release pushes its generated version commit to the configured target branch.

Use `entrypoint: release-packages` when npm package release/versioning should
stay standalone. Keep npm credentials in `release-env`; deploy credentials stay
in `deploy-env`.

NPM provenance is disabled by default; opt in from `.dagger/release/npm.yaml`
only when the Dagger release runtime is configured for supported npm provenance.

This is the minimal package-only shape. It publishes to npmjs through Rush and
does not use GHCR-backed provider artifacts:

```yaml
permissions:
  contents: read

jobs:
  release-packages:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: BootstrapLaboratory/rush-delivery@v0.8.0
        with:
          entrypoint: release-packages
          dry-run: "false"
          toolchain-image-provider: off
          rush-cache-provider: off
          release-env: |
            NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

Use provider `github` and add `packages` permissions only when the repository
has Rush Delivery provider metadata for toolchain images or Rush install cache.

Rush Delivery expects normal Rush release inputs in the repository:
`.dagger/release/npm.yaml`, `common/config/rush/.npmrc-publish`, Rush change
files, package `publishConfig`, and any Rush version policies referenced from
`rush.json`.

For the broader docs map, start from the [Introduction](../README.md).
