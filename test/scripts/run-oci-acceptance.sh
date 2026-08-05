#!/usr/bin/env bash
set -euo pipefail

OCI_ACCEPTANCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OCI_ACCEPTANCE_REPO_ROOT="$(cd -- "${OCI_ACCEPTANCE_DIR}/../.." && pwd)"
OCI_ACCEPTANCE_LIB="${OCI_ACCEPTANCE_DIR}/lib/oci-acceptance.sh"
OCI_ACCEPTANCE_FIXTURE_SOURCE="${OCI_ACCEPTANCE_REPO_ROOT}/examples/oci-application-image-rush-repo"
OCI_ACCEPTANCE_COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849"
OCI_ACCEPTANCE_GIT_SHA="0123456789abcdef0123456789abcdef01234567"
OCI_ACCEPTANCE_TEMP_ROOT="${TMPDIR:-/tmp}"
OCI_ACCEPTANCE_TEMP="$(mktemp -d "${OCI_ACCEPTANCE_TEMP_ROOT%/}/rush-delivery-oci-acceptance.XXXXXX")"
registry=""
repository_prefix=""
cleanup_hook=""
cleanup_github_token=""
acceptance_log=""
namespace_record_path="${OCI_ACCEPTANCE_NAMESPACE_RECORD_PATH-}"
declare -ar OCI_ACCEPTANCE_PACKAGE_SUFFIXES=(control-plane-api)
printf -v cleanup_package_suffixes '%s\n' "${OCI_ACCEPTANCE_PACKAGE_SUFFIXES[@]}"
cleanup_package_suffixes="${cleanup_package_suffixes%$'\n'}"
cleanup_registered=false
diagnostic_path="${OCI_ACCEPTANCE_DIAGNOSTIC_PATH-}"
diagnostic_outcome=failed
diagnostic_failure_class="internal-error"
diagnostic_failure_stage=internal
diagnostic_mutation_state="not-started"
diagnostic_cleanup_state="not-required"

# shellcheck source=test/scripts/lib/oci-acceptance.sh
source "${OCI_ACCEPTANCE_LIB}"

cleanup() {
	local original_status=$?
	local cleanup_failed=false

	trap - EXIT

	if [[ ${cleanup_registered} == true && -n ${cleanup_hook} ]]; then
		diagnostic_cleanup_state=pending
		set +e
		oci_acceptance_run_cleanup_hook \
			"${cleanup_hook}" \
			"${registry}" \
			"${repository_prefix}" \
			"${cleanup_package_suffixes}" \
			"${cleanup_github_token}" \
			"${username}" \
			"${token}"
		local cleanup_hook_status=$?
		set -e
		if ((cleanup_hook_status != 0)); then
			printf 'OCI acceptance infrastructure [registry-cleanup]: disposable namespace cleanup failed; inspect the configured endpoint before retrying\n' >&2
			cleanup_failed=true
			diagnostic_cleanup_state=failed
			if ((original_status == 0)); then
				diagnostic_failure_class="registry-cleanup"
				diagnostic_failure_stage="registry-cleanup"
			fi
		else
			diagnostic_cleanup_state=succeeded
		fi
	fi

	set +e
	oci_acceptance_cleanup_tree "${OCI_ACCEPTANCE_TEMP_ROOT}" "${OCI_ACCEPTANCE_TEMP}"
	local cleanup_tree_status=$?
	set -e
	if ((cleanup_tree_status != 0)); then
		cleanup_failed=true
		diagnostic_cleanup_state=failed
		if ((original_status == 0)); then
			diagnostic_failure_class="temp-cleanup"
			diagnostic_failure_stage="temp-cleanup"
		fi
	fi

	if ((original_status == 0)) && [[ ${cleanup_failed} == true ]]; then
		original_status=1
	fi
	if ((original_status == 0)); then
		diagnostic_outcome=passed
		diagnostic_failure_class=none
		diagnostic_failure_stage=none
		diagnostic_mutation_state=completed
	else
		diagnostic_outcome=failed
	fi

	if [[ -n ${diagnostic_path} ]]; then
		set +e
		oci_acceptance_write_diagnostic \
			"${diagnostic_path}" \
			"${diagnostic_outcome}" \
			"${diagnostic_failure_class}" \
			"${diagnostic_failure_stage}" \
			"${diagnostic_mutation_state}" \
			"${diagnostic_cleanup_state}"
		local diagnostic_write_status=$?
		set -e
		if ((diagnostic_write_status != 0)); then
			printf 'OCI acceptance infrastructure: failed to write the controlled diagnostic artifact\n' >&2
			original_status=1
		fi
	fi

	exit "${original_status}"
}
trap cleanup EXIT

