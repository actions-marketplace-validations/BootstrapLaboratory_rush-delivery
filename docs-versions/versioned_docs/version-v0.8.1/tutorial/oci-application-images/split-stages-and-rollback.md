---
title: "7 - Split Stages And Rollback"
sidebar_label: "7 - Split Stages And Rollback"
---

This chapter persists the complete packaged directory across jobs, verifies it
against protected release metadata, deploys it, and repeats the process with an
earlier trusted bundle for rollback. Persisting only
`.dagger/runtime/package-manifest.json` is unsafe and incomplete.

## Prerequisites

- Complete [GitHub Actions](../github-actions).
- Use immutable-by-ID, access-controlled CI artifact storage with deletion and
  retention restricted to release operators.
- Use protected package/deploy jobs and keep GHCR/signing credentials out of
  the deploy job.
- Install GNU `tar`, `sha256sum`, `jq`, and Python 3.12 or newer in the handoff
  environment.
- Maintain a protected release record outside the unsigned package bundle. For
  every bundle it must retain the artifact ID, producing workflow run ID,
  archive file name, independently computed SHA-256, and original full source
  SHA.

The artifact service protects the immutable stored object; the external record
selects and authenticates the expected object. Do not derive the expected
checksum or expected source SHA from the downloaded archive itself.
The upload/download steps below follow Chapter 6's production policy: each
third-party action is pinned to a reviewed full commit SHA with its release
version retained as a comment.

## Detect, Build, Publish, And Export

Run these commands from the exact committed source revision:

```bash
set -euo pipefail

export RUSH_DELIVERY_MODULE="github.com/BootstrapLaboratory/rush-delivery@v0.8.1"
export SOURCE_SHA="$(git rev-parse HEAD)"
test "${#SOURCE_SHA}" -eq 40
test "$(git status --porcelain)" = ""

SPLIT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rush-delivery-oci-split.XXXXXX")"
CI_PLAN_FILE="${SPLIT_ROOT}/ci-plan.json"
PACKAGED_DIR="${SPLIT_ROOT}/packaged"

dagger -m "${RUSH_DELIVERY_MODULE}" call detect \
  --repo=. \
  --event-name=workflow_call \
  --force-targets-json='["control-plane-api"]' \
  --deploy-tag-prefix=deploy/prod \
  > "${CI_PLAN_FILE}"

jq -e \
  '.mode == "release"
   and .deploy_targets == ["control-plane-api"]' \
  "${CI_PLAN_FILE}"

dagger -m "${RUSH_DELIVERY_MODULE}" call \
  build-and-package-deploy-targets \
  --repo=. \
  --ci-plan-file="${CI_PLAN_FILE}" \
  --artifact-prefix=deploy-target \
  --deploy-env-file="${DEPLOY_ENV_FILE}" \
  --dry-run=false \
  --git-sha="${SOURCE_SHA}" \
  --source-repository-url="${SOURCE_REPOSITORY_URL}" \
  --application-image-provider=ghcr \
  export --path="${PACKAGED_DIR}"
```

Sanitized expected plan:

```json
{
  "affected_projects_by_deploy_target": {
    "control-plane-api": []
  },
  "deploy_targets": ["control-plane-api"],
  "mode": "release",
  "pr_base_sha": "",
  "release_targets": [],
  "validate_targets": []
}
```

