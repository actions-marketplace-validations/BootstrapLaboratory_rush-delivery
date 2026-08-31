# Workflow Guide

## Local Framework Check

Use `self-check` before changing metadata, schemas, or Dagger source:

```sh
dagger call self-check
```

## Local Provider-Off Dry Run

This exercises the full release composition without GHCR, cloud credentials, or
a Docker socket against local unpushed changes:

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.1 \
  --repo=. \
  -- \
  workflow \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=workflow_call \
  --force-targets-json='["server","webapp"]' \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --application-image-provider=off
```

Dry-runs use package and deploy target `dry_run_defaults` for allowed build and
runtime environment values.
The checksummed launcher applies bounded source exclusions before transfer; see
[bounded local-copy imports](local-copy-source-imports.md).

## CI Release Workflow

A CI provider should keep provider-specific setup small, then call the Dagger
workflow.

For GitHub Actions, prefer the repository action wrapper:

```yaml
- name: Rush Delivery
  uses: BootstrapLaboratory/rush-delivery@v0.9.1
  with:
    force-targets-json: ${{ inputs.force_targets_json || '[]' }}
    environment: prod
    dry-run: "false"
    release-targets-json: '["npm"]'
    runtime-file-map: |
      ${{ steps.auth.outputs.credentials_file_path }}=>gcp-credentials.json
    deploy-env: |
      GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}
    release-env: |
      NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

See [GitHub Action usage](github-actions.md) for the complete production shape.

For pull-request validation, use the same action with the `validate`
entrypoint. The action defaults provider policies to `pull-or-build` for
validation. If npm release metadata is configured, validation also verifies Rush
change files:

```yaml
- name: Rush Delivery validation
  uses: BootstrapLaboratory/rush-delivery@v0.9.1
  with:
    entrypoint: validate
    toolchain-image-provider: github
    rush-cache-provider: github
```

For npm package release, prefer composing it into `workflow` with explicit
`release-targets-json: '["npm"]'` when the same trusted CI job should deploy
applications and release packages. Rush Delivery shares source acquisition,
metadata validation, Rush install cache, and the build lifecycle, then starts
deploy and package release side effects after the shared prerequisites pass.

The standalone `release-packages` entrypoint remains useful for package-only
projects and release debugging. A package-only project can keep provider
adapters off:

```yaml
- name: Rush Delivery package release
  uses: BootstrapLaboratory/rush-delivery@v0.9.1
  with:
    entrypoint: release-packages
    dry-run: "false"
    toolchain-image-provider: off
    rush-cache-provider: off
    release-env: |
      NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

The action appends `GITHUB_TOKEN` to the release env file by default, so live
package release can push the Rush-generated version commit back to the target
branch. The workflow job needs `contents: write`; it needs `packages: read` or
`packages: write` only when using GHCR-backed Rush cache or toolchain images.
Rush Delivery also prepares the release target branch locally before `rush
publish`, because Rush checks out that branch for the final version-commit
merge.

Composed package release does not change deploy tag identity. Deploy tags
continue to point at the original source SHA. Rush package release creates and
pushes its own version commit to the metadata `target_branch`.

Deploy and package release side effects are concurrent but not transactional.
Rush Delivery waits for both started branches and reports every failure, but a
successful external side effect may already exist if the other branch fails.

NPM provenance defaults to `false` in `.dagger/release/npm.yaml`. Opt in only
when npm can detect a supported provenance provider from inside the Dagger
release runtime.

For a raw Dagger command this means:

- Install the Dagger CLI.
- Authenticate to external providers when live deploy targets need it.
- Write a deploy environment file with build-time values and deploy-platform
  configuration or credentials.
- Write a workflow environment file for shared source/provider values.
- Write a release environment file when package release needs registry
  credentials.
- Copy deploy-platform credential files into a runtime files directory when
  targets mount files. Do not put OCI registry tokens or Cosign material in
  that directory.
- Call `dagger -m "$RUSH_DELIVERY_MODULE" call workflow`.

The CI provider should pass source coordinates rather than doing release logic
itself. Dagger owns source acquisition, deploy tag fetching, detection, build,
package, deployment, and deploy tag updates.

## Recommended CI Shape

```sh
mkdir -p "$RUNNER_TEMP/rush-delivery-runtime-files"
cp "$GCP_CREDENTIALS_FILE" \
  "$RUNNER_TEMP/rush-delivery-runtime-files/gcp-credentials.json"

