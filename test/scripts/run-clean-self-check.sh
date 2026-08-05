#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
TEMP_ROOT="${TMPDIR:-/tmp}"
CLEAN_SOURCE="$(mktemp -d "${TEMP_ROOT%/}/rush-delivery-self-check.XXXXXX")"

cleanup() {
	if [[ ${CLEAN_SOURCE} == "${TEMP_ROOT%/}/rush-delivery-self-check."* ]]; then
		find "${CLEAN_SOURCE}" -depth -delete
	fi
}

trap cleanup EXIT

git -C "${REPO_ROOT}" archive HEAD | tar -x -C "${CLEAN_SOURCE}"

if [[ -e ${CLEAN_SOURCE}/sdk || -e ${CLEAN_SOURCE}/node_modules ]]; then
	printf 'clean self-check fixture unexpectedly contains ignored generated dependencies\n' >&2
	exit 1
fi

DAGGER_NO_NAG=1 dagger -m "${REPO_ROOT}" call self-check \
	--module-source="${CLEAN_SOURCE}"
