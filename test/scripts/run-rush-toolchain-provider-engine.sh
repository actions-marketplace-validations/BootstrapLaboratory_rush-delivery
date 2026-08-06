#!/usr/bin/env bash
set -euo pipefail

RUSH_TOOLCHAIN_PROVIDER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUSH_TOOLCHAIN_PROVIDER_REPO_ROOT="$(cd "${RUSH_TOOLCHAIN_PROVIDER_DIR}/../.." && pwd)"
RUSH_TOOLCHAIN_PROVIDER_EXAMPLE="${RUSH_TOOLCHAIN_PROVIDER_REPO_ROOT}/examples/oci-application-image-rush-repo"
RUSH_TOOLCHAIN_PROVIDER_TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
RUSH_TOOLCHAIN_PROVIDER_WORK="$(mktemp -d "${RUSH_TOOLCHAIN_PROVIDER_TEMP_ROOT%/}/rush-delivery-toolchain-provider.XXXXXX")"
readonly RUSH_TOOLCHAIN_PROVIDER_MARKER=".rush-delivery-toolchain-provider-owned"

cleanup() {
	local original_status=$?

	trap - EXIT
	if [[ ${RUSH_TOOLCHAIN_PROVIDER_WORK} =~ ^/[A-Za-z0-9_./-]+$ &&
		-d ${RUSH_TOOLCHAIN_PROVIDER_WORK} &&
		! -L ${RUSH_TOOLCHAIN_PROVIDER_WORK} &&
		-f ${RUSH_TOOLCHAIN_PROVIDER_WORK}/${RUSH_TOOLCHAIN_PROVIDER_MARKER} &&
		! -L ${RUSH_TOOLCHAIN_PROVIDER_WORK}/${RUSH_TOOLCHAIN_PROVIDER_MARKER} ]]; then
		find "${RUSH_TOOLCHAIN_PROVIDER_WORK}" -depth -delete
	else
		printf 'provider-backed Rush toolchain acceptance refused an unowned cleanup path\n' >&2
		original_status=1
	fi
	exit "${original_status}"
}
trap cleanup EXIT

for required_command in dagger git node tar; do
	command -v "${required_command}" >/dev/null 2>&1 || {
		printf 'provider-backed Rush toolchain acceptance requires %s\n' "${required_command}" >&2
		exit 1
	}
