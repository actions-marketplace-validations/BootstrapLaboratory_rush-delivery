# Provider Adapters

Rush Delivery keeps provider behavior behind explicit adapters. Local use works
with providers off; CI can opt into adapters by passing provider names and
credentials.

## Source Providers

`sourceMode=local_copy` copies the caller-provided `repo` directory into a
Dagger-owned workspace. Use it for local development, offline runs, and
unpushed changes. It requires `--repo`.

`sourceMode=git` clones or fetches the source from provider-neutral coordinates.
This is the recommended CI path and does not require `--repo`:

- `sourceRepositoryUrl`
- `sourceRef`
- `gitSha`
- `prBaseSha` when validating pull requests
- `sourceAuthTokenEnv` when private source access is required

The token value is read from the deploy environment file, not printed in logs.

## Toolchain Image Providers

`toolchainImageProvider=off` builds toolchain containers inside the current
Dagger run.

`toolchainImageProvider=github` uses GitHub Container Registry as an OCI image
store for content-addressed toolchain images. Image references are derived from
normalized runtime specs and provider metadata.

Policies:

- `toolchainImagePolicy=lazy` keeps trusted workflow behavior unchanged: pull an
  existing image, or build and publish a missing one.
- `toolchainImagePolicy=pull-or-build` pulls an existing image, or builds it
  locally on miss without publishing. Use this for pull-request validation.

## Rush Cache Providers

`rushCacheProvider=off` keeps Rush install behavior local to the current Dagger
engine.

`rushCacheProvider=github` stores a compressed Rush install cache archive in a
GHCR image. The cache reference is a stable project snapshot identified by the
`cache.version` value in `.dagger/rush-cache/providers.yaml`. Rush Delivery
restores that snapshot before `rush install`, lets Rush reconcile the
dependencies, and can publish the refreshed snapshot after the install
succeeds.

Policies:

- `rushCachePolicy=lazy` is for trusted workflows: restore the existing cache
  when available, run Rush install, then publish the post-install cache.
- `rushCachePolicy=pull-or-build` is for pull-request validation: restore the
  existing cache when available and run Rush install, but never publish a cache
  from the PR run.

## Application Image Providers

`applicationImageProvider=off` preserves filesystem-only workflows and supports
credential-free OCI dry runs. A live selected OCI package target must name an
`oci_registry` provider from `.dagger/application-images/providers.yaml`.

The adapter is registry-neutral. Metadata supplies a registry authority,
repository prefix, and the names of environment variables containing registry
and key-backed Cosign credentials. Selected values come from `workflow-env`
plus `deploy-env` and are converted to Dagger secrets before Package starts.
Provider metadata and dry-run output never contain credential values.

Application images are distinct from toolchain images and Rush cache images.
They use package-target image names, are published once per target under a
source navigation tag, and are recorded and deployed only as verified digest
references. See [OCI application images](oci-application-images.md).

## Deploy Providers

Deploy providers are target-level concerns. A target runtime decides what
environment variables, file mounts, static env values, workspace paths, and
tooling it needs through deploy target metadata.

The framework only passes allowlisted data into each target runtime.

Deploy-only files should be passed through `runtimeFiles` and mounted from
target metadata. This keeps credentials out of source acquisition, Rush cache,
package artifacts, toolchain image hashes, logs, and generated manifests.

## CI Provider Responsibilities

A CI provider should provide:

- Dagger CLI availability.
- Source coordinates for Git source mode.
- A workflow environment file with shared source/provider values.
- A deploy environment file with deploy credentials and project settings.
- A release environment file with npm credentials when running package release
  through `workflow` or `release-packages`.
- A runtime files directory for deploy-only credential or config files when
  targets need file mounts.
- Optional Docker socket only for a project-owned legacy deploy target that
  explicitly needs it. First-class OCI package artifacts build and publish
  through Dagger and do not use a host Docker daemon or socket.
- Permissions for any selected provider adapters.

For GitHub PR validation, `packages: read` is enough when both provider
policies are `pull-or-build`. Trusted release workflows that use `lazy` need
`packages: write` so refreshed artifacts can be published.

Application image registry permissions are provider-specific. A live OCI
release needs push access for the selected registry identity. Pull access at
deployment belongs to the target platform identity, not the Rush Delivery
deploy script.

The CI provider should not compute deploy plans, package artifacts, update
deploy tags, apply package versions, publish npm packages directly, or encode
target-specific behavior. Rush Delivery calls Rush for versioning and package
publishing when the `npm` release target is selected or when the standalone
`release-packages` entrypoint is called.

The GitHub Action wrapper in this repository is the first CI adapter. It
prepares GitHub-specific defaults and then calls the same Dagger `workflow`,
`validate`, or `release-packages` entrypoints as raw CLI usage. For `workflow`,
it supports `workflow-env`, `deploy-env`, and `release-env` inputs.
