---
title: "5 - Deploy The Digest"
sidebar_label: "5 - Deploy The Digest"
---

This chapter consumes the verified package bundle. Deploy uses the manifest's
immutable digest reference and re-hashes local evidence; it does not rebuild the
image, resolve a tag, query the registry, or rerun Cosign.

## Prerequisites

- Complete [Publish And Inspect](../publish-and-inspect).
- Keep `PACKAGE_DIR`, `SOURCE_SHA`, and `RUSH_DELIVERY_MODULE` set.
- The complete package directory, manifest, and evidence must remain together.
- For a named/published OCI artifact, retain the generated
  `.dagger/runtime/application-image-credential-capability.json`. Standalone
  Deploy reads this frozen, names-only capability first to reject any project
  runtime projection of provider credentials; only an older bundle without the
  capability falls back to credential names in
  `.dagger/application-images/providers.yaml`. It never resolves or uses those
  values or performs a registry/Cosign operation. A supplied aggregate Deploy
  env file is still parsed for project-owned deployment capabilities.
- The deploy platform—not Rush Delivery's Package credentials—must be able to
  import or pull the digest when a real service is used. Cloud Run can consume
  a public GHCR reference directly; private GHCR requires a Google Artifact
  Registry remote repository with separate upstream authentication.

## The Complete Generic Deploy Script

The canonical
[`deploy/consume-image.sh`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.9.0/examples/oci-application-image-rush-repo/deploy/consume-image.sh)
is provider-neutral and consumes only framework-owned handoff values:

```bash
#!/usr/bin/env bash
set -euo pipefail

OCI_EXAMPLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${OCI_EXAMPLE_DIR}"

fail() {
	printf 'control-plane-api rejected OCI artifact: %s\n' "$1" >&2
	exit 1
}

require_artifact_value() {
	local name="$1"
	[[ -n ${!name-} ]] || fail "${name} is required"
}

for provider_name in \
	RD_OCI_GHCR_USERNAME \
	RD_OCI_GHCR_TOKEN \
	RD_OCI_COSIGN_PRIVATE_KEY \
	RD_OCI_COSIGN_PASSWORD \
	RD_OCI_COSIGN_PUBLIC_KEY; do
	[[ -z ${!provider_name+x} ]] ||
		fail "framework-owned provider environment name ${provider_name} must be absent"
done

for name in \
	ARTIFACT_KIND \
	ARTIFACT_IMAGE_NAME \
	ARTIFACT_IMAGE_REFERENCE \
	ARTIFACT_IMAGE_REPOSITORY \
	ARTIFACT_IMAGE_DIGEST \
	ARTIFACT_IMAGE_PLATFORMS_JSON \
	ARTIFACT_SOURCE_REVISION \
	ARTIFACT_EVIDENCE_DIR; do
	require_artifact_value "${name}"
done

[[ ${ARTIFACT_KIND} == oci_image ]] || fail "ARTIFACT_KIND must be oci_image"
[[ ${ARTIFACT_IMAGE_NAME} == control-plane-api ]] ||
	fail "ARTIFACT_IMAGE_NAME must match this deploy target"
[[ ${ARTIFACT_IMAGE_REPOSITORY} =~ ^[a-z0-9](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.9.0/docs/tutorial/oci-application-images/[a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?/[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] ||
	fail "ARTIFACT_IMAGE_REPOSITORY must be a normalized OCI repository"
[[ ${ARTIFACT_IMAGE_DIGEST} =~ ^sha256:[a-f0-9]{64}$ ]] ||
	fail "ARTIFACT_IMAGE_DIGEST must be a canonical sha256 digest"
[[ ${ARTIFACT_SOURCE_REVISION} =~ ^[a-f0-9]{40}$ ]] ||
	fail "ARTIFACT_SOURCE_REVISION must be a full lowercase Git SHA"
[[ ${ARTIFACT_IMAGE_PLATFORMS_JSON} == '["linux/amd64"]' ]] ||
	fail "ARTIFACT_IMAGE_PLATFORMS_JSON must match the packaged platform"
[[ ${ARTIFACT_IMAGE_REFERENCE} == "${ARTIFACT_IMAGE_REPOSITORY}@${ARTIFACT_IMAGE_DIGEST}" ]] ||
	fail "ARTIFACT_IMAGE_REFERENCE must equal repository@digest"
[[ -z ${ARTIFACT_PATH+x} ]] || fail "ARTIFACT_PATH must be absent for OCI images"
[[ ${ARTIFACT_EVIDENCE_DIR} == /* ]] ||
	fail "ARTIFACT_EVIDENCE_DIR must be an absolute path"

for evidence_file in sbom.spdx.json scan.json provenance.json; do
	[[ -f ${ARTIFACT_EVIDENCE_DIR}/${evidence_file} ]] ||
		fail "ARTIFACT_EVIDENCE_DIR is missing ${evidence_file}"
done

printf 'control-plane-api accepted immutable image: %s\n' \
	"${ARTIFACT_IMAGE_REFERENCE}"
```