if [[ -n ${diagnostic_path} ]]; then
	oci_acceptance_write_diagnostic \
		"${diagnostic_path}" pending none none not-started not-required
fi

require_command() {
	command -v "$1" >/dev/null 2>&1 || {
		printf 'OCI acceptance infrastructure: required command is unavailable: %s\n' "$1" >&2
		exit 1
	}
}

require_command curl
require_command dagger
require_command node
require_command tar
require_command timeout

assert_protected_capture() {
	set +e
	oci_acceptance_assert_protected_file_absent \
		"${OCI_ACCEPTANCE_DIR}/verify-oci-acceptance.mjs" "$@"
	local protected_capture_status=$?
	set -e
	if ((protected_capture_status != 0)); then
		diagnostic_failure_class="verification-contract"
		diagnostic_failure_stage="protected-output"
		return 1
	fi
}

diagnostic_failure_class="node-runtime"
diagnostic_failure_stage="node-runtime"
set +e
oci_acceptance_node_runtime_ready
node_runtime_status=$?
set -e
if ((node_runtime_status != 0)); then
	printf 'OCI acceptance infrastructure [node-runtime]: pinned Node.js 24 with built-in zstd support is required\n' >&2
	exit 1
fi

diagnostic_failure_class=configuration
diagnostic_failure_stage=configuration
probe_attempts="${OCI_ACCEPTANCE_PROBE_ATTEMPTS:-3}"
probe_delay_seconds="${OCI_ACCEPTANCE_PROBE_DELAY_SECONDS:-2}"
OCI_ACCEPTANCE_CONNECT_TIMEOUT_SECONDS="${OCI_ACCEPTANCE_CONNECT_TIMEOUT_SECONDS:-5}"
OCI_ACCEPTANCE_REQUEST_TIMEOUT_SECONDS="${OCI_ACCEPTANCE_REQUEST_TIMEOUT_SECONDS:-15}"
key_generation_timeout_seconds="${OCI_ACCEPTANCE_KEY_GENERATION_TIMEOUT_SECONDS:-300}"
mutation_timeout_seconds="${OCI_ACCEPTANCE_MUTATION_TIMEOUT_SECONDS:-1800}"
read_attempts="${OCI_ACCEPTANCE_READ_ATTEMPTS:-3}"
read_delay_seconds="${OCI_ACCEPTANCE_READ_DELAY_SECONDS:-2}"
read_timeout_seconds="${OCI_ACCEPTANCE_READ_TIMEOUT_SECONDS:-300}"
deploy_timeout_seconds="${OCI_ACCEPTANCE_DEPLOY_TIMEOUT_SECONDS:-300}"
local_verification_timeout_seconds="${OCI_ACCEPTANCE_LOCAL_VERIFICATION_TIMEOUT_SECONDS:-60}"
OCI_ACCEPTANCE_TIMEOUT_KILL_AFTER_SECONDS="${OCI_ACCEPTANCE_TIMEOUT_KILL_AFTER_SECONDS:-10}"

