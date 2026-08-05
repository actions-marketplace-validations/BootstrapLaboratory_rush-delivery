#!/usr/bin/env bash
set -euo pipefail

OCI_V081_MATRIX_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OCI_V081_MATRIX_REPO_ROOT="$(cd -- "${OCI_V081_MATRIX_SCRIPT_DIR}/../.." && pwd)"
OCI_V081_MATRIX_LIB="${OCI_V081_MATRIX_SCRIPT_DIR}/lib/oci-v081-acceptance-matrix.sh"
OCI_V081_MATRIX_GIT_SHA="0123456789abcdef0123456789abcdef01234567"
OCI_V081_MATRIX_ROLLBACK_SHA="89abcdef0123456789abcdef0123456789abcdef"
OCI_V081_MATRIX_TEMP_ROOT="${TMPDIR:-/tmp}"
OCI_V081_MATRIX_TEMP=""
OCI_V081_MATRIX_LIVE_CLEANUP_ARMED=false
OCI_V081_MATRIX_LIVE_FAULT_TEARDOWN_REQUIRED=false
OCI_V081_MATRIX_LIVE_CLEANUP_HOOK=""
OCI_V081_MATRIX_LIVE_FAULT_HOOK=""
OCI_V081_MATRIX_LIVE_REGISTRY=""
OCI_V081_MATRIX_LIVE_REPOSITORY_PREFIX=""
OCI_V081_MATRIX_LIVE_TARGETS=""
OCI_V081_MATRIX_LIVE_DEPLOY_ENV_FILE=""
OCI_V081_MATRIX_LIVE_DOCKER_CONFIG_FILE=""
OCI_V081_MATRIX_LIVE_CLEANUP_EVIDENCE=""
OCI_V081_MATRIX_LIVE_CLEANUP_LOG=""
OCI_V081_MATRIX_LIVE_FAULT_TEARDOWN_LOG=""
OCI_V081_MATRIX_LIVE_OUTPUT_ROOT=""
OCI_V081_MATRIX_LIVE_OUTPUT_MARKER=""
OCI_V081_MATRIX_FAULT_STATE_FILE=""

# shellcheck source=test/scripts/lib/oci-v081-acceptance-matrix.sh
source "${OCI_V081_MATRIX_LIB}"

list_scenarios() {
	printf '%s\n' \
		'named-provider-dry-run-without-env-file' \
		'filesystem-workflow' \
		'filesystem-package-deploy-targets' \
		'filesystem-build-and-package-deploy-targets' \
		'filesystem-deploy-release' \
		'archive-checksum-restore-separate-deploy' \
		'rollback-second-restore-without-manifest-mutation' \
		'reserved-env-attack-rejection' \
		'full-partial-mixed-evidence-isolation'
}

list_live_scenarios() {
	printf '%s\n' \
		'malformed-private-pem' \
		'malformed-public-pem' \
		'wrong-signing-password' \
		'invalid-key' \
		'mismatched-key' \
		'multi-target-success' \
		'multi-target-preparation-failure' \
		'multi-target-finalization-failure'
}

cleanup() {
	local original_status=$?

	trap - EXIT
	if [[ -n ${OCI_V081_MATRIX_TEMP} ]]; then
		if [[ ${OCI_V081_MATRIX_TEMP} != "${OCI_V081_MATRIX_TEMP_ROOT%/}/rush-delivery-v081-matrix."* ]]; then
			printf 'refusing unsafe v0.8.1 acceptance-matrix cleanup target\n' >&2
			exit 1
		fi
		find "${OCI_V081_MATRIX_TEMP}" -depth -delete
	fi
	exit "${original_status}"
}