Rush Delivery executes it inside the deploy target's declared runtime. The
script validates the generic contract but does not start or pull the tutorial's
`scratch` image. That image has no shell, network server, or operating-system
runtime; it is a supply-chain/handoff subject, not a deployable web service.

## Run Planned And Published Deploys

First, a provider-off planned manifest is valid only for a Deploy dry run:

```bash
dagger -m "${RUSH_DELIVERY_MODULE}" call deploy-release \
  --repo="${PLAN_DIR}" \
  --git-sha="${TUTORIAL_DRY_SHA}" \
  --release-targets-json='["control-plane-api"]' \
  --environment=prod \
  --dry-run=true \
  --toolchain-image-provider=off \
  --package-manifest-file="${PLAN_DIR}/.dagger/runtime/package-manifest.json"
```

Then execute the complete generic script against the published bundle:

```bash
dagger -m "${RUSH_DELIVERY_MODULE}" call deploy-release \
  --repo="${PACKAGE_DIR}" \
  --git-sha="${SOURCE_SHA}" \
  --release-targets-json='["control-plane-api"]' \
  --environment=prod \
  --dry-run=false \
  --toolchain-image-provider=off \
  --package-manifest-file="${PACKAGE_DIR}/.dagger/runtime/package-manifest.json"
```

Raw/standalone `deploy-release` intentionally performs deploy only and does not
move `deploy/prod/...` tags because that entrypoint has no configured tag-update
capability. The composed Git-source `workflow` supplies its explicit source-auth
token capability and updates deploy tags. In a split pipeline, use the composed
workflow when tag movement is required, or make tag movement a separate,
protected control-plane action.

Sanitized expected live output:

```text
control-plane-api accepted immutable image: ghcr.io/<owner>/rush-delivery-tutorial/control-plane-api@sha256:<64-lowercase-hex>
```

## Publication Identity Versus Pull Identity

The Package username/token writes the subject plus its digest-derived Cosign
signature/attestation attachments. Those credentials never reach Deploy.
`ARTIFACT_IMAGE_REFERENCE` identifies the published subject
but grants no access to it. Kubernetes image-pull credentials, Swarm node
credentials, or the equivalent platform control plane must independently
receive least-privilege access to the private repository. Cloud Run is a
special case: it imports public GHCR images directly, but private GHCR images
must be exposed through an authenticated Artifact Registry remote repository.
The Cloud Run service identity selected with `--service-account` is the
application's runtime identity; it is not the upstream image-import identity.
Public GHCR packages do not need private pull credentials, but their visibility
is a separate registry policy decision. The SPDX and provenance attestations
are stored with the image and can disclose dependency inventory, source URI,
and build parameters; classify those predicates before making the package
public.

## Framework Runtime Variables

Rush Delivery reserves the entire `ARTIFACT_*` namespace, including future
names, plus `GIT_SHA` and `DRY_RUN`. Deploy `runtime.env`, `pass_env`, `map_env`,
`dry_run_defaults`, `required_host_env`, and host-path source variables must not
write or repurpose them—even with the same value.

