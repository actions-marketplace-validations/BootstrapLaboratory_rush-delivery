---
title: "4 - Publish And Inspect"
sidebar_label: "4 - Publish And Inspect"
---

This chapter runs the first live side effect: one image publication followed by
Cosign signature/attestation writes and verification. It exports the complete
packaged directory only after every selected target succeeds.

## Prerequisites

- Complete [Registry And Cosign Bootstrap](../registry-and-cosign-bootstrap).
- `.dagger/application-images/providers.yaml` contains your literal lowercase
  GHCR owner, not `example`.
- `OCI_SECRET_DIR/deploy.env` contains all five selected provider values as
  single physical lines; PEMs contain literal `\n` pairs.
- The GHCR token can push the subject and write Cosign's digest-derived `.sig`
  and `.att` attachment artifacts.
- The source tree and source URL represent a trusted release revision.

Commit the provider coordinate so the live SHA identifies the exact inputs:

```bash
set -euo pipefail

git add .dagger/application-images/providers.yaml
if ! git diff --cached --quiet; then
  git commit -m "chore: configure tutorial GHCR namespace"
fi

export SOURCE_SHA="$(git rev-parse HEAD)"
test "${#SOURCE_SHA}" -eq 40
test "$(git status --porcelain)" = ""

IFS= read -r -p 'Trusted source repository URL (https://...git): ' \
  SOURCE_REPOSITORY_URL
[[ ${SOURCE_REPOSITORY_URL} == https://*.git ]]
[[ ${SOURCE_REPOSITORY_URL} != *[[:space:]]* ]]
node -e '
const url = new URL(process.argv[1]);
if (
  url.protocol !== "https:" ||
  !url.hostname ||
  !url.pathname.endsWith(".git") ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
) process.exit(1);
' "${SOURCE_REPOSITORY_URL}"

export DEPLOY_ENV_FILE="${OCI_SECRET_DIR}/deploy.env"
test -f "${DEPLOY_ENV_FILE}"
test "$(stat -c '%a' "${DEPLOY_ENV_FILE}")" = 600
```

If the provider file is already committed, the conditional skips the commit;
the clean-status assertion is still mandatory. On non-GNU systems, replace the
`stat` check with the platform's equivalent and require owner-only read/write
permissions.

## Primary Live Flow From A Clean Checkout

Use `build-and-package-deploy-targets` from a clean checkout. It carries the
normal Rush build output into Package inside Dagger, then exports the final
workspace once:

```bash
export PACKAGE_DIR="${TMPDIR:-/tmp}/rush-delivery-oci-package-${SOURCE_SHA}"
test ! -e "${PACKAGE_DIR}"

dagger -m "${RUSH_DELIVERY_MODULE}" call \
  build-and-package-deploy-targets \
  --repo=. \
  --ci-plan-file=ci/oci-plan.json \
  --artifact-prefix=deploy-target \
  --deploy-env-file="${DEPLOY_ENV_FILE}" \
  --dry-run=false \
  --git-sha="${SOURCE_SHA}" \
  --source-repository-url="${SOURCE_REPOSITORY_URL}" \
  --application-image-provider=ghcr \
  export --path="${PACKAGE_DIR}"
```

The observable ordering is deliberate:

1. select and validate provider metadata plus protected credential names before
   project-controlled Build, without reading credential values;
2. run the normal Rush Build;
3. when Package starts, resolve only the selected provider's live values into
   framework-owned Dagger secrets, then materialize every selected filesystem
   package validation/command without projecting those secrets;
4. cryptographically preflight the provider key pair;
5. prepare every OCI Docker build, SPDX SBOM, and Grype policy result;
6. only after both filesystem and OCI preparation succeed, publish targets one
   at a time in stable selected-target order;
7. for each published digest, sign, attach SPDX and provenance attestations,
   verify all three, and create local evidence records;
8. write the successful manifest only after the batch finishes.

Preparation can run concurrently. Publication is ordered and nontransactional.
If a post-publish Cosign step fails, Rush Delivery reports the canonical digest
that may remain, writes no successful manifest, and does not start Deploy.

