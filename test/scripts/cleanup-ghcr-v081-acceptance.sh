#!/usr/bin/env bash
set -euo pipefail

OCI_V081_GHCR_CLEANUP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OCI_V081_GHCR_CLEANUP_LIB="${OCI_V081_GHCR_CLEANUP_DIR}/lib/oci-v081-ghcr-acceptance.sh"
OCI_V081_GHCR_CLEANUP_TOOL="${OCI_V081_GHCR_CLEANUP_DIR}/ghcr-v081-acceptance-evidence.mjs"
OCI_V081_GHCR_CLEANUP_TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
OCI_V081_GHCR_CLEANUP_TEMP=""

# shellcheck source=test/scripts/lib/oci-v081-ghcr-acceptance.sh
source "${OCI_V081_GHCR_CLEANUP_LIB}"

load_namespace_record() {
	local record_path="$1"
	local record_name
	local scenario
	local suffix
	local expected_targets
	local -a record_lines=()

	[[ ${record_path} == /* && -f ${record_path} && ! -L ${record_path} &&
		${record_path%/*} == */namespace-records ]] || {
		printf 'v0.8.1 GHCR cleanup rejected an unsafe namespace record\n' >&2
		return 2
	}
	mapfile -t record_lines <"${record_path}"
	if ((${#record_lines[@]} != 6)) ||
		[[ ${record_lines[0]} != 'schema=rush-delivery-v081-live-namespace/v1' ||
			! ${record_lines[1]} =~ ^scenario=([a-z0-9-]+)$ ||
			! ${record_lines[2]} =~ ^candidate_commit=[a-f0-9]{40}$ ||
			${record_lines[3]} != 'registry=ghcr.io' ]]; then
		printf 'v0.8.1 GHCR cleanup namespace record failed fixed-schema validation\n' >&2
		return 2
	fi
	scenario="${record_lines[1]#scenario=}"
	case "${scenario}" in
	malformed-private-pem | malformed-public-pem | wrong-signing-password | invalid-key | mismatched-key)
		expected_targets=control-plane-api
		;;
	multi-target-success | multi-target-preparation-failure)
		expected_targets=control-plane-api,matrix-worker
		;;
	multi-target-finalization-failure)
		expected_targets=control-plane-api,matrix-worker,matrix-later
		;;
	*)
		printf 'v0.8.1 GHCR cleanup namespace record names an unsupported scenario\n' >&2
		return 2
		;;
	esac
	record_name="${record_path##*/}"
	[[ ${record_name} =~ ^${scenario}-([a-f0-9]{32})\.txt$ ]] || {
		printf 'v0.8.1 GHCR cleanup namespace record filename is invalid\n' >&2
		return 2
	}
	suffix="${BASH_REMATCH[1]}"
	OCI_V081_GHCR_CLEANUP_REGISTRY=ghcr.io
	OCI_V081_GHCR_CLEANUP_REPOSITORY_PREFIX="bootstraplaboratory/rush-delivery-v081-acceptance/v081-${scenario}-${suffix}"
	OCI_V081_GHCR_CLEANUP_TARGETS="${expected_targets}"
	if [[ ${record_lines[4]} != "repository_prefix=${OCI_V081_GHCR_CLEANUP_REPOSITORY_PREFIX}" ||
		${record_lines[5]} != "targets=${OCI_V081_GHCR_CLEANUP_TARGETS}" ]]; then
		printf 'v0.8.1 GHCR cleanup namespace record coordinates are inconsistent\n' >&2
		return 2
	fi
}

cleanup_scratch() {
	local original_status=$?

	trap - EXIT
	if [[ -n ${OCI_V081_GHCR_CLEANUP_TEMP} ]]; then
		if [[ ${OCI_V081_GHCR_CLEANUP_TEMP} != "${OCI_V081_GHCR_CLEANUP_TEMP_ROOT%/}/rush-delivery-v081-ghcr-cleanup."* ]]; then
			printf 'v0.8.1 GHCR cleanup refused an unsafe scratch path\n' >&2
			exit 1
		fi
		find "${OCI_V081_GHCR_CLEANUP_TEMP}" -depth -delete
	fi
	exit "${original_status}"
}

