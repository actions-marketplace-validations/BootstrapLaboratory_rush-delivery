#!/usr/bin/env bash

OCI_V081_GHCR_OWNER="BootstrapLaboratory"
OCI_V081_GHCR_OWNER_NORMALIZED="bootstraplaboratory"
OCI_V081_GHCR_NAMESPACE_PREFIX="rush-delivery-v081-acceptance"
# shellcheck disable=SC2034 # Read by cleanup callers after this library is sourced.
OCI_V081_GHCR_LAST_PACKAGE_ABSENT=false

oci_v081_ghcr_require_commands() {
	local command_name

	for command_name in cmp cp dagger find gh grep node; do
		command -v "${command_name}" >/dev/null 2>&1 || {
			printf 'v0.8.1 GHCR acceptance requires %s\n' "${command_name}" >&2
			return 1
		}
	done
	[[ -n ${GITHUB_TOKEN-} && ${GITHUB_TOKEN} != *$'\n'* && ${GITHUB_TOKEN} != *$'\r'* ]] || {
		printf 'v0.8.1 GHCR acceptance requires a single-line GITHUB_TOKEN\n' >&2
		return 1
	}
}

oci_v081_ghcr_confirm_package_absence() {
	local package_name="$1"
	local scratch_prefix="$2"
	local encoded_package
	local response_file="${scratch_prefix}.absence.response"
	local error_file="${scratch_prefix}.absence.error"
	local request_status=0

	encoded_package="$(oci_v081_ghcr_encode_package_name "${package_name}")" || return 1
	GH_TOKEN="${GITHUB_TOKEN}" GH_HOST=github.com gh api \
		--hostname github.com \
		--include \
		--method GET \
		--header 'Accept: application/vnd.github+json' \
		--header 'X-GitHub-Api-Version: 2022-11-28' \
		"/orgs/${OCI_V081_GHCR_OWNER}/packages/container/${encoded_package}/versions?per_page=1" \
		>"${response_file}" 2>"${error_file}" || request_status=$?
	if ((request_status != 0)) &&
		grep -Eq '^HTTP/[0-9]+([.][0-9]+)?[[:space:]]+404([[:space:]]|$)' \
			"${response_file}"; then
		find "${response_file}" "${error_file}" -maxdepth 0 -type f -delete || return 1
		return 0
	fi
	find "${response_file}" "${error_file}" -maxdepth 0 -type f -delete || return 1
	return 1
}

oci_v081_ghcr_validate_namespace() {
	local registry="$1"
	local repository_prefix="$2"

	[[ ${registry} == ghcr.io ]] || {
		printf 'v0.8.1 GHCR acceptance only supports ghcr.io\n' >&2
		return 1
	}
	[[ ${repository_prefix} =~ ^${OCI_V081_GHCR_OWNER_NORMALIZED}/${OCI_V081_GHCR_NAMESPACE_PREFIX}/v081-[a-z0-9-]+-[a-f0-9]{32}$ ]] || {
		printf 'v0.8.1 GHCR acceptance rejected a non-project namespace\n' >&2
		return 1
	}
}

oci_v081_ghcr_parse_targets() {
	local targets_csv="$1"
	local output_name="$2"
	local target
	local -a parsed_targets=()
	local -A seen_targets=()
	# shellcheck disable=SC2034 # Nameref assigns the caller's requested array.
	local -n output_targets="${output_name}"

	[[ ${output_name} =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
	IFS=',' read -r -a parsed_targets <<<"${targets_csv}"
	((${#parsed_targets[@]} > 0)) || {
		printf 'v0.8.1 GHCR acceptance requires at least one target\n' >&2
		return 1
	}
	for target in "${parsed_targets[@]}"; do
		case "${target}" in
		control-plane-api | matrix-worker | matrix-later) ;;
		*)
			printf 'v0.8.1 GHCR acceptance rejected an unexpected target\n' >&2
			return 1
			;;
		esac
		[[ -z ${seen_targets[${target}]+x} ]] || {
			printf 'v0.8.1 GHCR acceptance targets must be unique\n' >&2
			return 1
		}
		seen_targets["${target}"]=true
	done
	# shellcheck disable=SC2034 # Assignment writes through the caller's nameref.
	output_targets=("${parsed_targets[@]}")
}

oci_v081_ghcr_package_name() {
	local repository_prefix="$1"
	local target="$2"

	printf '%s/%s\n' "${repository_prefix#*/}" "${target}"
}

oci_v081_ghcr_encode_package_name() {
	local package_name="$1"

	node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' \
		"${package_name}"
}

oci_v081_ghcr_get_versions() {
	local package_name="$1"
	local output_file="$2"
	local encoded_package
	local response_file="${output_file}.response"
	local error_file="${output_file}.error"
	local request_status=0

	[[ ! -L ${output_file} && -d $(dirname -- "${output_file}") ]] || {
		printf 'v0.8.1 GHCR inventory rejected its output path\n' >&2
		return 1
	}
	encoded_package="$(oci_v081_ghcr_encode_package_name "${package_name}")" || return 1
	GH_TOKEN="${GITHUB_TOKEN}" GH_HOST=github.com gh api \
		--hostname github.com \
		--method GET \
		--paginate \
		--slurp \
		--header 'Accept: application/vnd.github+json' \
		--header 'X-GitHub-Api-Version: 2022-11-28' \
		"/orgs/${OCI_V081_GHCR_OWNER}/packages/container/${encoded_package}/versions?per_page=100" \
		>"${response_file}" 2>"${error_file}" || request_status=$?
	if ((request_status == 0)); then
		# shellcheck disable=SC2034 # Read by cleanup callers after sourcing.
		OCI_V081_GHCR_LAST_PACKAGE_ABSENT=false
		mv -- "${response_file}" "${output_file}" || return 1
		find "${error_file}" -maxdepth 0 -type f -delete || return 1
		return 0
	fi
	find "${response_file}" "${error_file}" -maxdepth 0 -type f -delete || return 1
	if oci_v081_ghcr_confirm_package_absence \
		"${package_name}" "${output_file}"; then
		# shellcheck disable=SC2034 # Read by cleanup callers after sourcing.
		OCI_V081_GHCR_LAST_PACKAGE_ABSENT=true
		printf '[]\n' >"${output_file}" || return 1
		return 0
	fi
	printf 'v0.8.1 GHCR inventory request failed\n' >&2
	return 1
}

oci_v081_ghcr_delete_package() {
	local package_name="$1"
	local scratch_directory="$2"
	local encoded_package
	local response_file="${scratch_directory}/delete.response"
	local error_file="${scratch_directory}/delete.error"
	local request_status=0

	encoded_package="$(oci_v081_ghcr_encode_package_name "${package_name}")" || return 1
	GH_TOKEN="${GITHUB_TOKEN}" GH_HOST=github.com gh api \
		--hostname github.com \
		--method DELETE \
		--header 'Accept: application/vnd.github+json' \
		--header 'X-GitHub-Api-Version: 2022-11-28' \
		"/orgs/${OCI_V081_GHCR_OWNER}/packages/container/${encoded_package}" \
		>"${response_file}" 2>"${error_file}" || request_status=$?
	if ((request_status == 0)); then
		find "${response_file}" "${error_file}" -maxdepth 0 -type f -delete || return 1
		return 0
	fi
	find "${response_file}" "${error_file}" -maxdepth 0 -type f -delete || return 1
	if oci_v081_ghcr_confirm_package_absence \
		"${package_name}" "${scratch_directory}/delete"; then
		return 0
	fi
	return 1
}
