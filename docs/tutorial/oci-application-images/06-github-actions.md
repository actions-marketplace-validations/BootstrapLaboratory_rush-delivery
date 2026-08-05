# 6. GitHub Actions

This chapter keeps the existing filesystem-compatible Action path unchanged,
then adds OCI publication as a separate trusted opt-in. The composite Action
supports composed `workflow`, `validate`, and `release-packages`; stage-level
Package functions remain raw Dagger module calls.

## Action Reference Policy

GitHub treats only a full 40-character commit SHA as an immutable action
reference. The third-party actions below are pinned to reviewed full SHAs and
retain a release-version comment for dependency updates. Enable Dependabot (or
an equivalent reviewed updater) for those pins. Rush Delivery references remain
`@v0.8.1` here so every example states the release contract being taught; a
strict production repository should resolve that reviewed release tag,
verify it against the release record, and replace the tag with its full commit
SHA before merging the workflow. This is required when the repository or
organization enables GitHub's full-SHA action policy. See GitHub's
[secure action reference guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)
and
[full-SHA enforcement setting](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#allowing-select-actions-and-reusable-workflows-to-run).

## Prerequisites

- Complete [Deploy The Digest](05-deploy-the-digest.md).
- Commit and push the package/provider/deploy metadata to the target repository.
- Create a protected `production` GitHub environment with required reviewers or
  equivalent deployment policy.
- Store the five values from Chapter 3 in that environment.
- The repository's GHCR package policy must allow the dedicated PAT identity
  created in Chapter 3 to write the subject and its digest-derived `.sig`/`.att`
  attachment tags.

## Filesystem-Compatible Baseline

Start with a workflow that has no OCI credentials and leaves the application
provider off. This shape remains valid for existing `directory` and
`rush_deploy_archive` repositories; in the tutorial repository it produces a
credential-free OCI plan because the selected target is `oci_image`.

```yaml
name: release-plan

on:
  pull_request:

permissions:
  contents: read

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - name: Plan Rush Delivery
        uses: BootstrapLaboratory/rush-delivery@v0.8.1
        with:
          git-sha: ${{ github.event.pull_request.head.sha }}
          event-name: workflow_call
          force-targets-json: '["control-plane-api"]'
          dry-run: "true"
          toolchain-image-provider: off
          rush-cache-provider: off
          application-image-provider: off
```

Sanitized expected output includes `status=planned` and contains no repository,
digest, evidence, registry request, or OCI credential lookup. Fork pull requests
receive no live OCI credential because none is referenced by the job.

The Action's `docker-socket` input retains a non-empty default for compatibility
with existing project-owned deploy scripts that invoke Docker. That default is
not an OCI image-build dependency. Leave existing filesystem jobs unchanged
unless their own deploy scripts also do not need the socket. Treat a mounted
host socket as host-level authority: trusted project code can ask the daemon to
mount runner paths and bypass Dagger workspace or secret-file isolation. Never
give that socket to untrusted checkout code.

## Trusted OCI Release Job

Add live OCI as a separate job only after the package target and literal GHCR
provider metadata are reviewed. Replace `acme/control-plane` in the repository
guard with the actual owner/repository.

```yaml
name: publish-and-deploy-image

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

jobs:
  publish-and-deploy:
    if: >-
      github.repository == 'acme/control-plane' &&
      github.ref == 'refs/heads/main' &&
      (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: write
    steps:
      - name: Publish and deploy verified OCI image
        uses: BootstrapLaboratory/rush-delivery@v0.8.1
        with:
          git-sha: ${{ github.sha }}
          event-name: workflow_call
          force-targets-json: '["control-plane-api"]'
          environment: prod
          dry-run: "false"
          toolchain-image-provider: off
          rush-cache-provider: off
          application-image-provider: ghcr
          docker-socket: ""
          source-mode: git
          source-repository-url: https://github.com/${{ github.repository }}.git
          source-ref: ${{ github.sha }}
          source-auth-token-env: GITHUB_TOKEN
          deploy-env: |
            RD_OCI_GHCR_USERNAME=${{ vars.RD_OCI_GHCR_USERNAME }}
            RD_OCI_GHCR_TOKEN=${{ secrets.RD_OCI_GHCR_TOKEN }}
            RD_OCI_COSIGN_PRIVATE_KEY=${{ secrets.RD_OCI_COSIGN_PRIVATE_KEY }}
            RD_OCI_COSIGN_PASSWORD=${{ secrets.RD_OCI_COSIGN_PASSWORD }}
            RD_OCI_COSIGN_PUBLIC_KEY=${{ secrets.RD_OCI_COSIGN_PUBLIC_KEY }}
```

The PEM secrets above must already contain literal `\n` pairs and no physical
newline. `contents: write` lets the composed Git-source workflow move its deploy
tag after a successful deploy. This tutorial authenticates GHCR with the
dedicated PAT in `RD_OCI_GHCR_TOKEN`; the PAT's `write:packages` scope and its
account/package access permit subject and Cosign attachment-tag writes. A workflow-level
`packages: write` permission would affect only `${{ github.token }}` and would
not narrow or strengthen this PAT, so it is intentionally absent. If you replace
the PAT mapping with `${{ github.actor }}` plus `${{ github.token }}`, add
`packages: write` to this trusted job and re-check the package's Actions access.
Key-backed Cosign mode does not need `id-token` or `attestations` permission.

`docker-socket: ""` is required in this OCI-only job to prove that Dagger-native
image build/publication and the generic deploy script do not depend on the host
socket. Add a socket only to a different job whose project-owned deploy script
actually invokes Docker and whose checkout is fully trusted.

Environment approval and the repository/ref/event guard keep live credentials
out of untrusted pull requests and forks. Do not weaken the condition to run on
`pull_request_target` with untrusted checkout content. A fork PR should run the
provider-off baseline; it should never receive GHCR write credentials or the
Cosign private key.

Sanitized expected output proceeds through provider preflight, all preparation,
ordered publication/verification, the generic deploy script, and a
`deploy/prod/control-plane-api` tag update. A skipped job means the event/ref or
repository guard was not trusted; that is expected on PRs and forks.

## Stage-Level Package Publication Uses Raw Dagger

The composite Action does not expose `package-deploy-targets` or
`build-and-package-deploy-targets` as `entrypoint` values. A split-stage job must
install the pinned Dagger CLI, then invoke the `v0.8.1` module directly. This
complete job publishes and exports the package directory without running
Deploy:

```yaml
name: package-image-bundle

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  package:
    if: >-
      github.repository == 'acme/control-plane' &&
      github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          fetch-depth: 0

      - name: Install Dagger CLI
        uses: dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77 # v8.4.1
        with:
          version: v0.20.7

      - name: Build, publish, and export package bundle
        shell: bash
        env:
          RD_OCI_GHCR_USERNAME: ${{ vars.RD_OCI_GHCR_USERNAME }}
          RD_OCI_GHCR_TOKEN: ${{ secrets.RD_OCI_GHCR_TOKEN }}
          RD_OCI_COSIGN_PRIVATE_KEY: ${{ secrets.RD_OCI_COSIGN_PRIVATE_KEY }}
          RD_OCI_COSIGN_PASSWORD: ${{ secrets.RD_OCI_COSIGN_PASSWORD }}
          RD_OCI_COSIGN_PUBLIC_KEY: ${{ secrets.RD_OCI_COSIGN_PUBLIC_KEY }}
        run: |
          set -euo pipefail
          umask 077

          DEPLOY_ENV_FILE="${RUNNER_TEMP}/rush-delivery-oci.env"
          trap 'rm -f -- "${DEPLOY_ENV_FILE}"' EXIT
          {
            printf 'RD_OCI_GHCR_USERNAME=%s\n' "${RD_OCI_GHCR_USERNAME}"
            printf 'RD_OCI_GHCR_TOKEN=%s\n' "${RD_OCI_GHCR_TOKEN}"
            printf 'RD_OCI_COSIGN_PRIVATE_KEY=%s\n' "${RD_OCI_COSIGN_PRIVATE_KEY}"
            printf 'RD_OCI_COSIGN_PASSWORD=%s\n' "${RD_OCI_COSIGN_PASSWORD}"
            printf 'RD_OCI_COSIGN_PUBLIC_KEY=%s\n' "${RD_OCI_COSIGN_PUBLIC_KEY}"
          } > "${DEPLOY_ENV_FILE}"

          dagger \
            -m github.com/BootstrapLaboratory/rush-delivery@v0.8.1 \
            call build-and-package-deploy-targets \
            --repo=. \
            --ci-plan-file=ci/oci-plan.json \
            --artifact-prefix=deploy-target \
            --deploy-env-file="${DEPLOY_ENV_FILE}" \
            --dry-run=false \
            --git-sha="${GITHUB_SHA}" \
            --source-repository-url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git" \
            --application-image-provider=ghcr \
            export --path="${RUNNER_TEMP}/oci-package"

          test -f "${RUNNER_TEMP}/oci-package/.dagger/runtime/package-manifest.json"
```

The first Dagger Action step installs only the pinned CLI because no `args`,
`call`, or `shell` input is supplied. The following Bash step is the explicit
raw module call. Do not rewrite it as a Rush Delivery composite `entrypoint`;
that would imply a public surface the Action does not provide.

## Failure Meaning

- Missing environment values: the protected environment or secret/variable
  mapping is incomplete; do not substitute PR-visible values.
- `applicationImageProvider` unknown: the committed provider name does not match
  `ghcr` exactly.
- Docker socket errors in the OCI-only job: the input was not set to the empty
  string or a project deploy script still depends on Docker.
- `Resource not accessible by integration`: `${{ github.token }}` lacks the job
  permission needed for source or deploy-tag access. A GHCR denial in this
  tutorial instead means the PAT identity, scope, SSO authorization, or package
  policy is wrong.
- A post-publish Cosign failure can leave a subject, navigation tag, `.sig`,
  `.att`, or untagged historical package version; inspect the reported canonical
  reference and full package inventory before retrying.
- Composite `entrypoint` rejected: only `workflow`, `validate`, and
  `release-packages` are supported; use the raw module call for stage functions.

## Checkpoint

In the trusted job, inspect the result and require all of the following before
promotion:

```text
provider/key preflight succeeded
manifest status is published
reference contains @sha256:
generic deploy consumed the same reference
OCI-only job had docker-socket set to the empty string
no live OCI job ran for a pull request or fork
```

The GHCR package should contain exactly one subject plus at least two non-subject
package versions for the signature and combined attestation attachment. It may
contain additional untagged history. Registry UI counts remain secondary: the
manifest plus successful signature, SPDX-attestation, and provenance-attestation
verification are the release contract.

Next: [Split Stages And Rollback](07-split-stages-and-rollback.md).
