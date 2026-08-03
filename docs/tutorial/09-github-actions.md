# GitHub Actions

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
  - uses: BootstrapLaboratory/rush-delivery@v0.8.0
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

The deploy env block passes product settings and provider secrets:

```yaml
deploy-env: |
  OCI_USERNAME=${{ secrets.OCI_USERNAME }}
  OCI_TOKEN=${{ secrets.OCI_TOKEN }}
  OCI_SIGNING_KEY=${{ secrets.OCI_SIGNING_KEY }}
  OCI_SIGNING_PASSWORD=${{ secrets.OCI_SIGNING_PASSWORD }}
  OCI_SIGNING_PUBLIC_KEY=${{ vars.OCI_SIGNING_PUBLIC_KEY }}
  GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}
  CLOUDFLARE_API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}
```

When the selected package target is an OCI image, also select the provider:

```yaml
with:
  application-image-provider: release
```

Existing directory/archive targets leave it `off`. Rush Delivery uses the OCI
credentials only during Package and gives Deploy the verified digest, not the
credentials.

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
- uses: BootstrapLaboratory/rush-delivery@v0.8.0
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
      - uses: BootstrapLaboratory/rush-delivery@v0.8.0
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
uses: BootstrapLaboratory/rush-delivery@v0.8.0
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
- OCI releases select an application-image provider; filesystem-only releases
  keep it `off`.
- Manual force deploy workflows reuse the main workflow.

Next: [Local Dry Runs](10-local-dry-runs.md).
