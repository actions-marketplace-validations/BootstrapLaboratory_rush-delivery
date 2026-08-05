#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SDK_DIR="${REPO_ROOT}/sdk"
GENERATED_SDK=false

cleanup() {
	if [[ ${GENERATED_SDK} == true &&
		${SDK_DIR} == "${REPO_ROOT}/sdk" &&
		-d ${SDK_DIR} ]]; then
		find "${SDK_DIR}" -depth -delete
	fi
}

trap cleanup EXIT

if [[ ! -f ${SDK_DIR}/core.js ]]; then
	if [[ -e ${SDK_DIR} ]]; then
		printf 'Dagger security regressions found an incomplete pre-existing sdk directory\n' >&2
		exit 1
	fi

	GENERATED_SDK=true
	DAGGER_NO_NAG=1 dagger -m "${REPO_ROOT}" develop >/dev/null
fi

node --experimental-strip-types \
	"${SCRIPT_DIR}/run-cosign-preflight-engine.mjs"
node --experimental-strip-types \
	"${SCRIPT_DIR}/run-evidence-symlink-engine.mjs"
