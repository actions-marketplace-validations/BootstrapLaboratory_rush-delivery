#!/usr/bin/env bash
set -euo pipefail

OCI_ACCEPTANCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OCI_ACCEPTANCE_REPO_ROOT="$(cd -- "${OCI_ACCEPTANCE_DIR}/../.." && pwd)"
OCI_ACCEPTANCE_FIXTURE="${OCI_ACCEPTANCE_REPO_ROOT}/test/fixtures/oci-rush-repo"
OCI_ACCEPTANCE_COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849"
OCI_ACCEPTANCE_GIT_SHA="0123456789abcdef0123456789abcdef01234567"
OCI_ACCEPTANCE_SIGNING_PASSWORD="rush-delivery-acceptance-password"
OCI_ACCEPTANCE_SENTINEL_TOKEN="SENTINEL_OCI_TOKEN_4ca2d91f"
OCI_ACCEPTANCE_TEMP="$(mktemp -d -t rush-delivery-oci-acceptance.XXXXXX)"
OCI_ACCEPTANCE_KEY_CONTAINER="rush-delivery-oci-key-${RANDOM}${RANDOM}"

cleanup() {
	if [[ -n ${OCI_ACCEPTANCE_KEY_CONTAINER-} ]]; then
		docker rm -f "${OCI_ACCEPTANCE_KEY_CONTAINER}" >/dev/null 2>&1 || true
	fi
	if [[ -n ${OCI_ACCEPTANCE_TEMP-} && ${OCI_ACCEPTANCE_TEMP} == /tmp/rush-delivery-oci-acceptance.* ]]; then
		rm -rf -- "${OCI_ACCEPTANCE_TEMP}"
	fi
}
trap cleanup EXIT

docker create \
	--name "${OCI_ACCEPTANCE_KEY_CONTAINER}" \
	--env "COSIGN_PASSWORD=${OCI_ACCEPTANCE_SIGNING_PASSWORD}" \
	--entrypoint /ko-app/cosign \
	"${OCI_ACCEPTANCE_COSIGN_IMAGE}" \
	generate-key-pair --output-key-prefix /tmp/cosign >/dev/null
docker start "${OCI_ACCEPTANCE_KEY_CONTAINER}" >/dev/null
docker wait "${OCI_ACCEPTANCE_KEY_CONTAINER}" >/dev/null
docker cp "${OCI_ACCEPTANCE_KEY_CONTAINER}:/tmp/cosign.key" "${OCI_ACCEPTANCE_TEMP}/cosign.key"
docker cp "${OCI_ACCEPTANCE_KEY_CONTAINER}:/tmp/cosign.pub" "${OCI_ACCEPTANCE_TEMP}/cosign.pub"
docker rm "${OCI_ACCEPTANCE_KEY_CONTAINER}" >/dev/null
OCI_ACCEPTANCE_KEY_CONTAINER=""

private_key="$(awk '{printf "%s\\n", $0}' "${OCI_ACCEPTANCE_TEMP}/cosign.key")"
public_key="$(awk '{printf "%s\\n", $0}' "${OCI_ACCEPTANCE_TEMP}/cosign.pub")"
deploy_env="${OCI_ACCEPTANCE_TEMP}/deploy.env"
{
	printf 'OCI_USERNAME=anonymous\n'
	printf 'OCI_TOKEN=%s\n' "${OCI_ACCEPTANCE_SENTINEL_TOKEN}"
	printf 'OCI_SIGNING_KEY=%s\n' "${private_key}"
	printf 'OCI_SIGNING_PASSWORD=%s\n' "${OCI_ACCEPTANCE_SIGNING_PASSWORD}"
	printf 'OCI_SIGNING_PUBLIC_KEY=%s\n' "${public_key}"
} >"${deploy_env}"

output_directory="${OCI_ACCEPTANCE_TEMP}/output"
DAGGER_NO_NAG=1 dagger call package-deploy-targets \
	--repo="${OCI_ACCEPTANCE_FIXTURE}" \
	--ci-plan-file="${OCI_ACCEPTANCE_FIXTURE}/.dagger/runtime/ci-plan.json" \
	--git-sha="${OCI_ACCEPTANCE_GIT_SHA}" \
	--source-repository-url="https://github.com/BootstrapLaboratory/rush-delivery.git" \
	--dry-run=false \
	--deploy-env-file="${deploy_env}" \
	--application-image-provider=acceptance \
	export --path="${output_directory}"

node "${OCI_ACCEPTANCE_DIR}/verify-oci-acceptance.mjs" \
	"${output_directory}" \
	"${OCI_ACCEPTANCE_GIT_SHA}" \
	"${OCI_ACCEPTANCE_SENTINEL_TOKEN}" \
	"${OCI_ACCEPTANCE_SIGNING_PASSWORD}"