Forced selection is explicit; `affected_projects_by_deploy_target` may differ
when a prior deploy tag exists. A Detect failure usually means Git history/tags
were omitted from source, the forced target is unknown, or metadata is invalid.
A Package failure has the same pre-/post-publication meaning described in
[Publish And Inspect](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/docs/tutorial/oci-application-images/04-publish-and-inspect.md#failure-meaning).

## Archive The Complete Directory

Archive the directory—not just the manifest—with a POSIX tar stream that keeps
normal mode bits and safe symlinks. The deterministic flags also make repeated
archives of identical bytes easier to audit:

```bash
ARCHIVE_NAME="rush-delivery-oci-package-${SOURCE_SHA}.tar.gz"
ARCHIVE_PATH="${SPLIT_ROOT}/${ARCHIVE_NAME}"
CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"

tar \
  --create \
  --gzip \
  --format=posix \
  --sort=name \
  --mtime=@0 \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --pax-option=delete=atime,delete=ctime \
  --file="${ARCHIVE_PATH}" \
  --directory="${PACKAGED_DIR}" \
  .

ARCHIVE_SHA256="$(sha256sum "${ARCHIVE_PATH}" | awk '{print $1}')"
[[ ${ARCHIVE_SHA256} =~ ^[a-f0-9]{64}$ ]]
printf '%s  %s\n' "${ARCHIVE_SHA256}" "${ARCHIVE_NAME}" \
  > "${CHECKSUM_PATH}"

tar --list --gzip --file="${ARCHIVE_PATH}" \
  | grep -F './.dagger/runtime/package-manifest.json'
tar --list --gzip --file="${ARCHIVE_PATH}" \
  | grep -F './.dagger/runtime/application-image-credential-capability.json'
```

Package writes the second internal file after Build. It contains credential
names, provider names, and field roles—not values—and preserves the pre-Build
projection boundary for standalone Deploy. Older bundles without it fall back
to their provider file. No credential values belong in either bundle. The
repository's [`split-stage handoff test`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/test/split-stage-handoff.test.ts)
exercises
mode and symlink preservation plus path/link escape rejection for this archive
shape.

Expected output includes both required paths. If either is absent, do not upload
the archive. A checksum file placed beside the archive is convenient for manual
transport, but it is not the trusted expected checksum: the protected release
record must store `ARCHIVE_SHA256` independently.

Before archiving, also enforce the `v0.8.1` framework-directory shape:

```bash
for framework_directory in \
  ".dagger" \
  ".dagger/runtime" \
  ".dagger/runtime/evidence"
do
  if [[ ! -d "${PACKAGED_DIR}/${framework_directory}" || \
        -L "${PACKAGED_DIR}/${framework_directory}" ]]; then
    printf 'invalid packaged framework directory: %s\n' \
      "${framework_directory}" >&2
    exit 1
  fi
done
```

Ordinary safe symlinks elsewhere in the complete directory remain supported.
These three paths are framework-owned: Package preserves non-runtime Build
outputs such as `.dagger/generated-output`, clears any pre-existing runtime
file, directory, or symlink, and writes fresh runtime metadata/evidence under
concrete directories. Deploy checks the same boundary before both dry and live
target execution.

If an older retained bundle fails this gate, do not replace the symlink by hand,
copy only `.dagger/runtime`, or recompute a checksum over the patched archive.
Run the `v0.8.1` Package producer again from the intended source and built
output, export the complete returned directory, and register a new archive,
checksum/identity, and source-SHA record. For OCI, this is a new controlled
Package/publication attempt: inspect and govern registry side effects exactly as
you would for any other new release candidate.

## Upload By Immutable Artifact ID

In GitHub Actions, use the current direct-file upload mode so the already-gzipped
tar bytes are not hidden behind a second archive. This exact step follows the
archive command above:

```yaml
- id: bundle
  name: Archive complete package directory
  shell: bash
  run: |
    set -euo pipefail
    ARCHIVE_NAME="rush-delivery-oci-package-${GITHUB_SHA}.tar.gz"
    ARCHIVE_PATH="${RUNNER_TEMP}/${ARCHIVE_NAME}"

    tar \
      --create \
      --gzip \
      --format=posix \
      --sort=name \
      --mtime=@0 \
      --owner=0 \
      --group=0 \
      --numeric-owner \
      --pax-option=delete=atime,delete=ctime \
      --file="${ARCHIVE_PATH}" \
      --directory="${RUNNER_TEMP}/oci-package" \
      .

    ARCHIVE_SHA256="$(sha256sum "${ARCHIVE_PATH}" | awk '{print $1}')"
    [[ ${ARCHIVE_SHA256} =~ ^[a-f0-9]{64}$ ]]
    printf 'archive-name=%s\n' "${ARCHIVE_NAME}" >> "${GITHUB_OUTPUT}"
    printf 'archive-path=%s\n' "${ARCHIVE_PATH}" >> "${GITHUB_OUTPUT}"
    printf 'archive-sha256=%s\n' "${ARCHIVE_SHA256}" >> "${GITHUB_OUTPUT}"
    printf 'source-sha=%s\n' "${GITHUB_SHA}" >> "${GITHUB_OUTPUT}"

- id: upload
  name: Upload immutable package archive
  uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
  with:
    path: ${{ steps.bundle.outputs.archive-path }}
    archive: false
    if-no-files-found: error
    overwrite: false
    retention-days: 30

- name: Emit protected-release record fields
  shell: bash
  env:
    ARCHIVE_NAME: ${{ steps.bundle.outputs.archive-name }}
    ARCHIVE_SHA256: ${{ steps.bundle.outputs.archive-sha256 }}
    ARTIFACT_ID: ${{ steps.upload.outputs.artifact-id }}
    ARTIFACT_URL: ${{ steps.upload.outputs.artifact-url }}
    SOURCE_SHA: ${{ steps.bundle.outputs.source-sha }}
  run: |
    set -euo pipefail
    jq -n \
      --arg archive_name "${ARCHIVE_NAME}" \
      --arg archive_sha256 "${ARCHIVE_SHA256}" \
      --arg artifact_id "${ARTIFACT_ID}" \
      --arg artifact_url "${ARTIFACT_URL}" \
      --arg run_id "${GITHUB_RUN_ID}" \
      --arg source_sha "${SOURCE_SHA}" \
      '{
        archive_name: $archive_name,
        archive_sha256: $archive_sha256,
        artifact_id: $artifact_id,
        artifact_url: $artifact_url,
        producing_run_id: $run_id,
        source_sha: $source_sha
      }' > "${RUNNER_TEMP}/protected-release-record.json"
    cat "${RUNNER_TEMP}/protected-release-record.json"
```

`archive: false` stores the one tarball as the artifact; its file name is the
artifact name. Copy the emitted JSON fields into an append-only or versioned
release record controlled outside the bundle (for example, an approved change
record/deployment database). The JSON printed in the job is a handoff candidate,
not protection by itself. The protected system must preserve history for
rollback, restrict replacement/deletion, and bind approval to the exact artifact
ID, producing run, checksum, and source SHA.

`retention-days: 30` is an explicit tutorial placeholder, not a production
retention recommendation. Set it to at least the approved rollback/audit window
and verify that the repository or organization artifact-retention maximum
permits that value. Artifact URLs and IDs stop being usable when the artifact,
run, or repository is deleted. If the required window exceeds GitHub Actions
retention, copy the already checksummed tarball to longer-lived immutable,
access-controlled object storage and record that storage object's immutable ID
alongside the same checksum and source SHA. See the upload action's
[retention and output contract](https://github.com/actions/upload-artifact/blob/main/README.md#inputs).

Do not upload the raw package directory and assume the artifact service will
preserve executable modes or symlinks. Only the tarball is the portable object.

## Download And Verify Before Extraction

At deploy time, an approved operator/control plane supplies these values from
the protected record, not from the bundle:

```text
PACKAGE_ARTIFACT_ID
PACKAGE_PRODUCING_RUN_ID
PACKAGE_ARCHIVE_NAME
EXPECTED_ARCHIVE_SHA256
EXPECTED_SOURCE_SHA
```

The GitHub download step can select the immutable artifact ID from its original
run and retain the raw tarball:

```yaml
- name: Download selected package archive
  uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
  with:
    artifact-ids: ${{ inputs.package_artifact_id }}
    github-token: ${{ github.token }}
    repository: ${{ github.repository }}
    run-id: ${{ inputs.package_producing_run_id }}
    path: ${{ runner.temp }}/package-download
    skip-decompress: true
    digest-mismatch: error
```

The deploy job needs `actions: read` and `contents: read`, uses the protected
release environment, and does not need `packages: write` or signing secrets.

Verify the independent checksum, reject absolute/traversing members and unsafe
links/special files, extract into a sibling staging directory, then atomically
rename it. Python 3.12's `tarfile.data_filter` performs the path/link/type
filtering while retaining ordinary executable bits and safe symlinks:

```bash
set -euo pipefail

DOWNLOAD_DIR="${RUNNER_TEMP}/package-download"
ARCHIVE_PATH="${DOWNLOAD_DIR}/${PACKAGE_ARCHIVE_NAME}"
RESTORE_PARENT="${RUNNER_TEMP}/rush-delivery-restored"
RESTORED_DIR="${RESTORE_PARENT}/package"

test -f "${ARCHIVE_PATH}"
python3 -c 'import sys; assert sys.version_info >= (3, 12)'

python3 - \
  "${ARCHIVE_PATH}" \
  "${EXPECTED_ARCHIVE_SHA256}" \
  "${RESTORED_DIR}" <<'PY'
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile

archive = Path(sys.argv[1])
expected = sys.argv[2]
destination = Path(sys.argv[3])

if len(expected) != 64 or any(ch not in "0123456789abcdef" for ch in expected):
    raise SystemExit("expected archive SHA-256 is not 64 lowercase hex characters")

digest = hashlib.sha256()
with archive.open("rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != expected:
    raise SystemExit("package archive checksum does not match protected release metadata")

if destination.exists() or destination.is_symlink():
    raise SystemExit("atomic restore destination already exists")

destination.parent.mkdir(parents=True, exist_ok=True)
staging = Path(
    tempfile.mkdtemp(prefix=".package-restore-", dir=destination.parent)
)

try:
    with tarfile.open(archive, mode="r:gz") as bundle:
        bundle.extractall(path=staging, filter="data")
    os.replace(staging, destination)
except BaseException:
    shutil.rmtree(staging, ignore_errors=True)
    raise
PY

test -x "${RESTORED_DIR}/deploy/consume-image.sh"
test -f "${RESTORED_DIR}/.dagger/runtime/package-manifest.json"
test -f "${RESTORED_DIR}/.dagger/runtime/application-image-credential-capability.json"
test -f "${RESTORED_DIR}/.dagger/application-images/providers.yaml"
```

`filter="data"` rejects archive members that escape by absolute/`..` path,
symlink or hardlink, and rejects device/FIFO entries. Extraction happens only
after checksum verification. Atomic rename prevents Deploy from observing a
partially restored tree. A checksum failure, filter exception, existing
destination, missing executable, manifest, frozen credential capability, or
provider file is a hard stop—do not fall back to unfiltered `tar -x`. Requiring
the generated capability here ensures a `v0.8.1` restore cannot silently take
the legacy provider-file fallback.

## Verify The Independently Recorded Source SHA

Before calling Dagger, compare every restored OCI artifact with the independently
recorded SHA:

```bash
MANIFEST="${RESTORED_DIR}/.dagger/runtime/package-manifest.json"
[[ ${EXPECTED_SOURCE_SHA} =~ ^[a-f0-9]{40}$ ]]

jq -e --arg sha "${EXPECTED_SOURCE_SHA}" '
  .schema_version == "rush-delivery-package-manifest/v2"
  and ([.artifacts[] | select(.kind == "oci_image")] | length > 0)
  and ([.artifacts[] | select(.kind == "oci_image") | .source_revision]
       | all(. == $sha))
  and ([.artifacts[] | select(.kind == "oci_image") | .status]
       | all(. == "published"))
' "${MANIFEST}"
```

If this fails, the bundle and protected source identity disagree. Do not edit
the manifest or change the expected SHA to make the check pass.

## Deploy The Restored Bundle

The exact standalone deploy command uses the external SHA and restored package
directory. It reads the frozen provider credential names for the projection
guard, but no registry/signing values are supplied:

```bash
dagger -m "${RUSH_DELIVERY_MODULE}" call deploy-release \
  --repo="${RESTORED_DIR}" \
  --git-sha="${EXPECTED_SOURCE_SHA}" \
  --release-targets-json='["control-plane-api"]' \
  --environment=prod \
  --dry-run=false \
  --toolchain-image-provider=off \
  --package-manifest-file="${MANIFEST}"
```

Rush Delivery re-parses the strict manifest and independently re-hashes the
selected target's SBOM, scan, and provenance before the first deploy wave. It
then mounts only that target's evidence and passes the recorded digest reference
unchanged. It does not query GHCR or rerun Cosign.

Sanitized expected output:

```text
control-plane-api accepted immutable image: ghcr.io/<owner>/rush-delivery-tutorial/control-plane-api@sha256:<digest>
```

Standalone split-stage Deploy does not update deploy tags. If tag movement is a
required control-plane signal, use the composed Git-source `workflow` or a
separate protected action after successful deployment. Never make a mutable tag
the pull identity.

## Roll Back To An Earlier Trusted Bundle

Rollback is the same verified deployment with an earlier record:

1. Select the earlier approved artifact ID, producing run, archive name,
   checksum, and original full SHA from protected history.
2. Download that exact artifact ID; do not select “latest” by name.
3. Verify the externally recorded checksum before safe, atomic extraction.
4. Verify every OCI `source_revision` equals the independently recorded earlier
   SHA.
5. Run `deploy-release` with that earlier SHA and unchanged manifest.
6. Confirm the deploy result's `artifactReference` equals the earlier
   `repository@sha256:...`; do not rebuild, edit the manifest, or resolve its
   `sha-...` navigation tag.

The same shell block and Dagger command above are the complete rollback
procedure after replacing the five protected-record inputs with the earlier
record. The target platform must still be able to pull that digest, and the old
public verification key/evidence must remain retained even though Deploy does
not rerun registry Cosign verification.

The default all-in-one Rush Delivery Action returns a workflow result; it does
not automatically retain this reusable packaged directory. A rollback that
depends on bundle evidence therefore needs the explicit stage-level export,
tarball, checksum, artifact upload, and protected record shown here.

## Retention, Retry, And Cleanup

Coordinate these lifecycles:

- retain registry subject digests and their signature/combined-attestation
  attachments for at least as long as any environment can deploy or roll them
  back;
- retain package archives, protected records, and old public keys for the same
  rollback/audit window;
- treat `sha-<source-sha>` as navigation only; tag deletion/movement must not
  delete the subject or Cosign attachments needed by retained records;
- keep target-platform pull identity valid for every retained private digest;
- make project deploy scripts idempotent before automatically retrying Deploy;
- retry pre-publication preparation after fixing inputs, but inspect registry
  state before retrying an ambiguous publication/transport or any reported
  post-publication Cosign failure;
- when a batch fails after a sibling target was published, inventory every
  reported canonical reference and apply explicit retain/delete policy to the
  subject, navigation tag, attachments, and tagged/untagged package versions.

Registry cleanup is an external destructive operation. Require a reviewed list
of exact subject, attachment-tag, and package-version targets plus retention
approval; do not delete by a broad prefix or because a successful bundle was
absent.

## Unsigned Bundle Limitation

The package manifest and portable tarball are not themselves signed in
`v0.8.1`. Their evidence file hashes detect accidental or isolated tampering,
and an independently protected archive checksum binds the complete bytes. An
actor able to replace both the artifact and its external protected record can
coordinate a replacement that these checks cannot detect. Use storage/control
planes with independent identities, versioned history, approvals, and audit
logs. Signed portable bundles and Deploy-time registry Cosign verification are
future contracts, not behavior implied by this release.

## Failure Meaning

- Artifact ID/run not found: retention expired, the wrong protected record was
  selected, or the deploy identity lacks artifact read access.
- Archive checksum mismatch: downloaded bytes do not match the approved record;
  quarantine them without extraction.
- `tarfile` filter error: a member path/link/type is unsafe; treat the archive as
  untrusted.
- Source mismatch or planned status: the archive is not the approved live
  package for this release SHA.
- Evidence hash mismatch: package bytes changed after successful Package.
- Pull failure inside a real platform script: the platform pull identity or
  registry retention is wrong; Package credentials are intentionally absent.

## Checkpoint

Record and verify this final chain:

```text
protected artifact ID + producing run
  -> downloaded archive SHA-256
  -> safely restored complete package directory
  -> manifest source_revision == independently recorded full SHA
  -> manifest/evidence integrity preflight
  -> unchanged repository@sha256 reference
  -> platform deployment result
```

The rollback checkpoint is identical except that every protected input and the
deployed digest come from the selected earlier record.

Next: return to the [OCI tutorial index](..) or use the
[OCI application-image reference](../../../oci-application-images) while
adapting this path to a real service.
