---
id: "entrypoints"
title: "Entrypoints"
sidebar_label: "Entrypoints"
---

When consuming this module from CI, prefer Git source mode so Dagger clones the
Rush repository internally:

```sh
RUSH_DELIVERY_MODULE=github.com/OWNER/rush-delivery@VERSION
```

## `workflow`

The main release composition. It resolves source, validates metadata, detects
deploy targets, selects explicit package release targets, builds, packages, and
then runs deploy and package-release side effects.

Use it for normal CI release runs and local release dry-runs.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call workflow \
  --git-sha="$GIT_SHA" \
  --event-name=push \
  --dry-run=false \
  --workflow-env-file="$WORKFLOW_ENV_FILE" \
  --deploy-env-file="$DEPLOY_ENV_FILE" \
  --release-targets-json='["npm"]' \
  --release-env-file="$RELEASE_ENV_FILE" \
  --runtime-files="$RUNTIME_FILES_DIR" \
  --source-mode=git \
  --source-repository-url="$SOURCE_REPOSITORY_URL" \
  --source-ref="$SOURCE_REF" \
  --source-auth-token-env=GITHUB_TOKEN
```

When `release-targets-json` is empty, returns the existing text deployment
summary. When package release targets are selected, returns a combined summary
with `deploy` and `release_packages` sections.

Deploy and package release side effects run after shared prerequisites. They
can run concurrently and are not transactional across external systems.

For local runs against a checked-out working tree, use `--repo=.` with
`--source-mode=local_copy`.

## `validate`

Runs Dagger-owned validation for affected Rush projects. It can also run
target-specific validation metadata such as backing services, migrations, server
startup, and smoke tests.

Use it for pull-request validation paths or local validation experiments.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call validate \
  --git-sha="$GIT_SHA" \
  --event-name=pull_request \
  --pr-base-sha="$PR_BASE_SHA" \
  --deploy-env-file="$DEPLOY_ENV_FILE" \
  --toolchain-image-provider=github \
  --rush-cache-provider=github \
  --source-mode=git \
  --source-repository-url="$SOURCE_REPOSITORY_URL" \
  --source-ref="$SOURCE_REF" \
  --source-auth-token-env=GITHUB_TOKEN
```

Returns a validation summary.

For local runs against a checked-out working tree, use `--repo=.` with
`--source-mode=local_copy`.

## `release-packages`

Runs package release/versioning from `.dagger/release/npm.yaml`. The initial
strategy is npm publishing through Rush change files.

Use it for standalone package release workflows, package-only repositories, and
release debugging. The entrypoint runs the shared Rush lifecycle in build-first
order (`build`, `lint`, `test`, `verify`), lets Rush apply change files,
publishes packages, and pushes the generated version commit. For live releases,
Rush Delivery prepares the metadata target branch locally before `rush publish`
so Rush can check it out for the final merge. It does not touch deploy tags.

NPM provenance defaults to `false`; opt in from `.dagger/release/npm.yaml` only
when the release runtime is wired for supported npm provenance detection.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call release-packages \
  --git-sha="$GIT_SHA" \
  --dry-run=false \
  --release-env-file="$RELEASE_ENV_FILE" \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --source-mode=git \
  --source-repository-url="$SOURCE_REPOSITORY_URL" \
  --source-ref="$SOURCE_REF" \
  --source-auth-token-env=GITHUB_TOKEN
```

Use `toolchain-image-provider=github` or `rush-cache-provider=github` only when
the repository has matching provider metadata and the CI job has package
registry permissions.

For local dry-runs against a checked-out working tree, use `--repo=.` with
`--source-mode=local_copy` and keep `--dry-run=true`.

## `detect`

Computes the canonical CI plan JSON. The plan includes mode, validation targets,
deploy targets, and affected projects by deploy target.

Use it when a CI provider intentionally runs split stages. The `workflow`
entrypoint already calls it internally.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call detect \
  --repo=. \
  --event-name=push \
  --force-targets-json='[]' \
  --deploy-tag-prefix=deploy/prod
```

Returns JSON intended for Dagger stage handoff.

## `build-deploy-targets`

Runs the generic Rush build stage for deploy targets selected by a CI plan file.

Use it only in split-stage workflows where build is separated from package and
deploy.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call build-deploy-targets \
  --repo=. \
  --ci-plan-file="$CI_PLAN_FILE" \
  --deploy-env-file="$DEPLOY_ENV_FILE"
```

Returns a Dagger directory containing the built workspace. `deploy-env-file` is
optional, but required when selected package targets declare build-time
`pass_env` or `map_env` values without dry-run defaults. Pass `--dry-run=true`
when you want build-time env to use package target `dry_run_defaults`.

## `package-deploy-targets`

Materializes deploy artifacts for targets selected by a CI plan file. Package
behavior is driven by `.dagger/package/targets`.

Use it only in split-stage workflows after build outputs already exist.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call package-deploy-targets \
  --repo=. \
  --ci-plan-file="$CI_PLAN_FILE" \
  --artifact-prefix=deploy-target
```

Returns a Dagger directory containing packaged artifacts and a package manifest.
It accepts the same build-time `deploy-env-file` and `dry-run` inputs as
`build-deploy-targets`.

## `build-and-package-deploy-targets`

Runs build and package as separate logical stages, then exports the final
packaged workspace once.

Use it when a split workflow needs build and package together but deploy later.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call build-and-package-deploy-targets \
  --repo=. \
  --ci-plan-file="$CI_PLAN_FILE" \
  --artifact-prefix=deploy-target \
  --deploy-env-file="$DEPLOY_ENV_FILE"
```

Returns a Dagger directory containing packaged artifacts and a package manifest.

## `deploy-release`

Deploys selected targets from an already packaged workspace. It executes deploy
targets in service-mesh wave order and can use a package manifest to resolve
artifact paths.

Use it for split-stage workflows, deploy-only retries, or tests around deploy
metadata.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call deploy-release \
  --repo=. \
  --git-sha="$GIT_SHA" \
  --release-targets-json='["server","webapp"]' \
  --environment=prod \
  --dry-run=false \
  --deploy-env-file="$DEPLOY_ENV_FILE" \
  --runtime-files="$RUNTIME_FILES_DIR" \
  --package-manifest-file="$PACKAGE_MANIFEST_FILE"
```

Returns a text deployment summary.

## `self-check`

Runs the framework health check: Dagger module typecheck and unit tests.

Use it before changing framework source, schemas, or docs.

```sh
dagger call self-check
```

Returns a self-check summary.

## `validate-metadata-contract`

Checks cross-file metadata consistency without running release stages.

Use it when editing `.dagger/` metadata and wanting a fast contract check.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call validate-metadata-contract --repo=.
```

Returns formatted metadata contract JSON.

## `describe-release-targets`

Validates and normalizes a release target JSON array.

Use it for quick checks around manual target input.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call describe-release-targets \
  --release-targets-json='["server"]'
```

Returns a short text description.

## `ping`

Returns a simple readiness marker.

Use it only to verify that the module is callable.

```sh
dagger -m "$RUSH_DELIVERY_MODULE" call ping
```