Rush Delivery pins `--new-bundle-format=false` on the six registry Cosign
commands. With the pinned Cosign `3.1.2`, one `.sig` attachment stores the
signature and one shared `.att` image stores both attestation predicates. The
OCI 1.1 Referrers API is not used. GHCR may retain an untagged superseded `.att`
version after the second attestation write, so package-version counts can exceed
the two current attachments. The three real Cosign verification commands—not a
UI count—prove completeness.

Sanitized expected output:

```text
## Build and package deploy targets
... Rush Build ...
[package] control-plane-api: oci_image
... Cosign provider preflight ...
... Docker image build / SPDX / Grype preparation ...
... registry publication / sign / attest / verify ...
Directory exported to /tmp/rush-delivery-oci-package-<sha>
```

Logs and wording can vary with Dagger progress output. They must not contain the
registry token, signing password, private PEM, or generated Docker auth JSON.

## Standalone Package Requires A Restored Build

Use `package-deploy-targets` only after exporting and restoring the complete
built directory. The following is the supported split, not an alternative that
skips Build:

The restored built directory is a trusted Package input. Standalone Package
freezes the provider credential names present at this point; it cannot recover
the pre-Build boundary if an independently run Build changed provider or Deploy
metadata. Keep the Build output immutable and access-controlled, or prefer
`build-and-package-deploy-targets`, which captures that boundary before Build.

```bash
BUILT_DIR="${TMPDIR:-/tmp}/rush-delivery-oci-built-${SOURCE_SHA}"
STANDALONE_PACKAGE_DIR="${TMPDIR:-/tmp}/rush-delivery-oci-standalone-${SOURCE_SHA}"
test ! -e "${BUILT_DIR}"
test ! -e "${STANDALONE_PACKAGE_DIR}"

dagger -m "${RUSH_DELIVERY_MODULE}" call build-deploy-targets \
  --repo=. \
  --ci-plan-file=ci/oci-plan.json \
  --dry-run=false \
  export --path="${BUILT_DIR}"

test -f "${BUILT_DIR}/apps/control-plane-api/dist/payload.txt"

dagger -m "${RUSH_DELIVERY_MODULE}" call package-deploy-targets \
  --repo="${BUILT_DIR}" \
  --ci-plan-file="${BUILT_DIR}/ci/oci-plan.json" \
  --artifact-prefix=deploy-target \
  --git-sha="${SOURCE_SHA}" \
  --source-repository-url="${SOURCE_REPOSITORY_URL}" \
  --dry-run=false \
  --deploy-env-file="${DEPLOY_ENV_FILE}" \
  --application-image-provider=ghcr \
  export --path="${STANDALONE_PACKAGE_DIR}"
```

Running the second command against the original clean checkout should fail its
Docker build because `dist/payload.txt` is intentionally generated. That failure
means the split-stage handoff lost build output.

## Inspect The Export

```bash
find "${PACKAGE_DIR}/.dagger/runtime" -type f -print | LC_ALL=C sort
jq . "${PACKAGE_DIR}/.dagger/runtime/package-manifest.json"

jq -e \
  '.artifacts["control-plane-api"].reference
   | test("@sha256:[a-f0-9]{64}$")' \
  "${PACKAGE_DIR}/.dagger/runtime/package-manifest.json"

jq -e \
  '.artifacts["control-plane-api"]
   | .status == "published"
     and .evidence.signature.verified == true
     and .digest == .evidence.sbom.subject_digest
     and .digest == .evidence.provenance.subject_digest' \
  "${PACKAGE_DIR}/.dagger/runtime/package-manifest.json"
```

Sanitized expected file list:

```text
.../.dagger/runtime/application-image-credential-capability.json
.../.dagger/runtime/evidence/control-plane-api/provenance.json
.../.dagger/runtime/evidence/control-plane-api/sbom.spdx.json
.../.dagger/runtime/evidence/control-plane-api/scan.json
.../.dagger/runtime/package-manifest.json
```

The internal capability contains only provider, credential-field, and
environment-variable names frozen by Package. Keep it with the complete bundle;
do not edit or selectively copy it.

