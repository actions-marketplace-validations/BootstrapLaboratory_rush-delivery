#!/usr/bin/env bash

oci_acceptance_resolve_registry_credentials() {
	local registry="$1"
	local github_project_mode="$2"
	local random_suffix="$3"

	if [[ ${github_project_mode} == true ]]; then
		: "${GITHUB_ACTOR:?GitHub project acceptance requires GITHUB_ACTOR}"
		: "${GITHUB_TOKEN:?GitHub project acceptance requires GITHUB_TOKEN}"
		username="${GITHUB_ACTOR}"
		token="${GITHUB_TOKEN}"
		return 0
	fi

	if [[ ${registry} == ttl.sh ]]; then
		username="${OCI_ACCEPTANCE_USERNAME:-SENTINEL_OCI_USERNAME_${random_suffix}}"
		token="${OCI_ACCEPTANCE_TOKEN:-SENTINEL_OCI_TOKEN_${random_suffix}}"
		return 0
	fi

	: "${OCI_ACCEPTANCE_USERNAME:?explicit registry acceptance requires OCI_ACCEPTANCE_USERNAME}"
	: "${OCI_ACCEPTANCE_TOKEN:?explicit registry acceptance requires OCI_ACCEPTANCE_TOKEN}"
	username="${OCI_ACCEPTANCE_USERNAME}"
	token="${OCI_ACCEPTANCE_TOKEN}"
}

oci_acceptance_retry_read() {
	local attempts="$1"
	local delay_seconds="$2"
	shift 2

	local attempt
	for ((attempt = 1; attempt <= attempts; attempt += 1)); do
		if "$@"; then
			return 0
		fi

		if ((attempt < attempts)) && [[ ${delay_seconds} != 0 ]]; then
			sleep "${delay_seconds}"
		fi
	done

	return 1
}

oci_acceptance_require_bounded_integer() {
	local label="$1"
	local value="$2"
	local minimum="$3"
	local maximum="$4"

	if [[ ! ${value} =~ ^[0-9]+$ ]] ||
		((10#${value} < minimum || 10#${value} > maximum)); then
		printf 'OCI acceptance configuration: %s must be an integer from %s through %s\n' \
			"${label}" "${minimum}" "${maximum}" >&2
		return 2
	fi
}

oci_acceptance_node_runtime_ready() {
	node -e '
const { zstdDecompress } = require("node:zlib");
const major = Number.parseInt(process.versions.node.split(".")[0], 10);
if (major !== 24 || typeof zstdDecompress !== "function") process.exit(1);
' >/dev/null 2>&1
}

oci_acceptance_registry_ready() {
	local registry="$1"
	local status

	status="$(
		curl \
			--connect-timeout "${OCI_ACCEPTANCE_CONNECT_TIMEOUT_SECONDS:-5}" \
			--max-time "${OCI_ACCEPTANCE_REQUEST_TIMEOUT_SECONDS:-15}" \
			--output /dev/null \
			--silent \
			--show-error \
			--write-out '%{http_code}' \
			"https://${registry}/v2/"
	)" || return 1

	case "${status}" in
	200 | 401 | 403) return 0 ;;
	*) return 1 ;;
	esac
}

oci_acceptance_classify_failure() {
	local log_file="$1"
	local mutation_started="$2"
	local exit_status="${3:-1}"

	if [[ ${exit_status} == 124 || ${exit_status} == 137 ]]; then
		if [[ ${mutation_started} == true ]]; then
			printf 'mutation-timeout-ambiguous\n'
		else
			printf 'operation-timeout\n'
		fi
		return 0
	fi

	if grep -Eqi \
		'connection (refused|reset)|context deadline|dial tcp|i/o timeout|network is unreachable|no such host|TLS handshake timeout|unexpected EOF' \
		"${log_file}"; then
		if [[ ${mutation_started} == true ]]; then
			printf 'registry-transport-ambiguous\n'
		else
			printf 'registry-transport\n'
		fi
		return 0
	fi

	printf 'product-contract\n'
}

