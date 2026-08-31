# Rush Delivery

Rush Delivery is a Dagger module and GitHub Action for Rush-based release
workflows. It owns the release path from source acquisition through detect,
validate, build, package, package release, and deploy while keeping
project-specific behavior in metadata.

Use it when a Rush monorepo needs one repeatable release path across CI and
local debugging:

- detect affected deploy targets from repository metadata;
- run validation and build work through Dagger with explicit metadata-selected
  environment;
- package filesystem deploy artifacts or verified OCI application images;
- route one OCI provider through environment-selected public registry
  coordinates without exposing credentials to Build or Deploy;
- bound local worktree transfer before Dagger uploads dependency/cache trees;
- extend the shared Rush image with digest-pinned, checksummed project tools;
- release npm packages through Rush change files;
- mount deploy-only runtime files such as cloud credentials;
- publish deploy tags and provider-backed cache or toolchain images.

## GitHub Actions

For GitHub CI, use the action. It prepares the Dagger CLI, deploy environment
file, runtime files bundle, Git source coordinates, and source auth token
plumbing for you.

Pin the action to a released tag and advance that tag intentionally when you
want new behavior.

### Pull Request Validation

Use the `validate` entrypoint for PR CI. The action clones the pull request
source inside Dagger, so normal validation does not need `actions/checkout`.
Provider-backed toolchain images and Rush cache stay read-only in PRs by
default: `validate` uses `pull-or-build`, which pulls an existing artifact when
available and builds locally on miss without publishing to GHCR.

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
      - uses: BootstrapLaboratory/rush-delivery@v0.9.1
        with:
          entrypoint: validate
          toolchain-image-provider: github
          rush-cache-provider: github
```

### Release Workflow

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
        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3
        with:
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

      - name: Rush Delivery
        uses: BootstrapLaboratory/rush-delivery@v0.9.1
        with:
          dry-run: "false"
          environment: prod
          deploy-tag-prefix: deploy/prod
          artifact-prefix: deploy-target
          toolchain-image-provider: github
          toolchain-image-policy: lazy
          rush-cache-provider: github
          rush-cache-policy: lazy
          runtime-file-map: |
            ${{ steps.auth.outputs.credentials_file_path }}=>gcp-credentials.json
          deploy-env: |
            GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}
            GCP_ARTIFACT_REGISTRY_REPOSITORY=${{ vars.GCP_ARTIFACT_REGISTRY_REPOSITORY }}
```

See [GitHub Actions quick start](docs/quick-start/github-actions.md) and
[GitHub Action usage](docs/github-actions.md) for the full production shape.

### Package Release

Use `release-targets-json: '["npm"]'` when npm package release should run as
part of the main `workflow`. Rush Delivery then shares source acquisition,
metadata validation, Rush install cache, and the build lifecycle before running
deploy and npm release side effects. Deploy tags still point to the original
source SHA; Rush package release pushes its generated version commit to the
metadata `target_branch`.

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.9.1
  with:
    dry-run: "false"
    release-targets-json: '["npm"]'
    deploy-env: |
      GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}
    release-env: |
      NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

The standalone `release-packages` entrypoint remains available for
package-only repositories, custom CI, and release debugging. It uses
`.dagger/release/npm.yaml`, runs the shared Rush lifecycle in build-first order
(`build`, `lint`, `test`, `verify`), lets Rush apply change files, publishes
packages, and pushes the generated version commit. Package-only repositories do
not need deploy metadata for this entrypoint.
For live releases, Rush Delivery prepares the metadata `target_branch` as a
local branch before invoking `rush publish`, so Rush can merge the generated
version commit back to the remote branch.

The project still owns Rush package publishing policy: package names, version
policies, change files, `publishConfig`, package `files`, and
`common/config/rush/.npmrc-publish`. Rush Delivery owns the isolated CI runtime,
source acquisition, build-before-publish lifecycle, release credentials, and
Git push plumbing.

NPM provenance is disabled by default. Keep `publish.provenance` omitted unless
your release runtime is explicitly wired for npm's supported provenance
provider detection from inside Dagger.

```yaml
permissions:
  contents: read

jobs:
  release-packages:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: BootstrapLaboratory/rush-delivery@v0.9.1
        with:
          entrypoint: release-packages
          dry-run: "false"
          toolchain-image-provider: off
          rush-cache-provider: off
          release-env: |
            NPM_TOKEN=${{ secrets.NPM_TOKEN }}
```

Use `packages: write` and provider `github` only when the project also
configures GHCR-backed toolchain images or Rush install cache.

## CI Using Command Line

Use the raw Dagger command when your CI provider is not GitHub Actions, or when
you want to own all surrounding shell steps yourself.

This mode clones the target repository inside Dagger, so the CI runner does not
need to mount the repository into the module.