| Variable                        | Planned OCI dry run                                     | Published OCI live/dry run                             |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| `ARTIFACT_KIND`                 | `oci_image`                                             | `oci_image`                                            |
| `ARTIFACT_IMAGE_NAME`           | package `image` suffix                                  | package `image` suffix                                 |
| `ARTIFACT_IMAGE_PLATFORMS_JSON` | one-platform JSON array                                 | one-platform JSON array                                |
| `ARTIFACT_SOURCE_REVISION`      | full manifest SHA                                       | full manifest SHA                                      |
| `ARTIFACT_IMAGE_REPOSITORY`     | absent with provider `off`; present with named provider | normalized registry repository                         |
| `ARTIFACT_IMAGE_DIGEST`         | absent                                                  | lowercase `sha256:...`                                 |
| `ARTIFACT_IMAGE_REFERENCE`      | absent                                                  | exact `repository@sha256:...`                          |
| `ARTIFACT_EVIDENCE_DIR`         | absent                                                  | `/workspace/.dagger/runtime/evidence/<target>`         |
| `ARTIFACT_PATH`                 | always absent for OCI                                   | always absent for OCI                                  |
| `GIT_SHA`                       | invocation SHA                                          | invocation SHA, preflight-matched to `source_revision` |
| `DRY_RUN`                       | `1`                                                     | `0` live, `1` dry run                                  |

The generic workspace excludes all framework evidence. After global integrity
preflight, Rush Delivery mounts only the current published target's evidence at
`ARTIFACT_EVIDENCE_DIR`; sibling targets and filesystem targets do not receive
it.

## Complete Deploy Result Examples

These are complete sanitized objects that satisfy the public deploy-result
contract. `output` contains the deploy script/dry-run summary, not a hidden
filesystem artifact path.

Planned dry run:

```json
{
  "dryRun": true,
  "environment": "prod",
  "plan": {
    "selectedTargets": ["control-plane-api"],
    "waves": [[{ "target": "control-plane-api" }]]
  },
  "results": [
    {
      "artifactImage": "control-plane-api",
      "artifactKind": "oci_image",
      "output": "[deploy-release] dry-run target=control-plane-api wave=1\nenvironment=prod\ngitSha=0123456789abcdef0123456789abcdef01234567\ndeploy_tag=deploy/prod/control-plane-api\ndeploy_script=deploy/consume-image.sh\npackage_artifact_kind=oci_image\npackage_artifact_status=planned\npackage_artifact_image=control-plane-api\npackage_artifact_platforms=[\"linux/amd64\"]\npackage_artifact_publication=no-image-or-digest-produced-dry-run\nimage=node:24-bookworm-slim\nenv:\n  - ARTIFACT_IMAGE_NAME=control-plane-api\n  - ARTIFACT_IMAGE_PLATFORMS_JSON=[\"linux/amd64\"]\n  - ARTIFACT_KIND=oci_image\n  - ARTIFACT_SOURCE_REVISION=0123456789abcdef0123456789abcdef01234567\n  - DRY_RUN=1\n  - GIT_SHA=0123456789abcdef0123456789abcdef01234567\nworkspace:\n  mode=partial\n  file=deploy/consume-image.sh\n",
      "status": "success",
      "target": "control-plane-api",
      "wave": 1
    }
  ]
}
```

Published live run:

```json
{
  "dryRun": false,
  "environment": "prod",
  "plan": {
    "selectedTargets": ["control-plane-api"],
    "waves": [[{ "target": "control-plane-api" }]]
  },
  "results": [
    {
      "artifactImage": "control-plane-api",
      "artifactKind": "oci_image",
      "artifactReference": "ghcr.io/acme/rush-delivery-tutorial/control-plane-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "output": "control-plane-api accepted immutable image: ghcr.io/acme/rush-delivery-tutorial/control-plane-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      "status": "success",
      "target": "control-plane-api",
      "wave": 1
    }
  ]
}
```

`artifactReference` is optional because planned dry-run results do not invent a
published identity. `artifactImage` and `artifactKind` are always present for
OCI results. `artifactPath` belongs only to filesystem results and is never
fabricated for OCI.

## Platform-Specific Excerpts