done
[[ -n ${GITHUB_TOKEN-} && -n ${GITHUB_ACTOR-} &&
	${GITHUB_REPOSITORY-} =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
	printf 'provider-backed Rush toolchain acceptance requires GitHub Actions package credentials\n' >&2
	exit 1
}
[[ ${GITHUB_TOKEN} != *$'\n'* && ${GITHUB_ACTOR} =~ ^[A-Za-z0-9_.@-]+$ ]] || {
	printf 'provider-backed Rush toolchain acceptance rejected malformed credential metadata\n' >&2
	exit 1
}

printf 'rush-delivery-toolchain-provider-owned\n' \
	>"${RUSH_TOOLCHAIN_PROVIDER_WORK}/${RUSH_TOOLCHAIN_PROVIDER_MARKER}"
fixture="${RUSH_TOOLCHAIN_PROVIDER_WORK}/fixture"
mkdir -p "${fixture}/.dagger/toolchain-images" "${fixture}/.dagger/toolchains"
tar \
	--exclude='./.dagger/runtime' \
	--exclude='./apps/control-plane-api/.rush' \
	--exclude='./apps/control-plane-api/dist' \
	--exclude='./apps/control-plane-api/node_modules' \
	--exclude='./apps/control-plane-api/rush-logs' \
	--exclude='./common/temp' \
	--exclude='./node_modules' \
	-C "${RUSH_TOOLCHAIN_PROVIDER_EXAMPLE}" \
	-cf - . | tar -C "${fixture}" -xf -
cp "${RUSH_TOOLCHAIN_PROVIDER_REPO_ROOT}/test/fixtures/rush-toolchain.yaml" \
	"${fixture}/.dagger/toolchains/rush.yaml"
cp "${RUSH_TOOLCHAIN_PROVIDER_REPO_ROOT}/test/fixtures/rush-toolchain-package.json" \
	"${fixture}/apps/control-plane-api/package.json"

cat >"${fixture}/.dagger/toolchain-images/providers.yaml" <<'YAML'
providers:
  github:
    kind: github_container_registry
    registry: ghcr.io
    repository_env: RUSH_TOOLCHAIN_GITHUB_REPOSITORY
    token_env: RUSH_TOOLCHAIN_GITHUB_TOKEN
    username_env: RUSH_TOOLCHAIN_GITHUB_USERNAME
YAML

git -C "${fixture}" init --quiet --initial-branch=main
git -C "${fixture}" -c user.name='Rush Delivery Test' -c user.email='test@example.invalid' add --force .
git -C "${fixture}" -c user.name='Rush Delivery Test' -c user.email='test@example.invalid' commit --quiet -m 'test: initialize provider-backed toolchain fixture'
fixture_git_sha="$(git -C "${fixture}" rev-parse HEAD)"
sentinel_suffix="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
application_username="application-user-${sentinel_suffix}"
application_token="SENTINEL_APPLICATION_TOKEN_${sentinel_suffix}"
application_private_key="SENTINEL_APPLICATION_PRIVATE_KEY_${sentinel_suffix}"
application_password="SENTINEL_APPLICATION_PASSWORD_${sentinel_suffix}"
application_public_key="SENTINEL_APPLICATION_PUBLIC_KEY_${sentinel_suffix}"

workflow_env="${RUSH_TOOLCHAIN_PROVIDER_WORK}/workflow.env"
{
	printf 'RUSH_TOOLCHAIN_GITHUB_REPOSITORY=%s\n' "${GITHUB_REPOSITORY}"
	printf 'RUSH_TOOLCHAIN_GITHUB_TOKEN=%s\n' "${GITHUB_TOKEN}"
	printf 'RUSH_TOOLCHAIN_GITHUB_USERNAME=%s\n' "${GITHUB_ACTOR}"
	printf 'RD_OCI_GHCR_USERNAME=%s\n' "${application_username}"
	printf 'RD_OCI_GHCR_TOKEN=%s\n' "${application_token}"
	printf 'RD_OCI_COSIGN_PRIVATE_KEY=%s\n' "${application_private_key}"
	printf 'RD_OCI_COSIGN_PASSWORD=%s\n' "${application_password}"
	printf 'RD_OCI_COSIGN_PUBLIC_KEY=%s\n' "${application_public_key}"
} >"${workflow_env}"
chmod 600 "${workflow_env}"
protected_token="${GITHUB_TOKEN}"
unset GITHUB_TOKEN
readonly -a protected_values=(
	"${protected_token}"
	"${application_username}"
	"${application_token}"
	"${application_private_key}"
	"${application_password}"
	"${application_public_key}"
)

assert_files_redacted() {
	local protected_value
	local inspected_file

	for inspected_file in "$@"; do
		for protected_value in "${protected_values[@]}"; do
			if grep -Fq -- "${protected_value}" "${inspected_file}"; then
				printf 'provider-backed Rush toolchain acceptance captured protected material\n' >&2
				return 1
			fi
		done
	done
}

run_provider_workflow() {
	local run_name="$1"
	local result_file="${RUSH_TOOLCHAIN_PROVIDER_WORK}/${run_name}.json"
	local log_file="${RUSH_TOOLCHAIN_PROVIDER_WORK}/${run_name}.log"
	local status=0

	DAGGER_NO_NAG=1 dagger -m "${RUSH_TOOLCHAIN_PROVIDER_REPO_ROOT}" --progress=plain call --json workflow \
		--repo="${fixture}" \
		--workflow-env-file="${workflow_env}" \
		--git-sha="${fixture_git_sha}" \
		--source-repository-url=https://github.com/BootstrapLaboratory/rush-delivery.git \
		--event-name=workflow_dispatch \
		--force-targets-json='["control-plane-api"]' \
		--dry-run=true \
		--application-image-provider=off \
		--rush-cache-provider=off \
		--toolchain-image-provider=github \
		--toolchain-image-policy=lazy \
		>"${result_file}" 2>"${log_file}" || status=$?

	assert_files_redacted "${result_file}" "${log_file}"
	if ((status != 0)); then
		printf 'provider-backed Rush toolchain acceptance workflow failed\n' >&2
		return "${status}"
	fi

	RUSH_TOOLCHAIN_PROVIDER_RESULT_FILE="${result_file}" node -e '
const { readFileSync } = require("node:fs");
const encoded = JSON.parse(readFileSync(process.env.RUSH_TOOLCHAIN_PROVIDER_RESULT_FILE, "utf8"));
const result = JSON.parse(encoded);
const target = result.results?.[0];
if (result.dryRun !== true || result.results?.length !== 1 ||
    target?.target !== "control-plane-api" || target.artifactKind !== "oci_image" ||
    target.artifactReference !== undefined) {
  throw new Error("provider-backed Rush toolchain returned an unexpected dry-run contract");
}
'
}

run_provider_workflow first
run_provider_workflow second
grep -Fq '[toolchain-images] using ghcr.io/' \
	"${RUSH_TOOLCHAIN_PROVIDER_WORK}/second.log" || {
	printf 'provider-backed Rush toolchain acceptance did not reuse the published cache image\n' >&2
	exit 1
}

toolchain_reference="$({
	node -e '
const { readFileSync } = require("node:fs");
const source = readFileSync(process.argv[1], "utf8");
const matches = [...source.matchAll(/\[toolchain-images\] using (ghcr\.io\/[a-z0-9./:_-]+)/g)];
if (matches.length === 0) throw new Error("provider-backed toolchain reference is absent");
process.stdout.write(matches.at(-1)[1]);
' "${RUSH_TOOLCHAIN_PROVIDER_WORK}/second.log"
})"
[[ ${toolchain_reference} =~ ^ghcr\.io/[a-z0-9._/-]+:[a-z0-9._-]+$ ]] || {
	printf 'provider-backed Rush toolchain acceptance produced an invalid cache reference\n' >&2
	exit 1
}

