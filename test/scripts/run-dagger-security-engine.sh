#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SDK_DIR="${REPO_ROOT}/sdk"
GENERATED_SDK=false
PROGRESS_TEST_DIR=""

cleanup() {
	if [[ -n ${PROGRESS_TEST_DIR} &&
		-d ${PROGRESS_TEST_DIR} &&
		${PROGRESS_TEST_DIR##*/} == rush-delivery-dagger-progress.* ]]; then
		find "${PROGRESS_TEST_DIR}" -depth -delete
	fi
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

PROGRESS_TEST_DIR="$(
	mktemp -d "${TMPDIR:-/tmp}/rush-delivery-dagger-progress.XXXXXX"
)"
chmod 700 "${PROGRESS_TEST_DIR}"
progress_log="${PROGRESS_TEST_DIR}/progress.log"
silent_log="${PROGRESS_TEST_DIR}/silent.log"
progress_marker=RUSH_DELIVERY_DAGGER_PROGRESS_MARKER
progress_image='alpine@sha256:eafc1edb577d2e9b458664a15f23ea1c370214193226069eb22921169fc7e43f'
DAGGER_PROGRESS_SECRET_SENTINEL="rush-delivery-progress-secret-${RANDOM}-${RANDOM}"
export DAGGER_PROGRESS_SECRET_SENTINEL
progress_command="container | from ${progress_image} | with-secret-variable RUSH_DELIVERY_PROGRESS_SECRET \$(secret env://DAGGER_PROGRESS_SECRET_SENTINEL) | with-exec --args=sh,-c,\"echo ${progress_marker} >&2; exit 23\" | sync"

set +e
DAGGER_NO_NAG=1 dagger --progress=logs -c "${progress_command}" \
	>"${progress_log}" 2>&1
progress_status=$?
DAGGER_NO_NAG=1 dagger --silent -c "${progress_command}" \
	>"${silent_log}" 2>&1
silent_status=$?
set -e

if ((progress_status == 0 || silent_status == 0)) ||
	! grep -Fq "${progress_marker}" "${progress_log}" ||
	grep -Fq "${progress_marker}" "${silent_log}" ||
	grep -Fq "${DAGGER_PROGRESS_SECRET_SENTINEL}" \
		"${progress_log}" "${silent_log}"; then
	printf 'Dagger progress-mode security regression failed\n' >&2
	exit 1
fi
unset DAGGER_PROGRESS_SECRET_SENTINEL

node --experimental-strip-types \
	"${SCRIPT_DIR}/run-cosign-preflight-engine.mjs"
node --experimental-strip-types \
	"${SCRIPT_DIR}/run-evidence-symlink-engine.mjs"