Prove that secret values are absent without putting them in process arguments or
printing a match. The public GHCR owner is expected in repository coordinates,
and the authentication username is non-secret and may equal that owner, so this
check covers the token, encrypted private PEM, password, and public PEM instead:

```bash
python3 - \
  "${PACKAGE_DIR}" \
  "${OCI_SECRET_DIR}/ghcr-token.txt" \
  "${OCI_SECRET_DIR}/cosign.key" \
  "${OCI_SECRET_DIR}/cosign.key.flat" \
  "${OCI_SECRET_DIR}/cosign-password.txt" \
  "${OCI_SECRET_DIR}/cosign.pub" \
  "${OCI_SECRET_DIR}/cosign.pub.flat" <<'PY'
from pathlib import Path
import sys

bundle = Path(sys.argv[1])
sentinels = [Path(name).read_bytes() for name in sys.argv[2:]]
sentinels = [value for value in sentinels if value]

for path in bundle.rglob("*"):
    if not path.is_file():
        continue
    contents = path.read_bytes()
    if any(value in contents for value in sentinels):
        raise SystemExit(f"credential material found in bundle file: {path}")
PY
```

Any hit is a release-blocking credential leak. Quarantine the bundle, rotate
exposed values, and investigate before retrying.

## Complete Manifest Examples

These are complete, sanitized, schema-valid examples. They use synthetic values
and are not excerpts from your publication.

### Provider-off planned manifest

```json
{
  "schema_version": "rush-delivery-package-manifest/v2",
  "artifacts": {
    "control-plane-api": {
      "image": "control-plane-api",
      "kind": "oci_image",
      "platforms": ["linux/amd64"],
      "source_revision": "0123456789abcdef0123456789abcdef01234567",
      "status": "planned"
    }
  }
}
```

### Published manifest

```json
{
  "schema_version": "rush-delivery-package-manifest/v2",
  "artifacts": {
    "control-plane-api": {
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "evidence": {
        "provenance": {
          "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "format": "slsa-provenance-v1",
          "path": ".dagger/runtime/evidence/control-plane-api/provenance.json",
          "subject_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "sbom": {
          "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "format": "spdx-json",
          "path": ".dagger/runtime/evidence/control-plane-api/sbom.spdx.json",
          "subject_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "scan": {
          "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "path": ".dagger/runtime/evidence/control-plane-api/scan.json",
          "policy": ["high", "critical"],
          "result": "passed",
          "scanner": "grype-0.116.1"
        },
        "signature": {
          "kind": "sigstore",
          "reference": "ghcr.io/acme/rush-delivery-tutorial/control-plane-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "verified": true
        }
      },
      "image": "control-plane-api",
      "kind": "oci_image",
      "platforms": ["linux/amd64"],
      "reference": "ghcr.io/acme/rush-delivery-tutorial/control-plane-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "repository": "ghcr.io/acme/rush-delivery-tutorial/control-plane-api",
      "source_revision": "0123456789abcdef0123456789abcdef01234567",
      "status": "published"
    }
  }
}
```

### Mixed v2 manifest

```json
{
  "schema_version": "rush-delivery-package-manifest/v2",
  "artifacts": {
    "control-plane-api": {
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "evidence": {
        "provenance": {
          "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "format": "slsa-provenance-v1",
          "path": ".dagger/runtime/evidence/control-plane-api/provenance.json",
          "subject_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "sbom": {
          "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "format": "spdx-json",
          "path": ".dagger/runtime/evidence/control-plane-api/sbom.spdx.json",
          "subject_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        },
        "scan": {
          "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "path": ".dagger/runtime/evidence/control-plane-api/scan.json",
          "policy": ["high", "critical"],
          "result": "passed",
          "scanner": "grype-0.116.1"
        },
        "signature": {
          "kind": "sigstore",
          "reference": "ghcr.io/acme/rush-delivery-tutorial/control-plane-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "verified": true
        }
      },
      "image": "control-plane-api",
      "kind": "oci_image",
      "platforms": ["linux/amd64"],
      "reference": "ghcr.io/acme/rush-delivery-tutorial/control-plane-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "repository": "ghcr.io/acme/rush-delivery-tutorial/control-plane-api",
      "source_revision": "0123456789abcdef0123456789abcdef01234567",
      "status": "published"
    },
    "webapp": {
      "deploy_path": "apps/webapp/dist",
      "kind": "directory",
      "path": "apps/webapp/dist"
    }
  }
}
```