The next commands are excerpts, not runnable against the tutorial's non-service
`scratch` subject. Adapt service names, runtime configuration, and pull identity
only after replacing the Dockerfile with a real application. Kubernetes and
Swarm pass the verified reference unchanged. Cloud Run can do the same for a
public GHCR package; a private GHCR package uses a deterministic Artifact
Registry remote-repository coordinate while preserving the verified digest.

Cloud Run excerpt for a **public** GHCR package:

```bash
gcloud run deploy "${CLOUD_RUN_SERVICE}" \
  --image="${ARTIFACT_IMAGE_REFERENCE}" \
  --region="${CLOUD_RUN_REGION}" \
  --service-account="${CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT}"
```

For a **private** GHCR package, first provision a Docker-format Artifact
Registry remote repository whose immutable upstream is `https://ghcr.io`,
configure its upstream username/token through Secret Manager, and grant the
Cloud Run deployment control plane access to that repository. Then map only the
registry coordinate and retain the manifest digest:

```bash
: "${CLOUD_RUN_GHCR_REMOTE_PREFIX:?expected LOCATION-docker.pkg.dev/PROJECT/REMOTE_REPOSITORY}"

case "${ARTIFACT_IMAGE_REPOSITORY}" in
  ghcr.io/*) upstream_image="${ARTIFACT_IMAGE_REPOSITORY#ghcr.io/}" ;;
  *) printf 'expected a ghcr.io artifact repository\n' >&2; exit 1 ;;
esac

CLOUD_RUN_IMAGE_REFERENCE="${CLOUD_RUN_GHCR_REMOTE_PREFIX}/${upstream_image}@${ARTIFACT_IMAGE_DIGEST}"
gcloud run deploy "${CLOUD_RUN_SERVICE}" \
  --image="${CLOUD_RUN_IMAGE_REFERENCE}" \
  --region="${CLOUD_RUN_REGION}" \
  --service-account="${CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT}"
```

