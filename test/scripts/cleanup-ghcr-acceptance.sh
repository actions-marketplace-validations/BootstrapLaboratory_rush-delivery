#!/usr/bin/env bash
set -euo pipefail

GHCR_ACCEPTANCE_API_HOST=github.com
GHCR_ACCEPTANCE_API_VERSION=2022-11-28
GHCR_ACCEPTANCE_API_TIMEOUT_SECONDS=30
GHCR_ACCEPTANCE_API_KILL_AFTER_SECONDS=5
GHCR_ACCEPTANCE_READBACK_ATTEMPTS=5
GHCR_ACCEPTANCE_READBACK_DELAY_SECONDS=2
GHCR_ACCEPTANCE_EXPECTED_REGISTRY=ghcr.io
GHCR_ACCEPTANCE_EXPECTED_SUFFIX="control-plane-api"
GHCR_ACCEPTANCE_REPOSITORY_PATTERN='^bootstraplaboratory/rush-delivery-acceptance-[a-f0-9]{32}$'

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required for GHCR acceptance cleanup}"

for required_command in gh grep sleep timeout; do
	command -v "${required_command}" >/dev/null 2>&1 || {
		printf 'GHCR cleanup requires command: %s\n' "${required_command}" >&2
		exit 1
	}
done

ghcr_acceptance_load_namespace_record() {
	local record_path="$1"
	local -a record_lines=()

	if [[ ${record_path} != /* ||
		${record_path} != */rush-delivery-oci-acceptance-namespace.txt ||
		! -f ${record_path} || -L ${record_path} ]]; then
		printf 'GHCR cleanup namespace record is not an allowed regular file\n' >&2
		return 2
	fi

	mapfile -t record_lines <"${record_path}"
	if ((${#record_lines[@]} != 4)) ||
		[[ ${record_lines[0]} != 'schema=rush-delivery-oci-acceptance-namespace/v1' ||
			${record_lines[1]} != 'registry=ghcr.io' ||
			! ${record_lines[2]} =~ ^repository_prefix=(bootstraplaboratory/rush-delivery-acceptance-[a-f0-9]{32})$ ||
			${record_lines[3]} != 'package_suffix=control-plane-api' ]]; then
		printf 'GHCR cleanup namespace record failed its fixed-schema validation\n' >&2
		return 2
	fi

	OCI_ACCEPTANCE_CLEANUP_REGISTRY=ghcr.io
	OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX="${record_lines[2]#repository_prefix=}"
	OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES="control-plane-api"
}

if (($# == 2)) && [[ $1 == --namespace-record ]]; then
	ghcr_acceptance_load_namespace_record "$2"
elif (($# == 0)); then
	: "${OCI_ACCEPTANCE_CLEANUP_REGISTRY:?cleanup registry is required}"
	: "${OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX:?cleanup repository prefix is required}"
	: "${OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES:?cleanup package suffixes are required}"
else
	printf 'Usage: %s [--namespace-record ABSOLUTE_PATH]\n' "$0" >&2
	exit 2
fi

if [[ ${OCI_ACCEPTANCE_CLEANUP_REGISTRY} != "${GHCR_ACCEPTANCE_EXPECTED_REGISTRY}" ||
	! ${OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX} =~ ${GHCR_ACCEPTANCE_REPOSITORY_PATTERN} ||
	${OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES} != "${GHCR_ACCEPTANCE_EXPECTED_SUFFIX}" ]]; then
	printf 'GHCR cleanup rejected coordinates outside the single-target acceptance namespace\n' >&2
	exit 2
fi

declare -ar GHCR_ACCEPTANCE_API_COMMAND=(
	timeout
	--signal=TERM
	--kill-after="${GHCR_ACCEPTANCE_API_KILL_AFTER_SECONDS}s"
	"${GHCR_ACCEPTANCE_API_TIMEOUT_SECONDS}s"
	gh api
	--hostname "${GHCR_ACCEPTANCE_API_HOST}"
	--include
	--header 'Accept: application/vnd.github+json'
	--header "X-GitHub-Api-Version: ${GHCR_ACCEPTANCE_API_VERSION}"
)

ghcr_check_package_absence() {
	local endpoint="$1"
	local readback_response
	local readback_status
	local attempt

	GHCR_ACCEPTANCE_PACKAGE_ABSENT=false

	for ((attempt = 1; attempt <= GHCR_ACCEPTANCE_READBACK_ATTEMPTS; attempt += 1)); do
		if readback_response="$(
			GH_TOKEN="${GITHUB_TOKEN}" GH_HOST="${GHCR_ACCEPTANCE_API_HOST}" \
				"${GHCR_ACCEPTANCE_API_COMMAND[@]}" \
				--method GET "${endpoint}" 2>&1
		)"; then
			readback_status=0
		else
			readback_status=$?
		fi

		if ((readback_status != 0)) &&
			grep -Eq '^HTTP/[0-9.]+[[:space:]]+404([[:space:]]|$)' \
				<<<"${readback_response}"; then
			GHCR_ACCEPTANCE_PACKAGE_ABSENT=true
			return 0
		fi
		if ((attempt < GHCR_ACCEPTANCE_READBACK_ATTEMPTS)); then
			sleep "${GHCR_ACCEPTANCE_READBACK_DELAY_SECONDS}" || return 1
		fi
	done

	return 0
}

package_prefix="${OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX#bootstraplaboratory/}"
encoded_package="${package_prefix}%2F${GHCR_ACCEPTANCE_EXPECTED_SUFFIX}"
package_endpoint="/orgs/bootstraplaboratory/packages/container/${encoded_package}"

GH_TOKEN="${GITHUB_TOKEN}" GH_HOST="${GHCR_ACCEPTANCE_API_HOST}" \
	"${GHCR_ACCEPTANCE_API_COMMAND[@]}" \
	--method DELETE "${package_endpoint}" >/dev/null 2>&1 || true

GHCR_ACCEPTANCE_PACKAGE_ABSENT=false
ghcr_check_package_absence "${package_endpoint}"
if [[ ${GHCR_ACCEPTANCE_PACKAGE_ABSENT} != true ]]; then
	printf 'GHCR cleanup could not prove the registered acceptance package absent\n' >&2
	exit 1
fi