cleanup_live_scenario() {
	local original_status=$?
	local lifecycle_failed=false
	local lifecycle_status

	trap - EXIT
	set +e
	if [[ ${OCI_V081_MATRIX_LIVE_FAULT_TEARDOWN_REQUIRED} == true ]]; then
		oci_v081_matrix_teardown_finalization_fault \
			"${OCI_V081_MATRIX_LIVE_FAULT_HOOK}" \
			"${OCI_V081_MATRIX_LIVE_REGISTRY}" \
			"${OCI_V081_MATRIX_LIVE_REPOSITORY_PREFIX}" \
			matrix-worker \
			"${OCI_V081_MATRIX_LIVE_FAULT_TEARDOWN_LOG}" \
			"${OCI_V081_MATRIX_LIVE_DEPLOY_ENV_FILE}" \
			"${OCI_V081_MATRIX_LIVE_DOCKER_CONFIG_FILE}"
		lifecycle_status=$?
		if ((lifecycle_status != 0)); then
			printf 'v0.8.1 live matrix fault teardown failed\n' >&2
			lifecycle_failed=true
		fi
	fi
	if [[ ${OCI_V081_MATRIX_LIVE_CLEANUP_ARMED} == true ]]; then
		oci_v081_matrix_cleanup_live_namespace \
			"${OCI_V081_MATRIX_LIVE_CLEANUP_HOOK}" \
			"${OCI_V081_MATRIX_LIVE_REGISTRY}" \
			"${OCI_V081_MATRIX_LIVE_REPOSITORY_PREFIX}" \
			"${OCI_V081_MATRIX_LIVE_TARGETS}" \
			"${OCI_V081_MATRIX_LIVE_CLEANUP_EVIDENCE}" \
			"${OCI_V081_MATRIX_LIVE_CLEANUP_LOG}" \
			"${OCI_V081_MATRIX_LIVE_DEPLOY_ENV_FILE}" \
			"${OCI_V081_MATRIX_LIVE_DOCKER_CONFIG_FILE}"
		lifecycle_status=$?
		if ((lifecycle_status != 0)); then
			printf 'v0.8.1 live matrix namespace cleanup or inspection failed\n' >&2
			lifecycle_failed=true
		fi
	fi
	if [[ ${lifecycle_failed} == true && ${original_status} -eq 0 ]]; then
		original_status=1
	fi
	if ((original_status != 0)); then
		if [[ -n ${OCI_V081_MATRIX_LIVE_OUTPUT_ROOT} &&
			-f ${OCI_V081_MATRIX_LIVE_OUTPUT_MARKER} ]] &&
			[[ $(<"${OCI_V081_MATRIX_LIVE_OUTPUT_MARKER}") == rush-delivery-v081-live-owned ]]; then
			find "${OCI_V081_MATRIX_LIVE_OUTPUT_ROOT}" -depth -delete
		else
			printf 'v0.8.1 live matrix refused to remove an unowned failed output root\n' >&2
		fi
	fi
	exit "${original_status}"
}

prepare_live_fixtures() {
	local destination_root="$1"
	local registry="$2"
	local repository_prefix="$3"
	local key_scenario

	[[ ! -e ${destination_root} ]] || {
		printf 'live fixture output already exists\n' >&2
		return 1
	}
	mkdir -p "${destination_root}"
	for key_scenario in \
		malformed-private-pem \
		malformed-public-pem \
		wrong-signing-password \
		invalid-key \
		mismatched-key; do
		oci_v081_matrix_build_live_fixture \
			live-single-target \
			"${destination_root}/${key_scenario}" \
			"${registry}" "${repository_prefix}/${key_scenario}"
	done
	oci_v081_matrix_build_live_fixture \
		live-multi-target-success \
		"${destination_root}/multi-target-success" \
		"${registry}" "${repository_prefix}/multi-success"
	oci_v081_matrix_build_live_fixture \
		live-multi-target-preparation-failure \
		"${destination_root}/multi-target-preparation-failure" \
		"${registry}" "${repository_prefix}/multi-preparation-failure"
	oci_v081_matrix_build_live_fixture \
		live-multi-target-finalization-failure \
		"${destination_root}/multi-target-finalization-failure" \
		"${registry}" "${repository_prefix}/multi-finalization-failure"
	printf 'Prepared non-secret live matrix fixtures at %s\n' "${destination_root}"
}