if (($# == 3)) && [[ $1 == --namespace-record ]]; then
	load_namespace_record "$2"
	registry="${OCI_V081_GHCR_CLEANUP_REGISTRY}"
	repository_prefix="${OCI_V081_GHCR_CLEANUP_REPOSITORY_PREFIX}"
	targets_csv="${OCI_V081_GHCR_CLEANUP_TARGETS}"
	evidence_file="$3"
elif (($# == 5)) && [[ $1 == inspect-and-clean ]]; then
	registry="$2"
	repository_prefix="$3"
	targets_csv="$4"
	evidence_file="$5"
else
	printf 'Usage: %s inspect-and-clean REGISTRY REPOSITORY_PREFIX TARGETS_CSV EVIDENCE_FILE\n' "$0" >&2
	printf '   or: %s --namespace-record ABSOLUTE_RECORD_PATH EVIDENCE_FILE\n' "$0" >&2
	exit 2
fi

oci_v081_ghcr_require_commands
oci_v081_ghcr_validate_namespace "${registry}" "${repository_prefix}"
oci_v081_ghcr_parse_targets "${targets_csv}" targets
[[ ${evidence_file} == /* && ! -e ${evidence_file} && ! -L ${evidence_file} &&
	-d $(dirname -- "${evidence_file}") ]] || {
	printf 'v0.8.1 GHCR cleanup evidence path is invalid\n' >&2
	exit 1
}

OCI_V081_GHCR_CLEANUP_TEMP="$(mktemp -d "${OCI_V081_GHCR_CLEANUP_TEMP_ROOT%/}/rush-delivery-v081-ghcr-cleanup.XXXXXX")"
trap cleanup_scratch EXIT
status_directory="${OCI_V081_GHCR_CLEANUP_TEMP}/status"
mkdir -m 700 "${status_directory}"
cleanup_failed=false

for target_index in "${!targets[@]}"; do
	target="${targets[${target_index}]}"
	package_name="$(oci_v081_ghcr_package_name "${repository_prefix}" "${target}")"
	target_scratch="${OCI_V081_GHCR_CLEANUP_TEMP}/target-${target_index}"
	mkdir -m 700 "${target_scratch}"
	set +e
	oci_v081_ghcr_get_versions \
		"${package_name}" "${target_scratch}/before.json"
	inspection_status=$?
	set -e
	if ((inspection_status != 0)); then
		cleanup_failed=true
		continue
	fi
	set +e
	oci_v081_ghcr_delete_package \
		"${package_name}" "${target_scratch}"
	delete_status=$?
	set -e
	if ((delete_status != 0)); then
		cleanup_failed=true
		continue
	fi
	package_absent=false
	for cleanup_attempt in 1 2 3 4 5; do
		set +e
		oci_v081_ghcr_get_versions \
			"${package_name}" "${target_scratch}/after.json"
		inspection_status=$?
		set -e
		if ((inspection_status == 0)) &&
			[[ ${OCI_V081_GHCR_LAST_PACKAGE_ABSENT} == true ]]; then
			package_absent=true
			break
		fi
		if ((cleanup_attempt < 5)); then
			sleep 2
		fi
	done
	if [[ ${package_absent} == true ]]; then
		printf 'absent\n' >"${status_directory}/${target_index}.status"
		chmod 600 "${status_directory}/${target_index}.status"
	else
		cleanup_failed=true
	fi
done

[[ ${cleanup_failed} == false ]] || {
	printf 'v0.8.1 GHCR cleanup could not prove every package absent\n' >&2
	exit 1
}
node "${OCI_V081_GHCR_CLEANUP_TOOL}" cleanup-evidence \
	"${registry}" "${repository_prefix}" "${targets_csv}" \
	"${status_directory}" "${evidence_file}"
printf 'v0.8.1 GHCR cleanup deleted and re-inspected the disposable namespace\n'
