#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required for GHCR acceptance cleanup}"
: "${OCI_ACCEPTANCE_CLEANUP_REGISTRY:?cleanup registry is required}"
: "${OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX:?cleanup repository prefix is required}"
: "${OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES:?cleanup package suffixes are required}"

for required_command in gh node; do
	command -v "${required_command}" >/dev/null 2>&1 || {
		printf 'GHCR cleanup requires command: %s\n' "${required_command}" >&2
		exit 1
	}
done

if [[ ${OCI_ACCEPTANCE_CLEANUP_REGISTRY} != ghcr.io ]]; then
	printf 'GHCR cleanup only accepts the ghcr.io registry\n' >&2
	exit 1
fi

owner="${OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX%%/*}"
package_prefix="${OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX#*/}"

if [[ ! ${owner} =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ||
	${package_prefix} == "${OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX}" ||
	! ${package_prefix} =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]]; then
	printf 'GHCR cleanup requires an owner/package repository prefix\n' >&2
	exit 1
fi

mapfile -t package_suffixes < <(
	printf '%s\n' "${OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES}"
)

if ((${#package_suffixes[@]} == 0)); then
	printf 'GHCR cleanup requires at least one package suffix\n' >&2
	exit 1
fi

declare -A seen_package_suffixes=()
for package_suffix in "${package_suffixes[@]}"; do
	if [[ ! ${package_suffix} =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ||
		-n ${seen_package_suffixes[${package_suffix}]+x} ]]; then
		printf 'GHCR cleanup package suffixes must be unique normalized paths\n' >&2
		exit 1
	fi
	seen_package_suffixes["${package_suffix}"]=true
done

cleanup_failed=false
for package_suffix in "${package_suffixes[@]}"; do
	package_name="${package_prefix}/${package_suffix}"
	encoded_package="$(
		node -e \
			'process.stdout.write(encodeURIComponent(process.argv[1]))' \
			"${package_name}"
	)"

	set +e
	delete_response="$(
		GH_TOKEN="${GITHUB_TOKEN}" gh api \
			--include \
			--method DELETE \
			"/orgs/${owner}/packages/container/${encoded_package}" 2>&1
	)"
	delete_status=$?
	set -e

	if ((delete_status == 0)); then
		continue
	fi
	if [[ ${delete_response} =~ HTTP/[0-9.]+[[:space:]]+404([[:space:]]|$) ]]; then
		continue
	fi

	cleanup_failed=true
done

if [[ ${cleanup_failed} == true ]]; then
	printf 'GHCR cleanup failed for one or more registered package suffixes\n' >&2
	exit 1
fi
