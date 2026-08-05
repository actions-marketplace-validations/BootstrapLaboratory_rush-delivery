#!/usr/bin/env bash
set -euo pipefail

OCI_V081_GHCR_INVENTORY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OCI_V081_GHCR_INVENTORY_LIB="${OCI_V081_GHCR_INVENTORY_DIR}/lib/oci-v081-ghcr-acceptance.sh"
OCI_V081_GHCR_INVENTORY_TOOL="${OCI_V081_GHCR_INVENTORY_DIR}/ghcr-v081-acceptance-evidence.mjs"
OCI_V081_GHCR_COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849"
OCI_V081_GHCR_TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
OCI_V081_GHCR_TEMP=""

# shellcheck source=test/scripts/lib/oci-v081-ghcr-acceptance.sh
source "${OCI_V081_GHCR_INVENTORY_LIB}"

cleanup_inventory() {
	local original_status=$?

	trap - EXIT
	if [[ -n ${OCI_V081_GHCR_TEMP} ]]; then
		if [[ ${OCI_V081_GHCR_TEMP} != "${OCI_V081_GHCR_TEMP_ROOT%/}/rush-delivery-v081-ghcr-inventory."* ]]; then
			printf 'v0.8.1 GHCR inventory refused an unsafe cleanup target\n' >&2
			exit 1
		fi
		find "${OCI_V081_GHCR_TEMP}" -depth -delete
	fi
	exit "${original_status}"
}