dagger -m "$RUSH_DELIVERY_MODULE" call workflow \
  --git-sha="$GITHUB_SHA" \
  --event-name="$GITHUB_EVENT_NAME" \
  --force-targets-json="$FORCE_TARGETS_JSON" \
  --pr-base-sha="$PR_BASE_SHA" \
  --deploy-tag-prefix="$DEPLOY_TAG_PREFIX" \
  --artifact-prefix="$DEPLOY_ARTIFACT_PREFIX" \
  --environment=prod \
  --dry-run=false \
  --workflow-env-file="$WORKFLOW_ENV_FILE" \
  --deploy-env-file="$DEPLOY_ENV_FILE" \
  --release-targets-json="$RELEASE_TARGETS_JSON" \
  --release-env-file="$RELEASE_ENV_FILE" \
  --host-workspace-dir="$GITHUB_WORKSPACE" \
  --toolchain-image-provider="$TOOLCHAIN_IMAGE_PROVIDER" \
  --toolchain-image-policy="$TOOLCHAIN_IMAGE_POLICY" \
  --rush-cache-provider="$RUSH_CACHE_PROVIDER" \
  --rush-cache-policy="$RUSH_CACHE_POLICY" \
  --application-image-provider=off \
  --source-mode=git \
  --source-repository-url="$SOURCE_REPOSITORY_URL" \
  --source-ref="$SOURCE_REF" \
  --source-auth-token-env=GITHUB_TOKEN \
  --runtime-files="$RUNNER_TEMP/rush-delivery-runtime-files"
```

First-class OCI targets do not need a Docker socket. Add `--docker-socket` only
when an existing project-owned deploy script still invokes Docker directly.

This is a filesystem-first baseline. It neither selects an application-image
provider nor needs OCI registry or Cosign credentials.

## OCI Package And Deploy Boundary

With a named application-image provider, each selected `oci_image` target is
built from the prepared workspace, scanned before publication, published once,
signed and attested, and written to the package manifest only after
verification. Deploy scripts receive the immutable digest reference and the
target-scoped evidence directory; registry and signing credentials do not cross
the Package boundary. When no selected package target is OCI, the provider
input, provider metadata file, and provider credentials are ignored.

Provider `off` remains the default and needs no metadata for filesystem-only
projects. OCI dry runs are also valid with provider `off`: they report relative
image/platform intent without resolving credentials or producing a fake digest.
Named providers may choose registry authority and repository prefix from public
workflow/deploy environment values. Package resolves the coordinates once;
Deploy still consumes only the manifest digest. Follow the
[environment-profile tutorial](tutorial/oci-application-images/08-environment-profiles.md).

Publication is not transactional. A signing or verification failure after
publish can leave an orphaned registry digest or navigation tag, but Rush
Delivery stops before writing a successful manifest or starting Deploy. Begin
with the
[OCI application images tutorial](tutorial/oci-application-images/README.md),
then consult the [production guide](oci-application-images.md),
[registry recipes](oci-registry-recipes.md), and
[troubleshooting guide](oci-application-image-troubleshooting.md) for live
release, retention, rollback, and incident handling.

## Project-Owned Rush Tools

Optional `.dagger/toolchains/rush.yaml` extends the common Rush container before
Rush install, detection, build, validation, Rush-requiring Package, and package
Release. The metadata is part of the content-addressed toolchain provider key.
Absence preserves the v0.8.1 Node-only graph. See the
[toolchain guide](rush-toolchain.md) for the security/update contract and the
[mixed Node/Python tutorial](tutorial/15-mixed-node-python-toolchain.md) for a
complete provider-off and cached run.

## Split Stage Workflows

The stage-level APIs exist for CI systems that need separate jobs. Prefer the
single `workflow` entrypoint unless there is a provider-specific reason to split
handoff between detect, build, package, and deploy.

When splitting stages, persist the CI plan and package manifest as files rather
than re-encoding stage state in CI-specific outputs.
