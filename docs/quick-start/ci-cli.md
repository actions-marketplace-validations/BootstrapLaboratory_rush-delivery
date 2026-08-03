# CI Using Command Line

Use the raw Dagger command when your CI provider is not GitHub Actions, or when
you want to own all surrounding shell steps yourself.

This mode clones the target repository inside Dagger, so the CI runner does not
need to mount the repository into the module.

For pull-request validation:

```sh
RUSH_DELIVERY_MODULE=github.com/BootstrapLaboratory/rush-delivery@v0.8.0
DEPLOY_ENV_FILE="${RUNNER_TEMP}/dagger-validate.env"
SOURCE_REPOSITORY_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git"

cat > "${DEPLOY_ENV_FILE}" <<EOF
GITHUB_ACTOR=${GITHUB_ACTOR}
GITHUB_REPOSITORY=${GITHUB_REPOSITORY}
GITHUB_TOKEN=${GITHUB_TOKEN}
EOF

dagger -m "${RUSH_DELIVERY_MODULE}" call validate \
  --git-sha="${GITHUB_SHA}" \
  --event-name="${GITHUB_EVENT_NAME}" \
  --pr-base-sha="${PR_BASE_SHA}" \
  --deploy-env-file="${DEPLOY_ENV_FILE}" \
  --toolchain-image-provider=github \
  --rush-cache-provider=github \
  --source-mode=git \
  --source-repository-url="${SOURCE_REPOSITORY_URL}" \
  --source-ref="${GITHUB_REF}" \
  --source-auth-token-env=GITHUB_TOKEN
```

The `validate` entrypoint defaults provider policies to `pull-or-build`. It
pulls existing GHCR artifacts when they are present, builds locally on miss, and
never publishes from the PR run.

When package target build metadata uses `pass_env` or `map_env`, write those
source variables into `DEPLOY_ENV_FILE` before calling `validate`.

If `.dagger/release/npm.yaml` exists, validation also verifies Rush change
files.

For release workflow runs:

```sh
RUSH_DELIVERY_MODULE=github.com/BootstrapLaboratory/rush-delivery@v0.8.0
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
OCI_USERNAME=${OCI_USERNAME}
OCI_TOKEN=${OCI_TOKEN}
OCI_SIGNING_KEY=${OCI_SIGNING_KEY}
OCI_SIGNING_PASSWORD=${OCI_SIGNING_PASSWORD}
OCI_SIGNING_PUBLIC_KEY=${OCI_SIGNING_PUBLIC_KEY}
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
  --application-image-provider=release \
  --source-mode=git \
  --source-repository-url="${SOURCE_REPOSITORY_URL}" \
  --source-ref="${GITHUB_REF}" \
  --source-auth-token-env=GITHUB_TOKEN \
  --runtime-files="${RUNTIME_FILES_DIR}"
```

The OCI provider values are needed only for live `oci_image` targets. Leave
`--application-image-provider=off` and omit them for existing filesystem-only
projects or provider-off dry runs. Multiline Cosign PEM values can use literal
`\n` separators in the flat env file. Dagger builds and publishes these images
without a host Docker socket.

For package release/versioning:

```sh
RUSH_DELIVERY_MODULE=github.com/BootstrapLaboratory/rush-delivery@v0.8.0
RELEASE_ENV_FILE="${RUNNER_TEMP}/dagger-release.env"
SOURCE_REPOSITORY_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git"

cat > "${RELEASE_ENV_FILE}" <<EOF
GITHUB_TOKEN=${GITHUB_TOKEN}
NPM_TOKEN=${NPM_TOKEN}
EOF

dagger -m "${RUSH_DELIVERY_MODULE}" call release-packages \
  --git-sha="${GITHUB_SHA}" \
  --dry-run=false \
  --release-env-file="${RELEASE_ENV_FILE}" \
  --toolchain-image-provider=off \
  --rush-cache-provider=off \
  --source-mode=git \
  --source-repository-url="${SOURCE_REPOSITORY_URL}" \
  --source-ref="${GITHUB_REF}" \
  --source-auth-token-env=GITHUB_TOKEN
```

Use provider `github` when the repository has `.dagger/toolchain-images` or
`.dagger/rush-cache` metadata and the CI job has matching package registry
permissions. For a package-only npmjs release, provider `off` is the smallest
portable shape.

The release env file must include the env named by `.dagger/release/npm.yaml`
`auth.token_env`, usually `NPM_TOKEN`. It must also include the Git source token
used by `--source-auth-token-env`, because live release needs to push the
Rush-generated version commit back to the target branch.

Use [Local Runs](local-run.md) when you need to test changes that have not been
pushed to the remote repository yet.

For all callable module inputs, see the [Public Dagger API](../api.md).