For an OCI artifact:

- `repository` is the normalized registry path, without tag or digest;
- `reference` is the only deployment identity and equals
  `repository@sha256:...`;
- `digest` is the image manifest digest returned by the registry;
- `source_revision` is the full source SHA used for the image label and Deploy
  preflight;
- `platforms` contains the one selected platform;
- document `digest` values hash the local evidence files, while each
  `subject_digest` binds SBOM/provenance to the image digest;
- scan evidence records the exact rejected-severity set and local Grype result;
- `signature.reference` repeats the verified digest-bound subject, and
  `verified: true` records successful Package-time key-backed verification.

Rush Delivery also pushes the navigation tag `sha-<full-source-sha>` during the
single publication call, but does not record or deploy that tag. The canonical
manifest reference remains digest-only. The signature is stored in the
digest-derived `.sig` attachment, while the SPDX and provenance predicates share
the current `.att` attachment. The local Grype report is evidence only and is
not presented as a registry scan attestation.

## Evidence Excerpts

The next blocks are meaningful sanitized fragments, not complete documents and
not schema examples.

SPDX 2.3 fragment:

```json
{
  "spdxVersion": "SPDX-2.3",
  "SPDXID": "SPDXRef-DOCUMENT",
  "dataLicense": "CC0-1.0",
  "name": "oci-dir:...",
  "packages": [
    { "SPDXID": "SPDXRef-DocumentRoot-File-payload.txt", "name": "payload.txt" }
  ]
}
```

Grype fragment for the minimal `scratch` subject:

```json
{
  "matches": [],
  "descriptor": { "name": "grype", "version": "0.116.1" }
}
```

SLSA provenance fragment:

```json
{
  "buildDefinition": {
    "externalParameters": {
      "context": "apps/control-plane-api",
      "dockerfile": "apps/control-plane-api/Dockerfile",
      "image": "control-plane-api",
      "platform": "linux/amd64"
    },
    "resolvedDependencies": [
      {
        "digest": { "gitCommit": "0123456789abcdef0123456789abcdef01234567" },
        "uri": "https://github.com/acme/control-plane.git"
      }
    ]
  }
}
```

## Failure Meaning

- A key-preflight failure names only the provider and failed credential role;
  fix the PEM/password/key-pair before retrying.
- A Docker, SPDX, Grype, or filesystem-package preparation failure occurs before
  every OCI publish in the batch.
- A registry publication failure means no successful manifest exists; inspect
  registry state before retrying because transport failure can be ambiguous.
- A sign/attest/verify failure names the already-published canonical reference;
  clean or retain it according to policy before a deliberate retry.
- A missing export means Dagger did not produce the trusted package bundle even
  if a registry side effect may have occurred.

## Checkpoint

```bash
MANIFEST="${PACKAGE_DIR}/.dagger/runtime/package-manifest.json"
jq -e --arg sha "${SOURCE_SHA}" \
  '.schema_version == "rush-delivery-package-manifest/v2"
   and .artifacts["control-plane-api"].status == "published"
   and .artifacts["control-plane-api"].source_revision == $sha
   and (.artifacts["control-plane-api"].reference
        | test("@sha256:[a-f0-9]{64}$"))' \
  "${MANIFEST}"

test -f "${PACKAGE_DIR}/.dagger/runtime/evidence/control-plane-api/sbom.spdx.json"
test -f "${PACKAGE_DIR}/.dagger/runtime/evidence/control-plane-api/scan.json"
test -f "${PACKAGE_DIR}/.dagger/runtime/evidence/control-plane-api/provenance.json"
```

Every command must exit zero before the bundle is eligible for Deploy.

Next: [Deploy The Digest](../deploy-the-digest).