```sh
RUSH_DELIVERY_MODULE=github.com/BootstrapLaboratory/rush-delivery@v0.9.1
RUNTIME_FILES_DIR="${RUNNER_TEMP}/rush-delivery-runtime-files"
WORKFLOW_ENV_FILE="${RUNNER_TEMP}/dagger-workflow.env"
DEPLOY_ENV_FILE="${RUNNER_TEMP}/dagger-deploy.env"
RELEASE_ENV_FILE="${RUNNER_TEMP}/dagger-release.env"
SOURCE_REPOSITORY_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git"

mkdir -p "${RUNTIME_FILES_DIR}"
cp "${GCP_CREDENTIALS_FILE}" "${RUNTIME_FILES_DIR}/gcp-credentials.json"

cat > "${WORKFLOW_ENV_FILE}" <<EOF
GITHUB_ACTOR=${GITHUB_ACTOR}
GITHUB_REPOSITORY=${GITHUB_REPOSITORY}
GITHUB_TOKEN=${GITHUB_TOKEN}
EOF
cat > "${DEPLOY_ENV_FILE}" <<EOF
GCP_PROJECT_ID=${GCP_PROJECT_ID}
EOF
cat > "${RELEASE_ENV_FILE}" <<EOF
NPM_TOKEN=${NPM_TOKEN}
EOF

dagger -m "${RUSH_DELIVERY_MODULE}" call workflow \
  --git-sha="${GITHUB_SHA}" \
  --event-name="${GITHUB_EVENT_NAME}" \
  --force-targets-json="${FORCE_TARGETS_JSON:-[]}" \
  --deploy-tag-prefix=deploy/prod \
  --artifact-prefix=deploy-target \
  --environment=prod \
  --dry-run=false \
  --workflow-env-file="${WORKFLOW_ENV_FILE}" \
  --deploy-env-file="${DEPLOY_ENV_FILE}" \
  --release-targets-json='["npm"]' \
  --release-env-file="${RELEASE_ENV_FILE}" \
  --toolchain-image-provider=github \
  --toolchain-image-policy=lazy \
  --rush-cache-provider=github \
  --rush-cache-policy=lazy \
  --source-mode=git \
  --source-repository-url="${SOURCE_REPOSITORY_URL}" \
  --source-ref="${GITHUB_REF}" \
  --source-auth-token-env=GITHUB_TOKEN \
  --runtime-files="${RUNTIME_FILES_DIR}"
```

`application-image-provider` is opt-in. Existing projects using only directory
or Rush deploy archive artifacts can leave it `off` and need no `.dagger`
configuration change after upgrading. OCI image packaging uses Dagger-native
build and registry APIs, records only a verified digest reference, and does not
need a host Docker socket. Start with the
[OCI application images tutorial](docs/tutorial/oci-application-images/README.md),
then use the [production guide](docs/oci-application-images.md),
[registry recipes](docs/oci-registry-recipes.md), and
[troubleshooting guide](docs/oci-application-image-troubleshooting.md) for a
live rollout. OCI-only Action jobs should set `docker-socket: ""`.
Keep the compatibility socket only for trusted legacy Deploy scripts: access to
the host Docker daemon can bypass Dagger workspace and secret-file isolation.

See [CI using command line](docs/quick-start/ci-cli.md) for the guided version.

## Local Runs Against Unpushed Changes

For local testing, pass the working tree explicitly. This keeps unpushed edits
available to Dagger and avoids relying on a remote Git ref that does not contain
your latest changes.

```sh
./rush-delivery-local \
  --module=github.com/BootstrapLaboratory/rush-delivery@v0.9.1 \
  --repo=. \
  -- \
  workflow \
  --git-sha="$(git rev-parse HEAD)" \
  --event-name=manual \
  --force-targets-json='[]' \
  --environment=prod \
  --dry-run=true \
  --toolchain-image-provider=off \
  --rush-cache-provider=off
```

The release launcher applies bounded caller-side excludes before Dagger uploads
the worktree. See [local runs](docs/quick-start/local-run.md) and the
[bounded local-copy guide](docs/local-copy-source-imports.md) for checksum
installation, inclusion rules, and the `legacy` recovery path.

## Documentation

- [Documentation site](https://bootstraplaboratory.github.io/rush-delivery/)
- [Introduction](docs/README.md)
- [Public Dagger API](docs/api.md)
- [Entrypoints reference](docs/entrypoints.md)
- [Workflow guide](docs/workflows.md)
- [Metadata contracts](docs/metadata.md)
- [Provider adapters](docs/providers.md)
- [Bounded local-copy imports](docs/local-copy-source-imports.md)
- [Project-owned Rush toolchain](docs/rush-toolchain.md)
- [Upgrade to v0.9.1](docs/upgrade-v0.9.1.md)
- [Upgrade to v0.9.0](docs/upgrade-v0.9.0.md)
- [OCI application images tutorial](docs/tutorial/oci-application-images/README.md)
- [OCI application images](docs/oci-application-images.md)
- [OCI registry recipes](docs/oci-registry-recipes.md)
- [OCI application image troubleshooting](docs/oci-application-image-troubleshooting.md)
- [Development notes](docs/development.md)