oci_acceptance_require_bounded_integer "probe attempts" "${probe_attempts}" 1 5
oci_acceptance_require_bounded_integer "probe delay" "${probe_delay_seconds}" 0 30
oci_acceptance_require_bounded_integer "connect timeout" "${OCI_ACCEPTANCE_CONNECT_TIMEOUT_SECONDS}" 1 30
oci_acceptance_require_bounded_integer "request timeout" "${OCI_ACCEPTANCE_REQUEST_TIMEOUT_SECONDS}" 1 60
oci_acceptance_require_bounded_integer "key-generation timeout" "${key_generation_timeout_seconds}" 1 600
oci_acceptance_require_bounded_integer "mutation timeout" "${mutation_timeout_seconds}" 1 2400
oci_acceptance_require_bounded_integer "read attempts" "${read_attempts}" 1 5
oci_acceptance_require_bounded_integer "read delay" "${read_delay_seconds}" 0 30
oci_acceptance_require_bounded_integer "read timeout" "${read_timeout_seconds}" 1 600
oci_acceptance_require_bounded_integer "deploy timeout" "${deploy_timeout_seconds}" 1 600
oci_acceptance_require_bounded_integer "local verification timeout" "${local_verification_timeout_seconds}" 1 120
oci_acceptance_require_bounded_integer "timeout kill-after" "${OCI_ACCEPTANCE_TIMEOUT_KILL_AFTER_SECONDS}" 1 60

random_suffix="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
registry="${OCI_ACCEPTANCE_REGISTRY-}"
repository_prefix="${OCI_ACCEPTANCE_REPOSITORY_PREFIX-}"
cleanup_hook="${OCI_ACCEPTANCE_CLEANUP_HOOK-}"
retention_policy="${OCI_ACCEPTANCE_RETENTION_POLICY-}"
github_project_mode=false

if [[ -z ${registry} ]]; then
	if [[ ${GITHUB_REPOSITORY-} == BootstrapLaboratory/rush-delivery &&
		-n ${GITHUB_ACTOR-} && -n ${GITHUB_TOKEN-} ]]; then
		registry=ghcr.io
		repository_prefix="bootstraplaboratory/rush-delivery-acceptance-${random_suffix}"
		cleanup_hook="${cleanup_hook:-${OCI_ACCEPTANCE_DIR}/cleanup-ghcr-acceptance.sh}"
		retention_policy="${retention_policy:-delete-complete-package-on-exit}"
		github_project_mode=true
	else
		printf 'OCI acceptance configuration: set an explicit trusted-TLS OCI_ACCEPTANCE_REGISTRY and harness-owned credentials; no public registry is selected implicitly\n' >&2
		exit 1
	fi
fi

if [[ ${registry} == ttl.sh ]]; then
	repository_prefix="${repository_prefix:-rush-delivery-v081-acceptance-${random_suffix}}"
	retention_policy="${retention_policy:-ttl.sh-provider-expiry}"
fi

username=""
token=""
oci_acceptance_resolve_registry_credentials \
	"${registry}" "${github_project_mode}" "${random_suffix}"
if [[ ${github_project_mode} == true ]]; then
	cleanup_github_token="${GITHUB_TOKEN-}"
fi
unset GITHUB_TOKEN
unset OCI_ACCEPTANCE_USERNAME OCI_ACCEPTANCE_TOKEN
signing_password="${OCI_ACCEPTANCE_SIGNING_PASSWORD:-SENTINEL_OCI_PASSWORD_${random_suffix}}"

if [[ -z ${repository_prefix} || -z ${retention_policy} ]]; then
	printf 'OCI acceptance configuration: repository prefix and retention policy are required for the selected endpoint\n' >&2
	exit 1
fi

if [[ -n ${namespace_record_path} && ${github_project_mode} != true ]]; then
	printf 'OCI acceptance configuration: namespace recovery records are reserved for the project-controlled GHCR run\n' >&2
	exit 1
fi

