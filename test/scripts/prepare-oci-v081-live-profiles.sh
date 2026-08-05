#!/usr/bin/env bash
set -euo pipefail

OCI_V081_PROFILE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OCI_V081_PROFILE_TOOL="${OCI_V081_PROFILE_DIR}/ghcr-v081-acceptance-evidence.mjs"
OCI_V081_PROFILE_COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849"
OCI_V081_PROFILE_MARKER=".rush-delivery-v081-profile-root"
OCI_V081_PROFILE_OUTPUT=""
OCI_V081_PROFILE_CLEANUP_ARMED=false

cleanup_profile_root() {
	local original_status=$?

	trap - EXIT
	if [[ ${OCI_V081_PROFILE_CLEANUP_ARMED} == true && -n ${OCI_V081_PROFILE_OUTPUT} ]]; then
		if [[ -d ${OCI_V081_PROFILE_OUTPUT} && ! -L ${OCI_V081_PROFILE_OUTPUT} &&
			-f ${OCI_V081_PROFILE_OUTPUT}/${OCI_V081_PROFILE_MARKER} &&
			! -L ${OCI_V081_PROFILE_OUTPUT}/${OCI_V081_PROFILE_MARKER} &&
			$(<"${OCI_V081_PROFILE_OUTPUT}/${OCI_V081_PROFILE_MARKER}") == rush-delivery-v081-profile-root ]]; then
			find "${OCI_V081_PROFILE_OUTPUT}" -depth -delete
		else
			printf 'v0.8.1 profile preparation refused an unowned cleanup path\n' >&2
			original_status=1
		fi
	fi
	exit "${original_status}"
}

cleanup_requested_profile_root() {
	local output_root="$1"

	[[ ${output_root} == /* && -d ${output_root} && ! -L ${output_root} &&
		-f ${output_root}/${OCI_V081_PROFILE_MARKER} &&
		! -L ${output_root}/${OCI_V081_PROFILE_MARKER} &&
		$(<"${output_root}/${OCI_V081_PROFILE_MARKER}") == rush-delivery-v081-profile-root ]] || {
		printf 'v0.8.1 profile cleanup rejected an unowned path\n' >&2
		return 1
	}
	find "${output_root}" -depth -delete
}

generate_key_pair() {
	local pair_name="$1"
	local material_directory="$2"
	local password_file="${material_directory}/${pair_name}.password"
	local output_directory="${material_directory}/${pair_name}"
	local generation_log="${material_directory}/${pair_name}.generation.log"
	local cache_nonce
	local generation_status=0

	IFS= read -r OCI_V081_PROFILE_SIGNING_PASSWORD <"${password_file}"
	export OCI_V081_PROFILE_SIGNING_PASSWORD
	cache_nonce="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
	timeout --foreground --signal=TERM --kill-after=30s 300s \
		env DAGGER_NO_NAG=1 dagger --silent -c \
		"container | from ${OCI_V081_PROFILE_COSIGN_IMAGE} | with-new-file /tmp/rush-delivery-v081-profile-cache ${cache_nonce} | with-secret-variable COSIGN_PASSWORD \$(secret env://OCI_V081_PROFILE_SIGNING_PASSWORD) | with-workdir /keys | with-exec --args=/ko-app/cosign,generate-key-pair,--output-key-prefix,/keys/cosign | directory /keys | export ${output_directory}" \
		>"${generation_log}" 2>&1 || generation_status=$?
	unset OCI_V081_PROFILE_SIGNING_PASSWORD
	find "${generation_log}" -maxdepth 0 -type f -delete
	((generation_status == 0)) || {
		printf 'v0.8.1 profile preparation failed to generate a pinned Cosign key pair\n' >&2
		return "${generation_status}"
	}
}

if [[ ${1-} == --cleanup ]]; then
	[[ $# -eq 2 ]] || {
		printf 'Usage: %s --cleanup ABSOLUTE_PROFILE_ROOT\n' "$0" >&2
		exit 1
	}
	cleanup_requested_profile_root "$2"
	exit 0
fi

[[ $# -eq 1 ]] || {
	printf 'Usage: %s ABSOLUTE_PROFILE_ROOT\n' "$0" >&2
	exit 1
}
for required_command in dagger node timeout; do
	command -v "${required_command}" >/dev/null 2>&1 || {
		printf 'v0.8.1 profile preparation requires %s\n' "${required_command}" >&2
		exit 1
	}
done
[[ -n ${GITHUB_TOKEN-} && -n ${GITHUB_ACTOR-} ]] || {
	printf 'v0.8.1 profile preparation requires GitHub Actions credentials\n' >&2
	exit 1
}

OCI_V081_PROFILE_OUTPUT="$1"
[[ ${OCI_V081_PROFILE_OUTPUT} =~ ^/[A-Za-z0-9_./-]+$ &&
	! -e ${OCI_V081_PROFILE_OUTPUT} && ! -L ${OCI_V081_PROFILE_OUTPUT} ]] || {
	printf 'v0.8.1 profile preparation requires a new normalized absolute path\n' >&2
	exit 1
}
umask 077
mkdir -m 700 "${OCI_V081_PROFILE_OUTPUT}"
printf 'rush-delivery-v081-profile-root\n' \
	>"${OCI_V081_PROFILE_OUTPUT}/${OCI_V081_PROFILE_MARKER}"
chmod 600 "${OCI_V081_PROFILE_OUTPUT}/${OCI_V081_PROFILE_MARKER}"
OCI_V081_PROFILE_CLEANUP_ARMED=true
trap cleanup_profile_root EXIT

material_directory="${OCI_V081_PROFILE_OUTPUT}/material"
node "${OCI_V081_PROFILE_TOOL}" initialize-profile-material \
	"${material_directory}"
generate_key_pair primary "${material_directory}"
generate_key_pair secondary "${material_directory}"
node "${OCI_V081_PROFILE_TOOL}" build-profiles \
	"${OCI_V081_PROFILE_OUTPUT}" "${material_directory}" ghcr.io
find "${material_directory}" -depth -delete

OCI_V081_PROFILE_CLEANUP_ARMED=false
trap - EXIT
printf 'Prepared eight protected v0.8.1 GHCR acceptance profiles\n'
