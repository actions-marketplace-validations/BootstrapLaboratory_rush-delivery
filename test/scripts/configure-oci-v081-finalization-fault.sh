#!/usr/bin/env bash
set -euo pipefail

OCI_V081_FAULT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OCI_V081_FAULT_REPO_ROOT="$(cd -- "${OCI_V081_FAULT_DIR}/../.." && pwd)"
OCI_V081_FAULT_PATCH_TOOL="${OCI_V081_FAULT_DIR}/inject-oci-v081-finalization-fault.mjs"
OCI_V081_FAULT_TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
OCI_V081_FAULT_MARKER=".rush-delivery-v081-finalization-fault-owned"
OCI_V081_FAULT_PENDING_MODULE=""

cleanup_pending_module() {
	local original_status=$?

	trap - EXIT
	if [[ -n ${OCI_V081_FAULT_PENDING_MODULE} ]]; then
		if [[ ${OCI_V081_FAULT_PENDING_MODULE} == "${OCI_V081_FAULT_TEMP_ROOT%/}/rush-delivery-v081-finalization-fault."* &&
			-d ${OCI_V081_FAULT_PENDING_MODULE} && ! -L ${OCI_V081_FAULT_PENDING_MODULE} ]]; then
			find "${OCI_V081_FAULT_PENDING_MODULE}" -depth -delete
		else
			printf 'v0.8.1 finalization fault refused an unsafe pending module path\n' >&2
			original_status=1
		fi
	fi
	exit "${original_status}"
}

validate_state_file() {
	local state_file="$1"
	local output_root="${OCI_V081_MATRIX_LIVE_OUTPUT_ROOT-}"
	local output_marker="${output_root}/.rush-delivery-v081-live-owned"
	local marker_contents

	[[ ${state_file} == /* && ${output_root} == /* &&
		${state_file} == "${output_root}/state/finalization-fault-module" &&
		-d ${output_root} && ! -L ${output_root} &&
		-f ${output_marker} && ! -L ${output_marker} ]] || {
		printf 'v0.8.1 finalization fault state path is not bound to the live output\n' >&2
		return 1
	}
	IFS= read -r marker_contents <"${output_marker}"
	[[ ${marker_contents} == rush-delivery-v081-live-owned ]] || {
		printf 'v0.8.1 finalization fault state path is not bound to the live output\n' >&2
		return 1
	}
}

[[ $# -eq 4 ]] || {
	printf 'Usage: %s configure-finalization-failure|teardown-finalization-failure REGISTRY REPOSITORY_PREFIX TARGET\n' "$0" >&2
	exit 1
}
action="$1"
registry="$2"
repository_prefix="$3"
failed_target="$4"
state_file="${OCI_V081_MATRIX_FAULT_STATE_FILE:?OCI_V081_MATRIX_FAULT_STATE_FILE is required}"

[[ ${registry} == ghcr.io &&
	${repository_prefix} =~ ^bootstraplaboratory/rush-delivery-v081-acceptance/v081-[a-z0-9-]+-[a-f0-9]{32}$ &&
	${failed_target} == matrix-worker ]] || {
	printf 'v0.8.1 finalization fault rejected non-project coordinates\n' >&2
	exit 1
}
validate_state_file "${state_file}"

case "${action}" in
configure-finalization-failure)
	for required_command in git node tar; do
		command -v "${required_command}" >/dev/null 2>&1 || {
			printf 'v0.8.1 finalization fault requires %s\n' "${required_command}" >&2
			exit 1
		}
	done
	[[ ! -e ${state_file} && ! -L ${state_file} ]] || {
		printf 'v0.8.1 finalization fault state already exists\n' >&2
		exit 1
	}
	state_directory="$(dirname -- "${state_file}")" || exit 1
	if [[ -e ${state_directory} || -L ${state_directory} ]]; then
		[[ -d ${state_directory} && ! -L ${state_directory} ]] || {
			printf 'v0.8.1 finalization fault state directory is unsafe\n' >&2
			exit 1
		}
	else
		mkdir -m 700 "${state_directory}"
	fi
	chmod 700 "${state_directory}"
	OCI_V081_FAULT_PENDING_MODULE="$(mktemp -d "${OCI_V081_FAULT_TEMP_ROOT%/}/rush-delivery-v081-finalization-fault.XXXXXX")"
	trap cleanup_pending_module EXIT
	git -C "${OCI_V081_FAULT_REPO_ROOT}" archive --format=tar HEAD |
		tar -C "${OCI_V081_FAULT_PENDING_MODULE}" -xf -
	node "${OCI_V081_FAULT_PATCH_TOOL}" \
		"${OCI_V081_FAULT_PENDING_MODULE}/src/application-images/package-image.ts" \
		"${failed_target}"
	commit_sha="$(git -C "${OCI_V081_FAULT_REPO_ROOT}" rev-parse --verify HEAD)" || exit 1
	[[ ${commit_sha} =~ ^[a-f0-9]{40}$ ]]
	{
		printf 'rush-delivery-v081-finalization-fault-owned\n'
		printf 'source_commit=%s\n' "${commit_sha}"
		printf 'failed_target=%s\n' "${failed_target}"
	} >"${OCI_V081_FAULT_PENDING_MODULE}/${OCI_V081_FAULT_MARKER}"
	chmod 600 "${OCI_V081_FAULT_PENDING_MODULE}/${OCI_V081_FAULT_MARKER}"
	state_candidate="${state_file}.candidate"
	printf '%s\n' "${OCI_V081_FAULT_PENDING_MODULE}" >"${state_candidate}"
	chmod 600 "${state_candidate}"
	mv -- "${state_candidate}" "${state_file}"
	OCI_V081_FAULT_PENDING_MODULE=""
	trap - EXIT
	printf 'Configured a disposable post-publication v0.8.1 acceptance fault\n'
	;;
teardown-finalization-failure)
	if [[ ! -e ${state_file} && ! -L ${state_file} ]]; then
		printf 'No disposable v0.8.1 finalization-fault module required teardown\n'
		exit 0
	fi
	[[ -f ${state_file} && ! -L ${state_file} ]] || {
		printf 'v0.8.1 finalization fault state is malformed\n' >&2
		exit 1
	}
	state_line_count="$(wc -l <"${state_file}")" || exit 1
	[[ ${state_line_count} -eq 1 ]] || {
		printf 'v0.8.1 finalization fault state is malformed\n' >&2
		exit 1
	}
	IFS= read -r module_root <"${state_file}"
	[[ ${module_root} == "${OCI_V081_FAULT_TEMP_ROOT%/}/rush-delivery-v081-finalization-fault."* &&
		-d ${module_root} && ! -L ${module_root} &&
		-f ${module_root}/${OCI_V081_FAULT_MARKER} && ! -L ${module_root}/${OCI_V081_FAULT_MARKER} ]] || {
		printf 'v0.8.1 finalization fault teardown rejected an unowned module\n' >&2
		exit 1
	}
	IFS= read -r marker_header <"${module_root}/${OCI_V081_FAULT_MARKER}"
	[[ ${marker_header} == rush-delivery-v081-finalization-fault-owned ]] || {
		printf 'v0.8.1 finalization fault teardown rejected an unowned module\n' >&2
		exit 1
	}
	find "${module_root}" -depth -delete
	find "${state_file}" -maxdepth 0 -type f -delete
	printf 'Removed the disposable v0.8.1 finalization-fault module\n'
	;;
*)
	printf 'v0.8.1 finalization fault rejected an unsupported action\n' >&2
	exit 1
	;;
esac