if [[ -n ${cleanup_hook} && (${cleanup_hook} != /* || ! -x ${cleanup_hook}) ]]; then
	printf 'OCI acceptance configuration: cleanup hook must be an absolute executable file\n' >&2
	exit 1
fi

if [[ ! ${registry} =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?$ ]]; then
	printf 'OCI acceptance configuration: registry must be a normalized authority\n' >&2
	exit 1
fi

if [[ ! ${repository_prefix} =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]]; then
	printf 'OCI acceptance configuration: repository prefix must be a normalized path\n' >&2
	exit 1
fi

if [[ ! ${username} =~ ^[A-Za-z0-9_.@-]+$ ]]; then
	printf 'OCI acceptance configuration: username contains unsupported characters\n' >&2
	exit 1
fi

set +e
oci_acceptance_retry_read \
	"${probe_attempts}" \
	"${probe_delay_seconds}" \
	oci_acceptance_registry_ready "${registry}"
registry_readiness_status=$?
set -e
if ((registry_readiness_status != 0)); then
	diagnostic_failure_class="registry-readiness"
	diagnostic_failure_stage="registry-readiness"
	printf 'OCI acceptance infrastructure [registry-transport]: trusted-TLS registry readiness failed after bounded retries\n' >&2
	exit 1
fi

export OCI_ACCEPTANCE_SIGNING_PASSWORD="${signing_password}"
key_directory="${OCI_ACCEPTANCE_TEMP}/keys"
mkdir -p "${key_directory}"

diagnostic_failure_class="key-generation"
diagnostic_failure_stage="key-generation"
key_generation_log="${OCI_ACCEPTANCE_TEMP}/key-generation.log"
set +e
oci_acceptance_run_with_timeout \
	"${key_generation_timeout_seconds}" \
	"${key_generation_log}" \
	env DAGGER_NO_NAG=1 dagger --silent -c \
	"container | from ${OCI_ACCEPTANCE_COSIGN_IMAGE} | with-new-file /tmp/rush-delivery-key-generation-cache ${random_suffix} | with-secret-variable COSIGN_PASSWORD \$(secret env://OCI_ACCEPTANCE_SIGNING_PASSWORD) | with-workdir /keys | with-exec --args=/ko-app/cosign,generate-key-pair,--output-key-prefix,/keys/cosign | directory /keys | export ${key_directory}"
key_generation_status=$?
set -e
set +e
oci_acceptance_assert_absent \
	"${key_generation_log}" "${username}" "${token}" "${signing_password}"
key_generation_protected_status=$?
set -e
if ((key_generation_protected_status != 0)); then
	diagnostic_failure_class="verification-contract"
	diagnostic_failure_stage="protected-output"
	exit 1
fi
if ((key_generation_status != 0)); then
	printf 'OCI acceptance infrastructure [key-generation]: pinned Cosign key generation failed\n' >&2
	exit "${key_generation_status}"
fi
unset OCI_ACCEPTANCE_SIGNING_PASSWORD
diagnostic_failure_class=configuration
diagnostic_failure_stage=configuration

private_key="$(awk '{printf "%s\\n", $0}' "${key_directory}/cosign.key")"
public_key="$(awk '{printf "%s\\n", $0}' "${key_directory}/cosign.pub")"
deploy_env="${OCI_ACCEPTANCE_TEMP}/deploy.env"
{
	printf 'RD_OCI_GHCR_USERNAME=%s\n' "${username}"
	printf 'RD_OCI_GHCR_TOKEN=%s\n' "${token}"
	printf 'RD_OCI_COSIGN_PRIVATE_KEY=%s\n' "${private_key}"
	printf 'RD_OCI_COSIGN_PASSWORD=%s\n' "${signing_password}"
	printf 'RD_OCI_COSIGN_PUBLIC_KEY=%s\n' "${public_key}"
} >"${deploy_env}"
chmod 600 "${deploy_env}"

docker_config="${OCI_ACCEPTANCE_TEMP}/docker-config.json"
OCI_ACCEPTANCE_DOCKER_CONFIG_REGISTRY="${registry}" \
	OCI_ACCEPTANCE_DOCKER_CONFIG_USERNAME="${username}" \
	OCI_ACCEPTANCE_DOCKER_CONFIG_TOKEN="${token}" \
	node - "${docker_config}" <<'NODE'
const { writeFileSync } = require("node:fs");

const outputPath = process.argv[2];
const registry = process.env.OCI_ACCEPTANCE_DOCKER_CONFIG_REGISTRY;
const username = process.env.OCI_ACCEPTANCE_DOCKER_CONFIG_USERNAME;
const token = process.env.OCI_ACCEPTANCE_DOCKER_CONFIG_TOKEN;

if (!outputPath || !registry || !username || !token) {
  throw new Error("OCI acceptance Docker configuration inputs are incomplete.");
}

const auth = Buffer.from(`${username}:${token}`, "utf8").toString("base64");
const contents = `${JSON.stringify({ auths: { [registry]: { auth } } })}\n`;

writeFileSync(outputPath, contents, { encoding: "utf8", mode: 0o600 });
NODE

fixture="${OCI_ACCEPTANCE_TEMP}/fixture"
mkdir -p "${fixture}"
tar \
	--exclude='./.dagger/runtime' \
	--exclude='./apps/control-plane-api/.rush' \
	--exclude='./apps/control-plane-api/dist' \
	--exclude='./apps/control-plane-api/node_modules' \
	--exclude='./apps/control-plane-api/rush-logs' \
	--exclude='./common/temp' \
	--exclude='./node_modules' \
	-C "${OCI_ACCEPTANCE_FIXTURE_SOURCE}" \
	-cf - . | tar -C "${fixture}" -xf -
oci_acceptance_rewrite_provider_coordinates \
	"${fixture}/.dagger/application-images/providers.yaml" \
	"${registry}" \
	"${repository_prefix}"

if [[ -n ${namespace_record_path} ]]; then
	oci_acceptance_write_namespace_record \
		"${namespace_record_path}" \
		"${registry}" \
		"${repository_prefix}" \
		"${OCI_ACCEPTANCE_PACKAGE_SUFFIXES[0]}"
fi

output_directory="${OCI_ACCEPTANCE_TEMP}/output"
acceptance_log="${OCI_ACCEPTANCE_TEMP}/acceptance.log"
cleanup_registered=true
diagnostic_failure_class="product-contract"
diagnostic_failure_stage="package-contract"
diagnostic_mutation_state="not-started"
if [[ -n ${cleanup_hook} ]]; then
	diagnostic_cleanup_state=pending
fi
set +e
oci_acceptance_run_with_timeout \
	"${mutation_timeout_seconds}" \
	"${acceptance_log}" \
	env DAGGER_NO_NAG=1 dagger --progress=logs call build-and-package-deploy-targets \
	--repo="${fixture}" \
	--ci-plan-file="${fixture}/ci/oci-plan.json" \
	--git-sha="${OCI_ACCEPTANCE_GIT_SHA}" \
	--source-repository-url="https://github.com/BootstrapLaboratory/rush-delivery.git" \
	--dry-run=false \
	--deploy-env-file="${deploy_env}" \
	--application-image-provider=ghcr \
	export --path="${output_directory}"
acceptance_status=$?
set -e

diagnostic_failure_stage="$(
	oci_acceptance_classify_failure_stage "${acceptance_log}"
)"
diagnostic_mutation_state="$(
	oci_acceptance_detect_mutation_state \
		"${acceptance_log}" "${acceptance_status}" \
		"${diagnostic_failure_stage}"
)"

assert_protected_capture \
	"${acceptance_log}" "${deploy_env}" "${docker_config}"

if ((acceptance_status != 0)); then
	failure_class="$(
		oci_acceptance_classify_failure \
			"${acceptance_log}" "${diagnostic_mutation_state}" "${acceptance_status}"
	)"
	diagnostic_failure_class="${failure_class}"
	if [[ ${failure_class} == registry-transport-ambiguous ]]; then
		printf 'OCI acceptance infrastructure [registry-transport-ambiguous]: publication may have started; inspect and clean the unique namespace before a manual retry\n' >&2
	elif [[ ${failure_class} == mutation-timeout-ambiguous ]]; then
		printf 'OCI acceptance infrastructure [mutation-timeout-ambiguous]: the bounded package mutation timed out; publication may have completed and the unique namespace must be inspected before a manual retry\n' >&2
	else
		printf 'OCI acceptance [%s/%s]: package/evidence flow failed; inspect the controlled diagnostic artifact\n' \
			"${failure_class}" "${diagnostic_failure_stage}" >&2
	fi
	exit "${acceptance_status}"
fi

diagnostic_mutation_state=completed

diagnostic_failure_class="verification-contract"
diagnostic_failure_stage="bundle-verification"
bundle_verification_log="${OCI_ACCEPTANCE_TEMP}/bundle-verification.log"
set +e
oci_acceptance_run_with_timeout \
	"${local_verification_timeout_seconds}" \
	"${bundle_verification_log}" \
	node "${OCI_ACCEPTANCE_DIR}/verify-oci-acceptance.mjs" \
	"${output_directory}" \
	"${OCI_ACCEPTANCE_GIT_SHA}" \
	"${deploy_env}" \
	"${registry}/${repository_prefix}/control-plane-api" \
	"" \
	"" \
	"${docker_config}"
bundle_verification_status=$?
set -e
assert_protected_capture \
	"${bundle_verification_log}" "${deploy_env}" "${docker_config}"
if ((bundle_verification_status != 0)); then
	printf 'OCI acceptance [verification-contract]: local package and evidence verification failed\n' >&2
	exit "${bundle_verification_status}"
fi

published_reference="$(
	node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(manifest.artifacts["control-plane-api"].reference);
' "${output_directory}/.dagger/runtime/package-manifest.json"
)"

cosign_verification_log="${OCI_ACCEPTANCE_TEMP}/cosign-verification.log"
verify_published_evidence() {
	oci_acceptance_run_with_timeout \
		"${read_timeout_seconds}" \
		"${cosign_verification_log}" \
		env DAGGER_NO_NAG=1 dagger --silent -c \
		"container | from ${OCI_ACCEPTANCE_COSIGN_IMAGE} | with-env-variable DOCKER_CONFIG /home/nonroot/.docker | with-mounted-secret /home/nonroot/.docker/config.json \$(secret file://${docker_config}) --mode=256 --owner=65532:65532 | with-mounted-secret /keys/cosign.pub \$(secret file://${key_directory}/cosign.pub) --mode=256 --owner=65532:65532 | with-exec --args=/ko-app/cosign,verify,--key,/keys/cosign.pub,--insecure-ignore-tlog,${published_reference} | with-exec --args=/ko-app/cosign,verify-attestation,--key,/keys/cosign.pub,--insecure-ignore-tlog,--type,spdxjson,${published_reference} | with-exec --args=/ko-app/cosign,verify-attestation,--key,/keys/cosign.pub,--insecure-ignore-tlog,--type,slsaprovenance1,${published_reference} | sync"
}

set +e
oci_acceptance_retry_read \
	"${read_attempts}" \
	"${read_delay_seconds}" \
	verify_published_evidence
published_evidence_status=$?
set -e
if ((published_evidence_status != 0)); then
	assert_protected_capture \
		"${cosign_verification_log}" "${deploy_env}" "${docker_config}"
	if grep -Eqi \
		'connection (refused|reset)|context deadline|dial tcp|i/o timeout|network is unreachable|no such host|TLS handshake timeout|unexpected EOF' \
		"${cosign_verification_log}"; then
		diagnostic_failure_class="registry-immutable-read"
		diagnostic_failure_stage="registry-immutable-read"
		printf 'OCI acceptance infrastructure [registry-immutable-read]: independent Cosign verification could not read the immutable subject after bounded retries\n' >&2
	else
		diagnostic_failure_class="verification-contract"
		diagnostic_failure_stage="bundle-verification"
		printf 'OCI acceptance [verification-contract]: independent Cosign verification rejected the subject signature or required attestations\n' >&2
	fi
	exit 1
fi

assert_protected_capture \
	"${cosign_verification_log}" "${deploy_env}" "${docker_config}"

image_tarball="${OCI_ACCEPTANCE_TEMP}/published-image.tar"
image_export_log="${OCI_ACCEPTANCE_TEMP}/image-export.log"
export OCI_ACCEPTANCE_REGISTRY_TOKEN="${token}"

export_published_image() {
	oci_acceptance_run_with_timeout \
		"${read_timeout_seconds}" \
		"${image_export_log}" \
		env DAGGER_NO_NAG=1 dagger --silent -c \
		"container | with-registry-auth ${registry} ${username} \$(secret env://OCI_ACCEPTANCE_REGISTRY_TOKEN) | from ${published_reference} | as-tarball | export ${image_tarball}"
}

set +e
oci_acceptance_retry_read \
	"${read_attempts}" \
	"${read_delay_seconds}" \
	export_published_image
image_export_status=$?
set -e
unset OCI_ACCEPTANCE_REGISTRY_TOKEN
if ((image_export_status != 0)); then
	assert_protected_capture \
		"${image_export_log}" "${deploy_env}" "${docker_config}"
	diagnostic_failure_class="registry-immutable-read"
	diagnostic_failure_stage="registry-immutable-read"
	printf 'OCI acceptance infrastructure [registry-immutable-read]: published digest could not be exported after bounded retries\n' >&2
	exit 1
fi

assert_protected_capture \
	"${image_export_log}" "${deploy_env}" "${docker_config}"

deploy_result="${OCI_ACCEPTANCE_TEMP}/deploy-result.json"
deploy_log="${OCI_ACCEPTANCE_TEMP}/deploy.log"
set +e
# Expansion belongs to the nested Bash process.
# shellcheck disable=SC2016
oci_acceptance_run_with_timeout \
	"${deploy_timeout_seconds}" \
	"${deploy_log}" \
	bash -c 'deploy_result="$1"; shift; "$@" >"${deploy_result}"' \
	bash \
	"${deploy_result}" \
	env DAGGER_NO_NAG=1 dagger --silent call --json deploy-release \
	--repo="${output_directory}" \
	--git-sha="${OCI_ACCEPTANCE_GIT_SHA}" \
	--release-targets-json='["control-plane-api"]' \
	--environment=acceptance \
	--dry-run=false \
	--package-manifest-file="${output_directory}/.dagger/runtime/package-manifest.json"
deploy_status=$?
set -e

for protected_log in "${deploy_result}" "${deploy_log}"; do
	assert_protected_capture \
		"${protected_log}" "${deploy_env}" "${docker_config}"
done

if ((deploy_status != 0)); then
	deploy_failure_class="$(
		oci_acceptance_classify_failure \
			"${deploy_log}" started "${deploy_status}"
	)"
	if [[ ${deploy_failure_class} == mutation-timeout-ambiguous || ${deploy_failure_class} == registry-transport-ambiguous ]]; then
		diagnostic_failure_class="${deploy_failure_class}"
		diagnostic_failure_stage=deploy
		printf 'OCI acceptance infrastructure [%s]: bounded digest-only Deploy ended after mutation could have started\n' "${deploy_failure_class}" >&2
	else
		diagnostic_failure_class="deploy-contract"
		diagnostic_failure_stage=deploy
		printf 'OCI acceptance [deploy-contract]: digest-only Deploy failed; inspect the controlled diagnostic artifact\n' >&2
	fi
	exit "${deploy_status}"
fi

diagnostic_failure_class="verification-contract"
diagnostic_failure_stage="bundle-verification"
complete_verification_log="${OCI_ACCEPTANCE_TEMP}/complete-verification.log"
set +e
oci_acceptance_run_with_timeout \
	"${local_verification_timeout_seconds}" \
	"${complete_verification_log}" \
	node "${OCI_ACCEPTANCE_DIR}/verify-oci-acceptance.mjs" \
	"${output_directory}" \
	"${OCI_ACCEPTANCE_GIT_SHA}" \
	"${deploy_env}" \
	"${registry}/${repository_prefix}/control-plane-api" \
	"${image_tarball}" \
	"${deploy_result}" \
	"${docker_config}"
complete_verification_status=$?
set -e
assert_protected_capture \
	"${complete_verification_log}" "${deploy_env}" "${docker_config}"
if ((complete_verification_status != 0)); then
	printf 'OCI acceptance [verification-contract]: package, image archive, or digest-only Deploy verification failed\n' >&2
	exit "${complete_verification_status}"
fi

diagnostic_failure_class=none
diagnostic_failure_stage=none
diagnostic_mutation_state=completed
printf 'OCI acceptance passed for %s/%s (retention: %s)\n' \
	"${registry}" "${repository_prefix}" "${retention_policy}"