Google documents both the
[Cloud Run registry restrictions and private-GHCR remote-repository path](https://docs.cloud.google.com/run/docs/deploying)
and the exact
[Artifact Registry GHCR digest coordinate](https://docs.cloud.google.com/artifact-registry/docs/docker/pushing-and-pulling).
Provision and test that mapping before production; do not replace the digest
with a tag. The `--service-account` value controls the running application's
Google API identity, as described by
[Cloud Run service identity](https://docs.cloud.google.com/run/docs/securing/service-identity),
not Artifact Registry's authentication to GHCR.

Kubernetes excerpt:

```bash
kubectl --namespace="${KUBE_NAMESPACE}" set image \
  deployment/"${KUBE_DEPLOYMENT}" \
  app="${ARTIFACT_IMAGE_REFERENCE}"
kubectl --namespace="${KUBE_NAMESPACE}" rollout status \
  deployment/"${KUBE_DEPLOYMENT}"
```

Docker Swarm excerpt:

```bash
set -euo pipefail

: "${SWARM_PULL_USERNAME:?dedicated pull-only registry username is required}"
: "${SWARM_PULL_TOKEN:?dedicated pull-only registry token is required}"
SWARM_REGISTRY="${ARTIFACT_IMAGE_REPOSITORY%%/*}"
SWARM_DOCKER_CONFIG="$(mktemp -d "${TMPDIR:-/tmp}/rush-delivery-swarm-auth.XXXXXX")"
chmod 0700 "${SWARM_DOCKER_CONFIG}"
trap 'find "${SWARM_DOCKER_CONFIG}" -depth -delete' EXIT

printf '%s' "${SWARM_PULL_TOKEN}" | \
  DOCKER_CONFIG="${SWARM_DOCKER_CONFIG}" docker login \
    --username "${SWARM_PULL_USERNAME}" \
    --password-stdin \
    "${SWARM_REGISTRY}"
unset SWARM_PULL_TOKEN

DOCKER_CONFIG="${SWARM_DOCKER_CONFIG}" docker service update \
  --image="${ARTIFACT_IMAGE_REFERENCE}" \
  --with-registry-auth \
  "${SWARM_SERVICE}"
```

The Docker CLI in the Swarm excerpt is a deploy-platform requirement, not an
OCI Package requirement. It may require a socket in that specific deploy
runtime; Cloud Run/Kubernetes integrations do not inherit that requirement.
Docker documents that `--with-registry-auth` sends registry authentication to
Swarm agents, so the isolated login must use a distinct pull-only identity,
never the Package publisher token. The temporary Docker configuration is
removed on exit. See Docker's
[`service update` reference](https://docs.docker.com/reference/cli/docker/service/update/)
and
[Swarm service authentication guidance](https://docs.docker.com/engine/swarm/services/).

## Safe Failure Exercises

Run these only against disposable copies below `${TMPDIR:-/tmp}`. They use no
provider credentials and fail before a live deploy script starts.

```bash
set -euo pipefail

FAILURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rush-delivery-oci-failures.XXXXXX")"
cp -a "${PACKAGE_DIR}" "${FAILURE_ROOT}/source-mismatch"
cp -a "${PACKAGE_DIR}" "${FAILURE_ROOT}/mutable-reference"
cp -a "${PACKAGE_DIR}" "${FAILURE_ROOT}/missing-evidence"
cp -a "${PACKAGE_DIR}" "${FAILURE_ROOT}/modified-evidence"

expect_deploy_failure() {
  local repo="$1"
  local sha="$2"
  if dagger -m "${RUSH_DELIVERY_MODULE}" call deploy-release \
    --repo="${repo}" \
    --git-sha="${sha}" \
    --release-targets-json='["control-plane-api"]' \
    --environment=prod \
    --dry-run=false \
    --toolchain-image-provider=off \
    --package-manifest-file="${repo}/.dagger/runtime/package-manifest.json"
  then
    printf 'expected deploy failure for %s\n' "${repo}" >&2
    return 1
  fi
}

# Source mismatch.
expect_deploy_failure \
  "${FAILURE_ROOT}/source-mismatch" \
  ffffffffffffffffffffffffffffffffffffffff

# Planned artifact used for a live deploy.
expect_deploy_failure "${PLAN_DIR}" "${TUTORIAL_DRY_SHA}"

# Mutable reference rejected by strict manifest parsing.
MUTABLE_MANIFEST="${FAILURE_ROOT}/mutable-reference/.dagger/runtime/package-manifest.json"
jq '.artifacts["control-plane-api"].reference =
      "ghcr.io/acme/rush-delivery-tutorial/control-plane-api:latest"' \
  "${MUTABLE_MANIFEST}" > "${MUTABLE_MANIFEST}.new"
mv "${MUTABLE_MANIFEST}.new" "${MUTABLE_MANIFEST}"
expect_deploy_failure "${FAILURE_ROOT}/mutable-reference" "${SOURCE_SHA}"

# Missing local evidence.
mv \
  "${FAILURE_ROOT}/missing-evidence/.dagger/runtime/evidence/control-plane-api/scan.json" \
  "${FAILURE_ROOT}/missing-evidence/scan.json.missing"
expect_deploy_failure "${FAILURE_ROOT}/missing-evidence" "${SOURCE_SHA}"

# Evidence whose bytes no longer match the manifest digest.
printf '\n' >> \
  "${FAILURE_ROOT}/modified-evidence/.dagger/runtime/evidence/control-plane-api/scan.json"
expect_deploy_failure "${FAILURE_ROOT}/modified-evidence" "${SOURCE_SHA}"
```

Expected diagnostic meanings:

- source mismatch: invocation `gitSha` does not equal the artifact's
  `source_revision`;
- planned-live: live Deploy requires `status: published`;
- mutable reference: published references must be lowercase digest references;
- missing evidence: the target-owned evidence path is unreadable;
- evidence hash: bytes changed after Package and no longer match the manifest.

Do not “repair” these failures by editing the unsigned manifest. Restore the
trusted package bundle and independently recorded SHA/checksum instead.

## Checkpoint

```bash
REFERENCE="$(jq -r '.artifacts["control-plane-api"].reference' \
  "${PACKAGE_DIR}/.dagger/runtime/package-manifest.json")"
[[ ${REFERENCE} == *@sha256:* ]]
[[ ${REFERENCE} != *:latest ]]
```

The successful live `deploy-release` result must contain exactly `REFERENCE` as
`artifactReference`.

Next: [GitHub Actions](../github-actions).