toolchain_tarball="${RUSH_TOOLCHAIN_PROVIDER_WORK}/toolchain.tar"
toolchain_export_log="${RUSH_TOOLCHAIN_PROVIDER_WORK}/toolchain-export.log"
export RUSH_TOOLCHAIN_PROVIDER_PULL_TOKEN="${protected_token}"
DAGGER_NO_NAG=1 dagger --silent -c \
	"container | with-registry-auth ghcr.io ${GITHUB_ACTOR} \$(secret env://RUSH_TOOLCHAIN_PROVIDER_PULL_TOKEN) | from ${toolchain_reference} | as-tarball | export ${toolchain_tarball}" \
	>"${toolchain_export_log}" 2>&1
unset RUSH_TOOLCHAIN_PROVIDER_PULL_TOKEN
assert_files_redacted "${toolchain_export_log}"

protected_values_file="${RUSH_TOOLCHAIN_PROVIDER_WORK}/protected-values.env"
{
	printf 'RUSH_TOOLCHAIN_GITHUB_USERNAME=%s\n' "${GITHUB_ACTOR}"
	printf 'RUSH_TOOLCHAIN_GITHUB_TOKEN=%s\n' "${protected_token}"
	printf 'RD_OCI_GHCR_USERNAME=%s\n' "${application_username}"
	printf 'RD_OCI_GHCR_TOKEN=%s\n' "${application_token}"
	printf 'RD_OCI_COSIGN_PRIVATE_KEY=%s\n' "${application_private_key}"
	printf 'RD_OCI_COSIGN_PASSWORD=%s\n' "${application_password}"
	printf 'RD_OCI_COSIGN_PUBLIC_KEY=%s\n' "${application_public_key}"
} >"${protected_values_file}"
chmod 600 "${protected_values_file}"
node "${RUSH_TOOLCHAIN_PROVIDER_DIR}/verify-oci-acceptance.mjs" \
	--assert-image-protected-absent \
	"${toolchain_tarball}" \
	"${protected_values_file}" \
	>"${RUSH_TOOLCHAIN_PROVIDER_WORK}/toolchain-scan.log"

printf '%s\n' 'rush-delivery provider-backed custom Rush toolchain acceptance passed'
