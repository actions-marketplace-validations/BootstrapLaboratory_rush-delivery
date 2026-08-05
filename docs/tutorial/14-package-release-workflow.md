# Package Release Workflow

Package release can run either as part of the main trusted `workflow` or as a
dedicated trusted workflow. Compose it into `workflow` when the same CI job
should deploy applications and release npm packages; keep it standalone for
package-only repositories, release debugging, or stricter operational
separation.

## Composed Workflow

Select package release explicitly:

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.9.0
  with:
    dry-run: "false"
    release-targets-json: '["npm"]'
    deploy-env: |
      GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}
    release-env: |
      NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

In this mode, Rush Delivery shares source acquisition, metadata validation,
Rush install cache, and the Rush lifecycle. When `npm` is selected, it runs the
all-project lifecycle once, then starts deploy and npm package release side
effects after the shared prerequisites pass. Deploy tags continue to point at
the original source SHA. The Rush package release branch pushes its generated
version commit to `versioning.target_branch`.

Deploy and package release side effects are concurrent but not transactional.
Rush Delivery waits for all started branches and reports every failure, but a
successful external side effect may already exist if another branch fails.

## Standalone Workflow

Run package release as a dedicated trusted workflow when it has a different
permission profile from PR validation and deploy release workflows.

LabKit uses `.github/workflows/package-release.yaml` with
`entrypoint: release-packages`:

```yaml
name: package-release

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: package-release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release-packages:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Run Rush Delivery package release
        uses: BootstrapLaboratory/rush-delivery@v0.9.0
        with:
          entrypoint: release-packages
          dry-run: "false"
          toolchain-image-provider: off
          rush-cache-provider: off
          release-env: |
            NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

`contents: write` is required because Rush publishes a generated version commit
back to `versioning.target_branch`. The action appends `GITHUB_TOKEN` to the
generated release env file by default, so the release entrypoint can use the
same token for Git source acquisition and the final push.

`packages: write` is not required for npmjs publishing by itself. Add package
registry permissions only when Rush Delivery provider adapters use GHCR-backed
toolchain images or Rush install cache.

## What The Entrypoint Does

The live release path is:

1. Acquire source through Git source mode.
2. Validate Rush and `.dagger/release/npm.yaml` metadata.
3. Restore or prepare Rush install state.
4. Run Rush `build`, `lint`, `test`, and `verify`.
5. Configure npm token auth from release env.
6. Configure process-only Git push auth from source auth. The token stays in a
   Dagger secret environment and a static askpass helper reads it only when Git
   prompts; no token or derived Basic header is written to `.git/config`.
7. Prepare the local target branch.
8. Run `rush publish --apply --target-branch <branch> --publish`.

The final Rush step applies change files, updates package versions and
changelogs, publishes packages, commits the version changes, and pushes that
commit back to the target branch.

## PR Validation

When `.dagger/release/npm.yaml` exists, Rush Delivery PR validation includes
release-readiness verification:

```yaml
permissions:
  contents: read
  packages: read

steps:
  - uses: BootstrapLaboratory/rush-delivery@v0.9.0
    with:
      entrypoint: validate
      toolchain-image-provider: github
      rush-cache-provider: github
```

The validation entrypoint uses read-only provider policies by default. It can
reuse existing provider artifacts, but it does not publish new images or Rush
cache from PRs. Package release credentials are not passed to PR validation.

## Local Dry-Run

Use local-copy source mode to test metadata and release behavior before pushing:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.0 \
  --repo=. -- release-packages \
  --git-sha="$(git rev-parse HEAD)" \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off
```

The dry-run path reads release metadata and runs the release lifecycle, but it
does not require `NPM_TOKEN`, does not publish packages, and does not push a
version commit.

## Checklist

- Package release workflow runs only from trusted events.
- Live release job has `contents: write`.
- `NPM_TOKEN` is stored as a secret.
- `release-env` contains npm credentials.
- Provider settings match the repository metadata.
- PR validation verifies Rush change files before merge.
- Local dry-run succeeds before the first live release.

From here, use [Metadata](../metadata.md), [GitHub Action Usage](../github-actions.md),
and [Entrypoints](../entrypoints.md) when you need exact field and API details.
