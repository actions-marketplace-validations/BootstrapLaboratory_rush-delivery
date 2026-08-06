# GitHub Action Usage

Rush Delivery can be used as a GitHub Action or as a raw Dagger module. The
GitHub Action is a thin adapter over the module's Dagger functions, so release
and validation behavior stay identical between action and raw CLI usage.

## Pull Request Validation

Use `entrypoint: validate` for PR CI. The action defaults to Git source mode,
uses the current GitHub repository and ref, writes `GITHUB_TOKEN` into the
deploy env file for source authentication, and forwards the pull request base
SHA from the GitHub event. When `entrypoint: validate` is selected, provider
policies default to `pull-or-build`, so existing toolchain images and Rush cache
can be reused without granting publish access. If npm release metadata exists,
validation also runs Rush change-file verification.

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
      - uses: BootstrapLaboratory/rush-delivery@v0.9.0
        with:
          entrypoint: validate
          toolchain-image-provider: github
          rush-cache-provider: github
```

`pull-or-build` pulls the provider artifact when it exists. If it is missing,
validation builds locally inside the current Dagger run and does not publish to
GHCR.

If selected package targets declare build-time `pass_env` or `map_env`, include
those source values in `deploy-env` for PR validation too. Keep PR values
read-only and avoid granting publish credentials.

To validate unpushed local-copy source from a checked-out runner workspace,
override the source mode and pass `repo`:

```yaml
steps:
  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
    with:
      fetch-depth: 0

  - uses: BootstrapLaboratory/rush-delivery@v0.9.0
    with:
      entrypoint: validate
      repo: .
      source-mode: local_copy
      source-import-policy: bounded
      source-import-ignore-file: .dagger/source-import.ignore