verify_reference() {
	local reference="$1"
	local docker_config_file="$2"
	local public_key_file="$3"
	local verification_log="$4"
	local attempt

	[[ ${reference} =~ ^ghcr\.io/bootstraplaboratory/[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$ ]] || {
		printf 'v0.8.1 GHCR inventory rejected a verification reference\n' >&2
		return 1
	}
	[[ ${docker_config_file} =~ ^/[A-Za-z0-9_./-]+$ &&
		${public_key_file} =~ ^/[A-Za-z0-9_./-]+$ ]] || {
		printf 'v0.8.1 GHCR inventory rejected a protected file path\n' >&2
		return 1
	}
	for attempt in 1 2 3; do
		if DAGGER_NO_NAG=1 dagger --silent -c \
			"container | from ${OCI_V081_GHCR_COSIGN_IMAGE} | with-env-variable DOCKER_CONFIG /home/nonroot/.docker | with-mounted-secret /home/nonroot/.docker/config.json \$(secret file://${docker_config_file}) --mode=256 --owner=65532:65532 | with-mounted-secret /keys/cosign.pub \$(secret file://${public_key_file}) --mode=256 --owner=65532:65532 | with-exec --args=/ko-app/cosign,verify,--key,/keys/cosign.pub,--insecure-ignore-tlog,${reference} | with-exec --args=/ko-app/cosign,verify-attestation,--key,/keys/cosign.pub,--insecure-ignore-tlog,--type,spdxjson,${reference} | with-exec --args=/ko-app/cosign,verify-attestation,--key,/keys/cosign.pub,--insecure-ignore-tlog,--type,slsaprovenance1,${reference} | sync" \
			>"${verification_log}" 2>&1; then
			find "${verification_log}" -maxdepth 0 -type f -delete
			return 0
		fi
		find "${verification_log}" -maxdepth 0 -type f -delete
		if ((attempt < 3)); then
			sleep 2
		fi
	done
	printf 'v0.8.1 GHCR independent signature or attestation verification failed\n' >&2
	return 1
}

delete_regular_file_if_present() {
	local candidate="$1"

	if [[ -e ${candidate} || -L ${candidate} ]]; then
		[[ -f ${candidate} && ! -L ${candidate} ]] || {
			printf 'v0.8.1 GHCR inventory refused a non-regular scratch file\n' >&2
			return 1
		}
		find "${candidate}" -maxdepth 0 -type f -delete
	fi
}

[[ $# -eq 5 ]] || {
	printf 'Usage: %s ASSERTION REGISTRY REPOSITORY_PREFIX TARGETS_CSV EVIDENCE_FILE\n' "$0" >&2
	exit 1
}

assertion="$1"
registry="$2"
repository_prefix="$3"
targets_csv="$4"
evidence_file="$5"
deploy_env_file="${OCI_V081_MATRIX_DEPLOY_ENV_FILE:?OCI_V081_MATRIX_DEPLOY_ENV_FILE is required}"
docker_config_file="${OCI_V081_MATRIX_DOCKER_CONFIG_FILE:?OCI_V081_MATRIX_DOCKER_CONFIG_FILE is required}"

oci_v081_ghcr_require_commands
oci_v081_ghcr_validate_namespace "${registry}" "${repository_prefix}"
oci_v081_ghcr_parse_targets "${targets_csv}" targets
[[ ${assertion} == zero || ${assertion} == success || ${assertion} == ordered-partial ]] || {
	printf 'v0.8.1 GHCR inventory rejected an unsupported assertion\n' >&2
	exit 1
}
[[ ${evidence_file} == /* && ! -e ${evidence_file} && ! -L ${evidence_file} &&
	-d $(dirname -- "${evidence_file}") && -f ${deploy_env_file} &&
	-f ${docker_config_file} ]] || {
	printf 'v0.8.1 GHCR inventory inputs or evidence path are invalid\n' >&2
	exit 1
}

OCI_V081_GHCR_TEMP="$(mktemp -d "${OCI_V081_GHCR_TEMP_ROOT%/}/rush-delivery-v081-ghcr-inventory.XXXXXX")"
trap cleanup_inventory EXIT
snapshot_directory="${OCI_V081_GHCR_TEMP}/snapshots"
candidate_evidence="${OCI_V081_GHCR_TEMP}/candidate-evidence.json"
verification_plan="${OCI_V081_GHCR_TEMP}/verification-references.json"
plan_log="${OCI_V081_GHCR_TEMP}/plan.log"
public_key_file="${OCI_V081_GHCR_TEMP}/verification-key.pem"
mkdir -m 700 "${snapshot_directory}"

inventory_ready=false
for inventory_attempt in 1 2 3 4 5; do
	for target_index in "${!targets[@]}"; do
		package_name="$(oci_v081_ghcr_package_name "${repository_prefix}" "${targets[${target_index}]}")"
		oci_v081_ghcr_get_versions \
			"${package_name}" "${snapshot_directory}/${target_index}.json"
	done
	delete_regular_file_if_present "${candidate_evidence}"
	delete_regular_file_if_present "${verification_plan}"
	delete_regular_file_if_present "${plan_log}"
	if node "${OCI_V081_GHCR_INVENTORY_TOOL}" inventory-plan \
		"${assertion}" "${registry}" "${repository_prefix}" \
		"${targets_csv}" "${snapshot_directory}" \
		"${candidate_evidence}" "${verification_plan}" \
		>"${plan_log}" 2>&1; then
		inventory_ready=true
		break
	fi
	if ((inventory_attempt < 5)); then
		sleep 2
	fi
done
delete_regular_file_if_present "${plan_log}"
[[ ${inventory_ready} == true ]] || {
	printf 'v0.8.1 GHCR inventory did not converge to the required state\n' >&2
	exit 1
}

verification_lines="${OCI_V081_GHCR_TEMP}/verification-references.txt"
node "${OCI_V081_GHCR_INVENTORY_TOOL}" \
	print-verification-references "${verification_plan}" \
	>"${verification_lines}"
mapfile -t verification_references <"${verification_lines}"
if ((${#verification_references[@]} > 0)); then
	node "${OCI_V081_GHCR_INVENTORY_TOOL}" extract-verification-key \
		"${deploy_env_file}" "${public_key_file}"
	for reference_index in "${!verification_references[@]}"; do
		verify_reference \
			"${verification_references[${reference_index}]}" \
			"${docker_config_file}" "${public_key_file}" \
			"${OCI_V081_GHCR_TEMP}/verification-${reference_index}.log"
	done
fi

chmod 600 "${candidate_evidence}"
mv -- "${candidate_evidence}" "${evidence_file}"
printf 'v0.8.1 GHCR inventory completed independent registry inspection\n'
