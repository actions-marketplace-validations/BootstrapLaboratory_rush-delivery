---
title: "GitHub Actions"
sidebar_label: "GitHub Actions"
---

The example repository uses GitHub Actions as a thin Rush Delivery adapter. The
workflows do not calculate deploy plans or run Rush directly. They provide
permissions, credentials, env, runtime files, and action inputs.

## Pull Request Validation

The PR workflow uses the `validate` entrypoint:

```yaml
permissions:
  contents: read
  packages: read

steps:
  - uses: BootstrapLaboratory/rush-delivery@v0.8.1
    with:
      entrypoint: validate
      toolchain-image-provider: github
      rush-cache-provider: github
```

No checkout step is needed for normal PR validation. The action passes Git
source coordinates to Dagger, and Rush Delivery acquires the source inside the
Dagger workflow.

`packages: read` is enough because the validate defaults use `pull-or-build`,
which never publishes provider artifacts.

If a package target needs build-time env, pass the source values through
`deploy-env` in PR validation too. The metadata allowlist still decides which
values reach the build container.

If `.dagger/release/npm.yaml` exists, PR validation also verifies Rush change
files before the PR reaches `main`.

## Main Release Workflow

The main workflow runs on pushes to `main` and can also be called by manual
force-deploy workflows.

The job needs stronger permissions:

```yaml
permissions:
  contents: write
  id-token: write
  packages: write
```

The example authenticates to Google Cloud before calling Rush Delivery, then
passes the generated credentials file as a runtime file:

```yaml
runtime-file-map: |
  ${{ steps.auth.outputs.credentials_file_path }}=>gcp-credentials.json
```

The deploy env block passes the filesystem targets' product settings and
deploy-platform secrets:

```yaml
deploy-env: |
  GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}
  CLOUDFLARE_API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}
```

This tutorial's directory/archive targets omit `application-image-provider` and
keep its default `off`; they need no `.dagger/application-images` metadata or
OCI credentials. For an OCI release, switch to the dedicated
[OCI application images tutorial](../oci-application-images), which adds
the package target and provider metadata before selecting the named provider.
Set `docker-socket: ""` in an OCI-only Action job. The
[production guide](../../oci-application-images),
[registry recipes](../../oci-registry-recipes), and
[troubleshooting guide](../../oci-application-image-troubleshooting) cover the
live operational path.

Rush Delivery reads the deploy env file once, then only passes variables that
package and deploy target metadata allow through `pass_env` or `map_env`.

## Forced Deploy Workflows

The example has small manual workflows for single-target deploys. They reuse
the main workflow and pass `force_targets_json`:

```yaml
with:
  force_targets_json: '["server"]'
```

This keeps the deployment path identical. Manual deploys still use the same
metadata, provider settings, runtime files, package logic, and deploy mesh.

## Package Release Workflow

Package release/versioning can be composed into the main trusted workflow when
the same job should deploy applications and release npm packages:

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.8.1
  with:
    dry-run: "false"
    release-targets-json: '["npm"]'
    deploy-env: |
      GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}
    release-env: |
      NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

Rush Delivery shares source acquisition, Rush install cache, and the build
lifecycle, then starts deploy and npm package release side effects after shared
prerequisites pass. Deploy tags still point to the original source SHA.

For package-only repositories or release debugging, keep a separate standalone
workflow. It uses its own release env and does not touch deploy tags:

```yaml
permissions:
  contents: read

jobs:
  release-packages:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: BootstrapLaboratory/rush-delivery@v0.8.1
        with:
          entrypoint: release-packages
          dry-run: "false"
          toolchain-image-provider: off
          rush-cache-provider: off
          release-env: |
            NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

Rush Delivery appends `GITHUB_TOKEN` by default, so the release entrypoint can
push the Rush-generated version commit back to the target branch.

Add `packages` permissions only when provider-backed Rush cache or toolchain
images use GitHub Container Registry.

## Version Pinning

Pin Rush Delivery to a released tag:

```yaml
uses: BootstrapLaboratory/rush-delivery@v0.8.1
```

Advance the tag intentionally when you want new behavior. Do not use an
unversioned branch in production CI.

## Checklist

- PR workflow uses `contents: read` and `packages: read`.
- PR workflow uses validate defaults or explicit `pull-or-build` policies.
- Release workflow uses `packages: write`.
- Package release workflow uses `contents: write`.
- Package release workflow uses `release-env` for npm credentials.
- Runtime files carry credential files.
- Deploy env carries settings and secrets.
- Filesystem-only releases omit the application-image provider or keep it
  `off`; OCI releases follow the dedicated tutorial and clear the legacy
  `docker-socket` input.
- Manual force deploy workflows reuse the main workflow.

Next: [Local Dry Runs](../local-dry-runs).