run_live_scenario() {
	local scenario="$1"
	local output_root="$2"
	local registry="${OCI_V081_MATRIX_REGISTRY:?OCI_V081_MATRIX_REGISTRY is required}"
	local repository_prefix_base="${OCI_V081_MATRIX_REPOSITORY_PREFIX:?OCI_V081_MATRIX_REPOSITORY_PREFIX is required}"
	local deploy_env_file="${OCI_V081_MATRIX_DEPLOY_ENV_FILE:?OCI_V081_MATRIX_DEPLOY_ENV_FILE is required}"
	local docker_config_file="${OCI_V081_MATRIX_DOCKER_CONFIG_FILE:?OCI_V081_MATRIX_DOCKER_CONFIG_FILE is required}"
	local inventory_hook="${OCI_V081_MATRIX_INVENTORY_HOOK:?OCI_V081_MATRIX_INVENTORY_HOOK is required}"
	local cleanup_hook="${OCI_V081_MATRIX_CLEANUP_HOOK:?OCI_V081_MATRIX_CLEANUP_HOOK is required}"
	local fault_hook="${OCI_V081_MATRIX_FAULT_HOOK-}"
	local fixture_mode
	local expected_targets
	local random_suffix
	local repository_prefix
	local fixture
	local package_output
	local captured_log
	local state_directory
	local inventory_evidence
	local inventory_log
	local pre_inventory_evidence
	local pre_inventory_log
	local fault_log

	case "${scenario}" in
	malformed-private-pem | malformed-public-pem | wrong-signing-password | invalid-key | mismatched-key)
		fixture_mode=live-single-target
		expected_targets=control-plane-api
		;;
	multi-target-success)
		fixture_mode=live-multi-target-success
		expected_targets=control-plane-api,matrix-worker
		;;
	multi-target-preparation-failure)
		fixture_mode=live-multi-target-preparation-failure
		expected_targets=control-plane-api,matrix-worker
		;;
	multi-target-finalization-failure)
		fixture_mode=live-multi-target-finalization-failure
		expected_targets=control-plane-api,matrix-worker,matrix-later
		[[ -n ${fault_hook} ]] || {
			printf 'OCI_V081_MATRIX_FAULT_HOOK is required for finalization failure\n' >&2
			return 1
		}
		;;
	*)
		printf 'unsupported v0.8.1 live matrix scenario\n' >&2
		return 1
		;;
	esac
	[[ -f ${deploy_env_file} && -f ${docker_config_file} ]] || {
		printf 'v0.8.1 live matrix protected-value inputs must be files\n' >&2
		return 1
	}
	[[ ${inventory_hook} == /* && -x ${inventory_hook} &&
		${cleanup_hook} == /* && -x ${cleanup_hook} ]] || {
		printf 'v0.8.1 live matrix inventory and cleanup hooks must be absolute executables\n' >&2
		return 1
	}
	[[ ! -e ${output_root} && ! -L ${output_root} ]] || {
		printf 'v0.8.1 live matrix output root already exists\n' >&2
		return 1
	}
	mkdir -p "${output_root}"
	OCI_V081_MATRIX_LIVE_OUTPUT_ROOT="${output_root}"
	OCI_V081_MATRIX_LIVE_OUTPUT_MARKER="${output_root}/.rush-delivery-v081-live-owned"
	printf 'rush-delivery-v081-live-owned\n' >"${OCI_V081_MATRIX_LIVE_OUTPUT_MARKER}"
	export OCI_V081_MATRIX_LIVE_OUTPUT_ROOT
	trap cleanup_live_scenario EXIT
	random_suffix="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
	[[ ${random_suffix} =~ ^[a-f0-9]{32}$ ]] || {
		printf 'v0.8.1 live matrix failed to create a unique namespace\n' >&2
		return 1
	}
	repository_prefix="${repository_prefix_base}/v081-${scenario}-${random_suffix}"
	fixture="${output_root}/fixture"
	package_output="${output_root}/package-output"
	captured_log="${output_root}/package.log"
	state_directory="${output_root}/state"
	inventory_evidence="${output_root}/registry-inventory.json"
	inventory_log="${output_root}/registry-inventory.log"
	pre_inventory_evidence="${output_root}/pre-mutation-inventory.json"
	pre_inventory_log="${output_root}/pre-mutation-inventory.log"
	fault_log="${output_root}/fault-configure.log"

	oci_v081_matrix_build_live_fixture \
		"${fixture_mode}" "${fixture}" "${registry}" "${repository_prefix}"
	OCI_V081_MATRIX_LIVE_CLEANUP_ARMED=true
	OCI_V081_MATRIX_LIVE_CLEANUP_HOOK="${cleanup_hook}"
	OCI_V081_MATRIX_LIVE_FAULT_HOOK="${fault_hook}"
	OCI_V081_MATRIX_LIVE_REGISTRY="${registry}"
	OCI_V081_MATRIX_LIVE_REPOSITORY_PREFIX="${repository_prefix}"
	OCI_V081_MATRIX_LIVE_TARGETS="${expected_targets}"
	OCI_V081_MATRIX_LIVE_DEPLOY_ENV_FILE="${deploy_env_file}"
	OCI_V081_MATRIX_LIVE_DOCKER_CONFIG_FILE="${docker_config_file}"
	OCI_V081_MATRIX_LIVE_CLEANUP_EVIDENCE="${output_root}/cleanup-inventory.json"
	OCI_V081_MATRIX_LIVE_CLEANUP_LOG="${output_root}/cleanup.log"
	OCI_V081_MATRIX_LIVE_FAULT_TEARDOWN_LOG="${output_root}/fault-teardown.log"
	trap cleanup_live_scenario EXIT

	oci_v081_matrix_capture_inventory \
		zero "${inventory_hook}" "${registry}" "${repository_prefix}" \
		"${expected_targets}" "${pre_inventory_evidence}" \
		"${pre_inventory_log}" "${deploy_env_file}" "${docker_config_file}"
	node "${OCI_V081_MATRIX_VERIFY}" live-zero-inventory \
		"${pre_inventory_evidence}" "${expected_targets}"
	case "${scenario}" in
	malformed-private-pem | malformed-public-pem | wrong-signing-password | invalid-key | mismatched-key | multi-target-preparation-failure)
		oci_v081_matrix_expect_prepublication_failure_once \
			"${scenario}" "${fixture}" "${deploy_env_file}" \
			"${package_output}" "${captured_log}" "${state_directory}" \
			"${inventory_hook}" "${registry}" "${repository_prefix}" \
			"${inventory_evidence}" "${inventory_log}" \
			"${docker_config_file}"
		;;
	multi-target-success)
		oci_v081_matrix_run_live_multi_target_success_once \
			"${fixture}" "${deploy_env_file}" "${package_output}" \
			"${captured_log}" "${state_directory}" \
			"${inventory_hook}" "${registry}" "${repository_prefix}" \
			"${inventory_evidence}" "${inventory_log}" \
			"${docker_config_file}"
		;;
	multi-target-finalization-failure)
		OCI_V081_MATRIX_FAULT_STATE_FILE="${state_directory}/finalization-fault-module"
		export OCI_V081_MATRIX_FAULT_STATE_FILE
		oci_v081_matrix_run_live_finalization_failure_once \
			"${fixture}" "${deploy_env_file}" "${package_output}" \
			"${captured_log}" "${state_directory}" \
			"${inventory_hook}" "${fault_hook}" "${registry}" \
			"${repository_prefix}" "${inventory_evidence}" \
			"${inventory_log}" "${fault_log}" "${docker_config_file}"
		;;
	*)
		printf 'v0.8.1 live matrix scenario dispatch is incomplete\n' >&2
		return 1
		;;
	esac
	printf 'v0.8.1 live matrix scenario %s checks passed; cleanup is armed and evidence is retained at %s\n' \
		"${scenario}" "${output_root}"
}

run_named_provider_dry_run() {
	local fixture="${OCI_V081_MATRIX_TEMP}/named-provider-dry"
	local output="${OCI_V081_MATRIX_TEMP}/named-provider-dry-output"

	oci_v081_matrix_build_fixture live-single-target "${fixture}"
	oci_v081_matrix_run_dagger call build-and-package-deploy-targets \
		--repo="${fixture}" \
		--ci-plan-file="${fixture}/ci/oci-plan.json" \
		--git-sha="${OCI_V081_MATRIX_GIT_SHA}" \
		--source-repository-url=https://github.com/BootstrapLaboratory/rush-delivery.git \
		--dry-run=true \
		--application-image-provider=ghcr \
		export --path="${output}"
	node "${OCI_V081_MATRIX_VERIFY}" named-dry "${output}"
}

run_filesystem_entrypoint_matrix() {
	local package_fixture="${OCI_V081_MATRIX_TEMP}/filesystem-package-source"
	local package_output="${OCI_V081_MATRIX_TEMP}/filesystem-package-output"
	local package_deploy_result="${OCI_V081_MATRIX_TEMP}/filesystem-package-deploy.json"
	local build_package_fixture="${OCI_V081_MATRIX_TEMP}/filesystem-build-package-source"
	local build_package_output="${OCI_V081_MATRIX_TEMP}/filesystem-build-package-output"
	local workflow_fixture="${OCI_V081_MATRIX_TEMP}/filesystem-workflow-source"
	local workflow_result="${OCI_V081_MATRIX_TEMP}/filesystem-workflow.json"

	oci_v081_matrix_build_fixture filesystem "${package_fixture}"
	(
		cd -- "${package_fixture}"
		oci_v081_matrix_run_bounded 60 node apps/control-plane-api/scripts/build.mjs
	)
	oci_v081_matrix_run_dagger call package-deploy-targets \
		--repo="${package_fixture}" \
		--ci-plan-file="${package_fixture}/ci/oci-plan.json" \
		--git-sha="${OCI_V081_MATRIX_GIT_SHA}" \
		--dry-run=false \
		--application-image-provider=off \
		export --path="${package_output}"
	node "${OCI_V081_MATRIX_VERIFY}" filesystem-package "${package_output}"

	oci_v081_matrix_run_dagger call --json deploy-release \
		--repo="${package_output}" \
		--git-sha="${OCI_V081_MATRIX_GIT_SHA}" \
		--release-targets-json='["control-plane-api"]' \
		--environment=matrix \
		--dry-run=false \
		--package-manifest-file="${package_output}/.dagger/runtime/package-manifest.json" \
		>"${package_deploy_result}"
	node "${OCI_V081_MATRIX_VERIFY}" \
		filesystem-deploy "${package_deploy_result}" false

	oci_v081_matrix_build_fixture filesystem "${build_package_fixture}"
	oci_v081_matrix_run_dagger call build-and-package-deploy-targets \
		--repo="${build_package_fixture}" \
		--ci-plan-file="${build_package_fixture}/ci/oci-plan.json" \
		--git-sha="${OCI_V081_MATRIX_GIT_SHA}" \
		--dry-run=false \
		--application-image-provider=off \
		export --path="${build_package_output}"
	node "${OCI_V081_MATRIX_VERIFY}" filesystem-package "${build_package_output}"

	oci_v081_matrix_build_fixture filesystem "${workflow_fixture}"
	oci_v081_matrix_initialize_git_repo "${workflow_fixture}"
	oci_v081_matrix_run_dagger call --json workflow \
		--git-sha="${OCI_V081_MATRIX_GIT_SHA}" \
		--event-name=workflow_dispatch \
		--force-targets-json='["control-plane-api"]' \
		--environment=matrix \
		--dry-run=true \
		--application-image-provider=off \
		--repo="${workflow_fixture}" \
		>"${workflow_result}"
	node "${OCI_V081_MATRIX_VERIFY}" filesystem-deploy "${workflow_result}" true
}

run_restored_deploy() {
	local restored_directory="$1"
	local git_sha="$2"
	local expected_manifest_digest="$3"
	local result_file="$4"

	oci_v081_matrix_run_dagger call --json deploy-release \
		--repo="${restored_directory}" \
		--git-sha="${git_sha}" \
		--release-targets-json='["image-a","image-b","filesystem"]' \
		--environment=matrix \
		--dry-run=false \
		--package-manifest-file="${restored_directory}/.dagger/runtime/package-manifest.json" \
		>"${result_file}"
	node "${OCI_V081_MATRIX_VERIFY}" isolation-deploy \
		"${result_file}" \
		"${restored_directory}/.dagger/runtime/package-manifest.json" \
		"${expected_manifest_digest}"
}

run_archive_restore_rollback_and_isolation() {
	local current_source="${OCI_V081_MATRIX_TEMP}/current-package-source"
	local rollback_source="${OCI_V081_MATRIX_TEMP}/rollback-package-source"
	local archive_root="${OCI_V081_MATRIX_TEMP}/protected-release-storage"
	local current_archive="${archive_root}/current.tar.gz"
	local rollback_archive="${archive_root}/rollback.tar.gz"
	local current_checksum="${archive_root}/current.sha256"
	local rollback_checksum="${archive_root}/rollback.sha256"
	local current_source_record="${archive_root}/current.git-sha"
	local rollback_source_record="${archive_root}/rollback.git-sha"
	local current_restore="${OCI_V081_MATRIX_TEMP}/restored/current"
	local rollback_restore="${OCI_V081_MATRIX_TEMP}/restored/rollback"
	local current_manifest_digest
	local rollback_manifest_digest
	local recorded_git_sha
	local restored_mode

	oci_v081_matrix_build_fixture \
		oci-isolation "${current_source}" "${OCI_V081_MATRIX_GIT_SHA}" a
	oci_v081_matrix_build_fixture \
		oci-isolation "${rollback_source}" "${OCI_V081_MATRIX_ROLLBACK_SHA}" b
	mkdir -p "${archive_root}"
	current_manifest_digest="$(sha256sum "${current_source}/.dagger/runtime/package-manifest.json" | cut -d' ' -f1)"
	rollback_manifest_digest="$(sha256sum "${rollback_source}/.dagger/runtime/package-manifest.json" | cut -d' ' -f1)"

	oci_v081_matrix_create_archive \
		"${current_source}" "${current_archive}" "${current_checksum}" \
		"${current_source_record}" "${OCI_V081_MATRIX_GIT_SHA}"
	oci_v081_matrix_create_archive \
		"${rollback_source}" "${rollback_archive}" "${rollback_checksum}" \
		"${rollback_source_record}" "${OCI_V081_MATRIX_ROLLBACK_SHA}"

	oci_v081_matrix_restore_archive \
		"${current_archive}" "${current_checksum}" "${current_restore}"
	IFS= read -r recorded_git_sha <"${current_source_record}"
	[[ ${recorded_git_sha} == "${OCI_V081_MATRIX_GIT_SHA}" ]]
	[[ -L ${current_restore}/matrix/current ]]
	restored_mode="$(stat -c '%a' "${current_restore}/matrix/deploy-image-a.sh")"
	[[ ${restored_mode} == 751 ]]
	run_restored_deploy \
		"${current_restore}" "${recorded_git_sha}" \
		"${current_manifest_digest}" \
		"${OCI_V081_MATRIX_TEMP}/current-deploy.json"

	oci_v081_matrix_restore_archive \
		"${rollback_archive}" "${rollback_checksum}" "${rollback_restore}"
	IFS= read -r recorded_git_sha <"${rollback_source_record}"
	[[ ${recorded_git_sha} == "${OCI_V081_MATRIX_ROLLBACK_SHA}" ]]
	[[ -L ${rollback_restore}/matrix/current ]]
	restored_mode="$(stat -c '%a' "${rollback_restore}/matrix/deploy-image-a.sh")"
	[[ ${restored_mode} == 751 ]]
	run_restored_deploy \
		"${rollback_restore}" "${recorded_git_sha}" \
		"${rollback_manifest_digest}" \
		"${OCI_V081_MATRIX_TEMP}/rollback-deploy.json"
}

run_reserved_env_attack() {
	local fixture="${OCI_V081_MATRIX_TEMP}/reserved-env-attack"
	local captured_log="${OCI_V081_MATRIX_TEMP}/reserved-env-attack.log"
	local deploy_status

	oci_v081_matrix_build_fixture \
		reserved-env-attack "${fixture}" "${OCI_V081_MATRIX_GIT_SHA}" c
	set +e
	oci_v081_matrix_run_dagger call --json deploy-release \
		--repo="${fixture}" \
		--git-sha="${OCI_V081_MATRIX_GIT_SHA}" \
		--release-targets-json='["image-a"]' \
		--environment=matrix \
		--dry-run=false \
		--package-manifest-file="${fixture}/.dagger/runtime/package-manifest.json" \
		>"${captured_log}" 2>&1
	deploy_status=$?
	set -e
	if ((deploy_status == 0)); then
		printf 'reserved-env attack unexpectedly reached Deploy\n' >&2
		return 1
	fi
	node "${OCI_V081_MATRIX_VERIFY}" reserved-env-attack "${captured_log}"
}

case "${1-}" in
--list)
	list_scenarios
	exit 0
	;;
--list-live-scenarios)
	list_live_scenarios
	exit 0
	;;
--prepare-live-fixtures)
	[[ $# -eq 4 ]] || {
		printf 'Usage: %s --prepare-live-fixtures DESTINATION REGISTRY REPOSITORY_PREFIX\n' "$0" >&2
		exit 1
	}
	oci_v081_matrix_require_commands
	prepare_live_fixtures "$2" "$3" "$4"
	exit 0
	;;
--run-live-scenario)
	[[ $# -eq 3 ]] || {
		printf 'Usage: %s --run-live-scenario SCENARIO OUTPUT_ROOT\n' "$0" >&2
		exit 1
	}
	oci_v081_matrix_require_commands
	run_live_scenario "$2" "$3"
	exit 0
	;;
"") ;;
*)
	printf 'Usage: %s [--list | --list-live-scenarios | --prepare-live-fixtures DESTINATION REGISTRY REPOSITORY_PREFIX | --run-live-scenario SCENARIO OUTPUT_ROOT]\n' "$0" >&2
	exit 1
	;;
esac

oci_v081_matrix_require_commands
OCI_V081_MATRIX_TEMP="$(mktemp -d "${OCI_V081_MATRIX_TEMP_ROOT%/}/rush-delivery-v081-matrix.XXXXXX")"
trap cleanup EXIT

run_named_provider_dry_run
run_filesystem_entrypoint_matrix
run_archive_restore_rollback_and_isolation
run_reserved_env_attack

printf 'v0.8.1 deterministic OCI acceptance matrix passed.\n'
