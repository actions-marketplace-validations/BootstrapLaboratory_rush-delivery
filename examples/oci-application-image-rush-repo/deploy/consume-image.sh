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
[[ ${ARTIFACT_IMAGE_REPOSITORY} =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?/[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] ||
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