```

`bounded` is the v0.9.0 local-copy default. It removes dependency/cache trees
at the Dagger host import operation while retaining `.git`, `.dagger`, and
`rush.json`. Repository `!` inclusions are read from the optional ignore file.
Use `legacy` only as a temporary recovery path for a required matched file. Git
source mode never reads either local-copy input and emits one fixed diagnostic.
See [bounded local-copy imports](local-copy-source-imports.md).

## Release Workflow

Provider authentication stays in the caller workflow. Pass shared values through
`workflow-env`, generated files through `runtime-file-map`, build or deploy
values through `deploy-env`, and package release values through `release-env`.
The `.dagger` metadata still decides which values reach each stage.

```yaml
steps:
  - id: auth
    name: Authenticate to Google Cloud
    if: inputs.force_targets_json != '["webapp"]'
    uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3
    with:
      workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
      service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

  - name: Rush Delivery
    uses: BootstrapLaboratory/rush-delivery@v0.9.0
    with:
      force-targets-json: ${{ inputs.force_targets_json || '[]' }}
      deploy-tag-prefix: ${{ env.DEPLOY_TAG_PREFIX }}
      artifact-prefix: ${{ env.DEPLOY_ARTIFACT_PREFIX }}
      environment: prod
      dry-run: "false"
      toolchain-image-provider: ${{ env.TOOLCHAIN_IMAGE_PROVIDER }}
      toolchain-image-policy: ${{ env.TOOLCHAIN_IMAGE_POLICY }}
      rush-cache-provider: ${{ env.RUSH_CACHE_PROVIDER }}
      rush-cache-policy: ${{ env.RUSH_CACHE_POLICY }}
      release-targets-json: '["npm"]'
      runtime-file-map: |
        ${{ steps.auth.outputs.credentials_file_path }}=>gcp-credentials.json
      release-env: |
        NPM_TOKEN=${{ secrets.NPM_TOKEN }}
      deploy-env: |
        GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}
        GCP_ARTIFACT_REGISTRY_REPOSITORY=${{ vars.GCP_ARTIFACT_REGISTRY_REPOSITORY }}
        CLOUD_RUN_SERVICE=${{ vars.CLOUD_RUN_SERVICE }}
        CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT=${{ vars.CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT }}
        CLOUD_RUN_CORS_ORIGIN=${{ vars.CLOUD_RUN_CORS_ORIGIN }}
        CLOUD_RUN_REGION=${{ env.CLOUD_RUN_REGION }}
        CLOUDFLARE_API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}
        CLOUDFLARE_ACCOUNT_ID=${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        CLOUDFLARE_PAGES_PROJECT_NAME=${{ vars.CLOUDFLARE_PAGES_PROJECT_NAME }}
        WEBAPP_VITE_GRAPHQL_HTTP=${{ vars.WEBAPP_VITE_GRAPHQL_HTTP }}
        WEBAPP_VITE_GRAPHQL_WS=${{ vars.WEBAPP_VITE_GRAPHQL_WS }}
        WEBAPP_URL=https://${{ vars.CLOUDFLARE_PAGES_PROJECT_NAME }}.pages.dev
```

`release-targets-json` is explicit because npm package release creates external
side effects: published packages and a Rush-generated version commit. When npm
release is selected, Rush Delivery runs the all-project Rush lifecycle once,
then starts deploy and package release side effects after shared prerequisites
have passed. These side effects are concurrent but not transactional; if one
external system fails after the other succeeds, the successful side effect may
already exist.

For `workflow`, the action appends `GITHUB_ACTOR`, `GITHUB_REPOSITORY`,
`GITHUB_API_URL`, and `GITHUB_TOKEN` to the generated `workflow-env` file by
default. Set `include-github-env: "false"` if you want to provide those values
yourself. `deploy-env` and `release-env` may repeat workflow values only when
the value is identical.

When deploy-tag updates are enabled, `GITHUB_API_URL` must be an absolute,
credential-free HTTPS base. GitHub Enterprise paths such as
`https://github.example.com/api/v3` are supported; embedded userinfo, HTTP,
query strings, and fragments are rejected before the bearer token is sent.
Failures report only the fixed action and HTTP status, never the remote response
body, because an endpoint could reflect authorization material.

This release example is filesystem-first: it does not select an
application-image provider and does not require OCI registry or Cosign
credentials.

## OCI Application Images

Set `application-image-provider` to a provider declared in
`.dagger/application-images/providers.yaml` when a live release selects an
`oci_image` package target. The action default is `off`, so existing
directory/archive projects need no configuration change when upgrading.

Provider metadata names public registry coordinates (or the environment names
that select them) and protected Cosign/registry credential environment names.
Put their values in `workflow-env` or `deploy-env`; the action passes the flat
env file to Dagger. Rush Delivery treats coordinates as public routing inputs
and converts only credential values to protected capabilities.
Store multiline PEM values with literal `\n` separators. Do not put registry or
signing values in `runtime-file-map`: deploy scripts receive only the verified
digest reference and target-scoped evidence.

OCI image builds and publication are Dagger-native. Set `docker-socket: ""` in
OCI-only Action jobs; the non-empty Action default exists only for legacy
project deploy scripts that invoke Docker. A mounted host socket gives that
project code effective control of the runner's Docker daemon and can bypass
Dagger workspace and secret-file isolation by mounting host paths. Keep it only
for trusted legacy deploy scripts, never untrusted checkout code.
Registry-specific login steps are also unnecessary when the metadata-selected
username/token can push to the configured registry.

Dry runs may leave `application-image-provider: off`, or select a named provider
to validate the planned repository without resolving its credentials. Build
the metadata and CI path with the
[OCI application images tutorial](tutorial/oci-application-images/README.md),
the [environment-profile tutorial](tutorial/oci-application-images/08-environment-profiles.md),
then use the [production guide](oci-application-images.md),
[registry recipes](oci-registry-recipes.md), and
[troubleshooting guide](oci-application-image-troubleshooting.md).

## Project-Owned Rush Tools

When `.dagger/toolchains/rush.yaml` exists, every Rush-using entrypoint receives
its digest-pinned, checksummed executables before Rush install and lifecycle
scripts. No new Action input is required. Toolchain provider/cache inputs keep
their existing meaning; the project metadata becomes part of the v2 toolchain
cache identity.

Trusted workflows may use `toolchain-image-policy: lazy` to publish a missing
content-addressed image. PR validation should use `pull-or-build` so it never
publishes. Follow the [toolchain guide](rush-toolchain.md) and
[mixed Node/Python tutorial](tutorial/15-mixed-node-python-toolchain.md).

## Package Release

Use `entrypoint: release-packages` when npm package release should stay as a
standalone workflow, for example in package-only repositories or release
debugging. Keep npm credentials in `release-env`, not `deploy-env`; package
release credentials are separate from deploy credentials because npm publishing
is a registry side effect, not a deploy target runtime.

The smallest package-only workflow can keep provider adapters off. This is the
shape used by package-only projects such as
[LabKit](https://github.com/BootstrapLaboratory/labkit):

```yaml
name: package-release

on:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  release-packages:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: BootstrapLaboratory/rush-delivery@v0.9.0
        with:
          entrypoint: release-packages
          dry-run: "false"
          toolchain-image-provider: off
          rush-cache-provider: off
          release-env: |
            NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

The package release entrypoint uses Git source mode by default, runs the shared
Rush lifecycle in build-first order (`build`, `lint`, `test`, `verify`), lets
Rush apply change files, publishes packages, and pushes the generated version
commit to the metadata `target_branch`. It prepares that target branch locally
before invoking `rush publish`, which lets Rush check it out for the final
merge.

`contents: write` is required for live releases because Rush writes a generated
version commit and pushes it back to `versioning.target_branch`. The action
adds `GITHUB_TOKEN` to the generated release env file by default, so the same
token is used for source acquisition and the final push. Set
`include-github-env: "false"` only when you provide an equivalent token yourself.

`packages: write` is not required for npmjs publishing by itself. Add
`packages: read` or `packages: write` only when `toolchain-image-provider` or
`rush-cache-provider` uses `github`.

The project still owns npm publish policy through Rush and npm files:

- `common/config/rush/version-policies.json` and `rush.json` decide package
  version policy names.
- Rush change files decide the next version and changelog content.
- Package `publishConfig`, `files`, entrypoints, and private/public package
  settings decide what npm can publish.
- `common/config/rush/.npmrc-publish` maps `NPM_TOKEN` into npm auth.

NPM provenance is disabled by default. Keep `publish.provenance` omitted or set
to `false` unless the release runtime is explicitly configured so npm can
detect a supported provenance provider from inside Dagger.

For package-only repositories that do not use Rush Delivery cache metadata, set
`rush-cache-provider: off` or omit the input. `.dagger/rush-cache/providers.yaml`
is only required when `rush-cache-provider: github` is selected.
They can also omit application-image metadata and leave
`application-image-provider: off` unless their deploy selection contains an OCI
target.

## Runtime Files

`runtime-file-map` is a multiline list of `SOURCE=>DEST` entries. `SOURCE` is a
file path on the GitHub runner, and `DEST` is a safe relative path inside the
runtime files bundle passed to Dagger.

Empty `SOURCE` values are skipped. This supports conditional provider auth
steps where an output is intentionally blank for some target selections.

```yaml
runtime-file-map: |
  ${{ steps.auth.outputs.credentials_file_path }}=>gcp-credentials.json
```

Use runtime files only for deploy-platform inputs. OCI registry tokens, Cosign
private keys, signing passwords, and Cosign public keys belong in
`workflow-env` or `deploy-env` under the names declared by the selected
application-image provider; Rush Delivery exposes them only to Package.

Deploy target metadata can mount those files with:

```yaml
runtime:
  env:
    GOOGLE_APPLICATION_CREDENTIALS: /runtime-files/gcp-credentials.json
  file_mounts:
    - source: gcp-credentials.json
```

## Raw Dagger Mode

The action mode does not replace raw Dagger usage. Local runs, other CI
providers, and lower-level debugging can still call the module directly:

```sh
dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.9.0 call workflow \
  --git-sha="$GITHUB_SHA" \
  --source-mode=git \
  --source-repository-url="$SOURCE_REPOSITORY_URL" \
  --source-ref="$SOURCE_REF" \
  --source-auth-token-env=GITHUB_TOKEN
```