oci_acceptance_run_with_timeout() {
	local timeout_seconds="$1"
	local log_file="$2"
	local kill_after_seconds="${OCI_ACCEPTANCE_TIMEOUT_KILL_AFTER_SECONDS:-10}"
	shift 2

	if [[ ! ${timeout_seconds} =~ ^[1-9][0-9]*$ ||
		! ${kill_after_seconds} =~ ^[1-9][0-9]*$ ]] ||
		((10#${kill_after_seconds} > 60)); then
		printf 'OCI acceptance timeout must be a positive integer number of seconds\n' >&2
		return 2
	fi
	if (($# == 0)); then
		printf 'OCI acceptance timeout wrapper requires a command\n' >&2
		return 2
	fi

	timeout \
		--signal=TERM \
		--kill-after="${kill_after_seconds}s" \
		"${timeout_seconds}s" \
		"$@" >"${log_file}" 2>&1
}

oci_acceptance_assert_absent() {
	local log_file="$1"
	shift
	local contents

	contents="$(<"${log_file}")"

	local value
	for value in "$@"; do
		[[ -n ${value} ]] || continue
		if [[ ${contents} == *"${value}"* ]]; then
			printf 'OCI acceptance log contains protected material\n' >&2
			return 1
		fi
	done
}

oci_acceptance_assert_protected_file_absent() {
	local verifier="$1"
	local inspected_file="$2"
	local protected_values_file="$3"
	local docker_config_file="$4"

	if ! node "${verifier}" \
		--assert-protected-absent \
		"${inspected_file}" \
		"${protected_values_file}" \
		"${docker_config_file}" >/dev/null 2>&1; then
		printf 'OCI acceptance captured output contains protected material\n' >&2
		return 1
	fi
}

oci_acceptance_rewrite_provider_coordinates() {
	local provider_file="$1"
	local registry="$2"
	local repository_prefix="$3"

	OCI_ACCEPTANCE_PROVIDER_REGISTRY="${registry}" \
		OCI_ACCEPTANCE_PROVIDER_REPOSITORY_PREFIX="${repository_prefix}" \
		node - "${provider_file}" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");

const providerPath = process.argv[2];
const registry = process.env.OCI_ACCEPTANCE_PROVIDER_REGISTRY;
const repositoryPrefix =
  process.env.OCI_ACCEPTANCE_PROVIDER_REPOSITORY_PREFIX;
const registryTemplate = "    registry: ghcr.io\n";
const repositoryTemplate =
  "    repository_prefix: example/rush-delivery-tutorial\n";
const source = readFileSync(providerPath, "utf8");

if (
  !registry ||
  !repositoryPrefix ||
  source.split(registryTemplate).length !== 2 ||
  source.split(repositoryTemplate).length !== 2
) {
  throw new Error("Canonical OCI provider template does not match acceptance expectations.");
}

writeFileSync(
  providerPath,
  source
    .replace(registryTemplate, `    registry: ${registry}\n`)
    .replace(
      repositoryTemplate,
      `    repository_prefix: ${repositoryPrefix}\n`,
    ),
);
NODE
}

oci_acceptance_write_diagnostic() {
	local diagnostic_path="$1"
	local outcome="$2"
	local failure_class="$3"
	local mutation_state="$4"
	local cleanup_state="$5"

	case "${outcome}" in
	pending | passed | failed) ;;
	*) return 2 ;;
	esac
	case "${failure_class}" in
	none | internal-error | configuration | node-runtime | registry-readiness | key-generation | product-contract | registry-transport | registry-transport-ambiguous | operation-timeout | mutation-timeout-ambiguous | verification-contract | registry-immutable-read | deploy-contract | registry-cleanup | temp-cleanup) ;;
	*) return 2 ;;
	esac
	case "${mutation_state}" in
	not-started | started | completed) ;;
	*) return 2 ;;
	esac
	case "${cleanup_state}" in
	not-required | pending | succeeded | failed) ;;
	*) return 2 ;;
	esac

	if [[ ${diagnostic_path} != /* || ${diagnostic_path} != */rush-delivery-oci-acceptance-diagnostic.txt || -L ${diagnostic_path} ]]; then
		printf 'OCI acceptance diagnostic path is not an allowed absolute artifact path\n' >&2
		return 2
	fi
	if [[ ! -d ${diagnostic_path%/*} ]]; then
		printf 'OCI acceptance diagnostic parent directory does not exist\n' >&2
		return 2
	fi

	(
		umask 077
		{
			printf 'schema=rush-delivery-oci-acceptance-diagnostic/v1\n'
			printf 'outcome=%s\n' "${outcome}"
			printf 'failure_class=%s\n' "${failure_class}"
			printf 'mutation_state=%s\n' "${mutation_state}"
			printf 'cleanup_state=%s\n' "${cleanup_state}"
		} >"${diagnostic_path}"
		chmod 600 "${diagnostic_path}"
	)
}

oci_acceptance_cleanup_tree() {
	local temp_root="$1"
	local target="$2"

	if [[ -z ${target} || ${target} != "${temp_root%/}/rush-delivery-oci-acceptance."* ]]; then
		printf 'refusing unsafe OCI acceptance cleanup target\n' >&2
		return 1
	fi

	if [[ -d ${target} ]]; then
		find "${target}" -depth -delete
	fi
}

oci_acceptance_run_cleanup_hook() {
	local hook="$1"
	local registry="$2"
	local repository_prefix="$3"
	local package_suffixes="$4"
	local github_token="$5"
	local username="$6"
	local token="$7"

	[[ -n ${hook} ]] || return 0

	OCI_ACCEPTANCE_CLEANUP_REGISTRY="${registry}" \
		OCI_ACCEPTANCE_CLEANUP_REPOSITORY_PREFIX="${repository_prefix}" \
		OCI_ACCEPTANCE_CLEANUP_PACKAGE_SUFFIXES="${package_suffixes}" \
		OCI_ACCEPTANCE_CLEANUP_USERNAME="${username}" \
		OCI_ACCEPTANCE_CLEANUP_TOKEN="${token}" \
		GITHUB_TOKEN="${github_token}" \
		"${hook}" >/dev/null 2>&1
}
