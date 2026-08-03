---
id: "api"
title: "Public API"
sidebar_label: "Public API"
---

When consuming this module from CI, prefer Git source mode so Dagger clones the
Rush repository internally. Use `--repo=.` only for local-copy runs against a
checked-out working tree.

```sh
RUSH_DELIVERY_MODULE=github.com/OWNER/rush-delivery@VERSION
```

GitHub Actions can use the root action wrapper instead of assembling the raw
command. See [GitHub Action usage](../github-action).

## Entrypoints

`workflow` is the normal release orchestrator. It resolves source, validates
metadata, computes the CI plan, builds selected deploy targets, packages their
artifacts, deploys them in dependency order, and can compose selected package
release targets.

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

`self-check` is the framework health check. It runs the Dagger module
typecheck and unit tests from this repository.

```sh
dagger call self-check
```

`validate` runs pull-request validation for affected Rush projects,
target-specific validation metadata, and release-readiness checks when
`.dagger/release/npm.yaml` is configured.

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

For local validation against unpushed changes, use `--repo=.` with
`--source-mode=local_copy`.

`releasePackages` runs the package release/versioning flow from
`.dagger/release/npm.yaml`. The first supported strategy is Rush change-file
publishing for npm packages.

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

Live package releases require Git source mode with write credentials. Rush
Delivery runs the shared Rush lifecycle in build-first order (`build`, `lint`,
`test`, `verify`), lets Rush apply the change files, publishes packages, and
pushes the version commit back to the configured target branch. Dry-runs run the
same planning path without pushing commits, tags, or packages.

`releasePackages` uses a release-scoped metadata contract. It requires Rush
project metadata and `.dagger/release/npm.yaml`, but it does not require deploy
metadata. Rush cache provider metadata is only required when the selected Rush
cache provider is not `off`.

The release env file must contain the npm token named by
`.dagger/release/npm.yaml` and the Git token named by `sourceAuthTokenEnv` for
live Git source releases.

See [Entrypoints reference](../entrypoints) for every callable function,
including separate `detect`, `build`, `package`, `deploy`, metadata validation,
and diagnostic entrypoints.

## Key Inputs

`repo` is the caller's Rush repository directory for `sourceMode=local_copy`.
Git source mode does not require it.

`gitSha` is the commit being validated or released. It is required for Git
source mode.

`eventName`, `forceTargetsJson`, `prBaseSha`, and `deployTagPrefix` shape
detection. Forced targets are used by manual deploy wrappers.

`deployEnvFile` is a newline-delimited environment file for workflow, validate,
build, and deploy paths. The framework reads it once, then passes only package-
or deploy-target-allowed variables to build and runtime containers.

`workflowEnvFile` is a newline-delimited environment file shared by the
composed `workflow`. Use it for source/provider values that may be needed
before a stage-specific overlay is selected. `deployEnvFile` and
`releaseEnvFile` may repeat a workflow env key only with the same value.

`releaseEnvFile` is a newline-delimited environment file for package release.
It carries package release credentials such as `NPM_TOKEN`. In the composed
`workflow`, release metadata decides which values reach the package release
container. In standalone `releasePackages`, the same file also carries source
write credentials such as `GITHUB_TOKEN`.

`releaseTargetsJson` selects package release targets for `workflow`.
Currently `["npm"]` is supported. The default `[]` keeps deploy-only workflow
behavior unchanged.

`runtimeFiles` is an optional directory of deploy-only files such as cloud
credentials, kubeconfig files, or signing material. Deploy target metadata can
mount files from this bundle without making them part of source, package
artifacts, Rush install cache, or toolchain image hashes.

`sourceMode` is `git` or `local_copy`. Git mode is the recommended CI path and
uses provider-neutral source coordinates. Local-copy mode needs `repo` and is
intended for local tests, offline runs, and unpushed changes.

`toolchainImageProvider` and `rushCacheProvider` are `off` by default. Provider
`github` enables GHCR-backed toolchain images or Rush install cache.

For `workflow`, `toolchainImagePolicy` and `rushCachePolicy` default to `lazy`,
which is the trusted release behavior: pull first, build or install on miss, and
publish refreshed provider artifacts after success. For `validate`, both
policies default to `pull-or-build`, which pulls existing artifacts and builds
or installs locally on miss without publishing.

`dockerSocket` is optional. Live Cloud Run image builds need it; dry-runs and
non-Docker targets do not.

## Defaults

Local defaults favor portability: provider-off, dry-run enabled, and
`local_copy` source mode. CI should opt into provider adapters explicitly.
