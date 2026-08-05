#!/usr/bin/env bash

OCI_V081_MATRIX_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OCI_V081_MATRIX_REPO_ROOT="$(cd -- "${OCI_V081_MATRIX_LIB_DIR}/../../.." && pwd)"
OCI_V081_MATRIX_EXAMPLE_SOURCE="${OCI_V081_MATRIX_REPO_ROOT}/examples/oci-application-image-rush-repo"
OCI_V081_MATRIX_FIXTURE_BUILDER="${OCI_V081_MATRIX_REPO_ROOT}/test/scripts/build-oci-v081-matrix-fixture.mjs"
OCI_V081_MATRIX_VERIFY="${OCI_V081_MATRIX_REPO_ROOT}/test/scripts/verify-oci-v081-acceptance-matrix.mjs"
OCI_V081_MATRIX_DAGGER_TIMEOUT_SECONDS=900
OCI_V081_MATRIX_LIVE_MUTATION_TIMEOUT_SECONDS=1200
OCI_V081_MATRIX_INVENTORY_TIMEOUT_SECONDS=300
OCI_V081_MATRIX_PROTECTED_SCAN_TIMEOUT_SECONDS=300

oci_v081_matrix_require_commands() {
	local command_name
	for command_name in bash cp dagger git node realpath sha256sum tar timeout; do
		command -v "${command_name}" >/dev/null 2>&1 || {
			printf 'v0.8.1 acceptance matrix requires %s\n' "${command_name}" >&2
			return 1
		}
	done
}

oci_v081_matrix_initialize_git_repo() {
	local fixture="$1"

	[[ ! -e ${fixture}/.git ]] || {
		printf 'v0.8.1 acceptance fixture already contains Git metadata\n' >&2
		return 1
	}
	git -C "${fixture}" init --quiet
	git -C "${fixture}" config user.email matrix@example.invalid
	git -C "${fixture}" config user.name 'Rush Delivery Matrix'
	git -C "${fixture}" add --all
	GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' \
		GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' \
		git -C "${fixture}" commit --quiet --message 'matrix fixture'
}

oci_v081_matrix_run_bounded() {
	local timeout_seconds="$1"
	shift

	if [[ ! ${timeout_seconds} =~ ^[1-9][0-9]{0,3}$ ]] ||
		((timeout_seconds > OCI_V081_MATRIX_LIVE_MUTATION_TIMEOUT_SECONDS)); then
		printf 'v0.8.1 acceptance matrix rejected an unbounded operation\n' >&2
		return 1
	fi

	timeout \
		--foreground \
		--signal=TERM \
		--kill-after=30s \
		"${timeout_seconds}s" \
		"$@"
}

oci_v081_matrix_run_dagger() {
	oci_v081_matrix_run_bounded \
		"${OCI_V081_MATRIX_DAGGER_TIMEOUT_SECONDS}" \
		env DAGGER_NO_NAG=1 \
		dagger -m "${OCI_V081_MATRIX_REPO_ROOT}" --silent "$@"
}

oci_v081_matrix_assert_protected_capture() {
	local inspected_path="$1"
	local protected_values_file="$2"
	local docker_config_file="$3"
	local allow_username="$4"

	[[ -e ${inspected_path} || -L ${inspected_path} ]] || {
		printf 'v0.8.1 protected-output scan target does not exist\n' >&2
		return 1
	}
	[[ -f ${protected_values_file} && -f ${docker_config_file} ]] || {
		printf 'v0.8.1 protected-output scan inputs are incomplete\n' >&2
		return 1
	}
	oci_v081_matrix_run_bounded \
		"${OCI_V081_MATRIX_PROTECTED_SCAN_TIMEOUT_SECONDS}" \
		node "${OCI_V081_MATRIX_VERIFY}" protected-capture \
		"${inspected_path}" "${protected_values_file}" \
		"${docker_config_file}" "${allow_username}"
}

oci_v081_matrix_classify_failure_stage() {
	local captured_log="$1"

	if grep -Fq 'Dagger metadata contract validation failed:' "${captured_log}"; then
		printf 'metadata-validation\n'
	elif grep -Fq 'must contain the expected PEM key' "${captured_log}"; then
		printf 'credential-shape-preflight\n'
	elif grep -Fq 'Cosign preflight failed for ' "${captured_log}"; then
		printf 'cosign-preflight\n'
	elif grep -Fq 'OCI application image preparation failed:' "${captured_log}"; then
		printf 'image-preparation\n'
	elif grep -Fq 'failed during registry publication authentication.' "${captured_log}"; then
		printf 'registry-publication-authentication\n'
	elif grep -Fq 'failed during registry publication authorization.' "${captured_log}"; then
		printf 'registry-publication-authorization\n'
	elif grep -Fq 'failed during registry publication transport.' "${captured_log}"; then
		printf 'registry-publication-transport\n'
	elif grep -Eq 'failed during registry (publication|publish)\.' "${captured_log}"; then
		printf 'registry-publication\n'
	elif grep -Fq 'failed during Cosign sign.' "${captured_log}"; then
		printf 'cosign-sign\n'
	elif grep -Fq 'failed during Cosign attest-spdx.' "${captured_log}"; then
		printf 'cosign-attest-spdx\n'
	elif grep -Fq 'failed during Cosign attest-provenance.' "${captured_log}"; then
		printf 'cosign-attest-provenance\n'
	elif grep -Fq 'failed during Cosign verify-signature.' "${captured_log}"; then
		printf 'cosign-verify-signature\n'
	elif grep -Fq 'failed during Cosign verify-spdx-attestation.' "${captured_log}"; then
		printf 'cosign-verify-spdx-attestation\n'
	elif grep -Fq 'failed during Cosign verify-provenance-attestation.' "${captured_log}"; then
		printf 'cosign-verify-provenance-attestation\n'
	elif grep -Fq 'OCI application image finalization failed:' "${captured_log}"; then
		printf 'image-finalization\n'
	else
		printf 'package-contract\n'
	fi
}

oci_v081_matrix_classify_mutation_state() {
	local captured_log="$1"
	local failure_stage="$2"
	local exit_status="${3:-1}"
	local publication_boundary_message='[package] OCI publication boundary crossed; ordered finalization is starting.'

	if ((exit_status == 0)); then
		printf 'completed\n'
		return 0
	fi
	if grep -Fq "${publication_boundary_message}" "${captured_log}"; then
		printf 'started\n'
		return 0
	fi
	if [[ ${exit_status} == 124 || ${exit_status} == 137 ]]; then
		printf 'unknown\n'
		return 0
	fi
	case "${failure_stage}" in
	metadata-validation | credential-shape-preflight | cosign-preflight | image-preparation)
		printf 'not-started\n'
		;;
	registry-publication | registry-publication-authentication | registry-publication-authorization | registry-publication-transport | cosign-sign | cosign-attest-spdx | cosign-attest-provenance | cosign-verify-signature | cosign-verify-spdx-attestation | cosign-verify-provenance-attestation | image-finalization)
		printf 'started\n'
		;;
	*)
		printf 'unknown\n'
		;;
	esac
}

oci_v081_matrix_write_scenario_diagnostic() {
	local diagnostic_path="$1"
	local scenario="$2"
	local outcome="$3"
	local observed_stage="$4"
	local mutation_state="$5"
	local fault_teardown_state="$6"
	local cleanup_state="$7"
	local evidence_state="$8"
	local registry="$9"
	local repository_prefix="${10}"
	local targets_csv="${11}"

	case "${scenario}" in
	malformed-private-pem | malformed-public-pem | wrong-signing-password | invalid-key | mismatched-key | multi-target-success | multi-target-preparation-failure | multi-target-finalization-failure) ;;
	*) return 2 ;;
	esac
	case "${outcome}" in
	passed | failed) ;;
	*) return 2 ;;
	esac
	case "${observed_stage}" in
	none | metadata-validation | credential-shape-preflight | cosign-preflight | image-preparation | registry-publication | registry-publication-authentication | registry-publication-authorization | registry-publication-transport | cosign-sign | cosign-attest-spdx | cosign-attest-provenance | cosign-verify-signature | cosign-verify-spdx-attestation | cosign-verify-provenance-attestation | image-finalization | package-contract | mutation-timeout | protected-output | fault-teardown | registry-cleanup | harness-execution) ;;
	*) return 2 ;;
	esac
	case "${mutation_state}" in
	not-started | started | completed | unknown) ;;
	*) return 2 ;;
	esac
	case "${fault_teardown_state}" in
	not-required | succeeded | failed) ;;
	*) return 2 ;;
	esac
	case "${cleanup_state}" in
	not-required | succeeded | failed) ;;
	*) return 2 ;;
	esac
	case "${evidence_state}" in
	sanitized | quarantined) ;;
	*) return 2 ;;
	esac
	[[ ${registry} =~ ^[a-z0-9]+([.-][a-z0-9]+)+$ &&
		${repository_prefix} =~ ^[a-z0-9]+([._/-][a-z0-9]+)*$ ]] || return 2
	case "${targets_csv}" in
	control-plane-api | control-plane-api,matrix-worker | control-plane-api,matrix-worker,matrix-later) ;;
	*) return 2 ;;
	esac
	[[ ${diagnostic_path} == /*/scenario-diagnostic.txt &&
		-d ${diagnostic_path%/*} && ! -e ${diagnostic_path} &&
		! -L ${diagnostic_path} ]] || return 2

	(
		umask 077
		{
			printf 'schema=rush-delivery-v081-live-scenario-diagnostic/v2\n'
			printf 'scenario=%s\n' "${scenario}"
			printf 'outcome=%s\n' "${outcome}"
			printf 'observed_stage=%s\n' "${observed_stage}"
			printf 'mutation_state=%s\n' "${mutation_state}"
			printf 'fault_teardown_state=%s\n' "${fault_teardown_state}"
			printf 'cleanup_state=%s\n' "${cleanup_state}"
			printf 'evidence_state=%s\n' "${evidence_state}"
			printf 'registry=%s\n' "${registry}"
			printf 'repository_prefix=%s\n' "${repository_prefix}"
			printf 'targets=%s\n' "${targets_csv}"
			printf 'source_revision=0123456789abcdef0123456789abcdef01234567\n'
		} >"${diagnostic_path}"
		chmod 600 "${diagnostic_path}"
	)
}

oci_v081_matrix_write_namespace_record() {
	local record_path="$1"
	local scenario="$2"
	local candidate_commit="$3"
	local registry="$4"
	local repository_prefix="$5"
	local targets_csv="$6"

	case "${scenario}" in
	malformed-private-pem | malformed-public-pem | wrong-signing-password | invalid-key | mismatched-key | multi-target-success | multi-target-preparation-failure | multi-target-finalization-failure) ;;
	*) return 2 ;;
	esac
	[[ ${candidate_commit} =~ ^[a-f0-9]{40}$ &&
		${registry} =~ ^[a-z0-9]+([.-][a-z0-9]+)+$ &&
		${repository_prefix} =~ ^[a-z0-9]+([._/-][a-z0-9]+)*$ ]] || return 2
	case "${targets_csv}" in
	control-plane-api | control-plane-api,matrix-worker | control-plane-api,matrix-worker,matrix-later) ;;
	*) return 2 ;;
	esac
	[[ ${record_path} =~ ^/.*/namespace-records/${scenario}-[a-f0-9]{32}\.txt$ &&
		-d ${record_path%/*} && ! -e ${record_path} &&
		! -L ${record_path} ]] || return 2

	(
		umask 077
		{
			printf 'schema=rush-delivery-v081-live-namespace/v1\n'
			printf 'scenario=%s\n' "${scenario}"
			printf 'candidate_commit=%s\n' "${candidate_commit}"
			printf 'registry=%s\n' "${registry}"
			printf 'repository_prefix=%s\n' "${repository_prefix}"
			printf 'targets=%s\n' "${targets_csv}"
		} >"${record_path}"
		chmod 600 "${record_path}"
	)
}

oci_v081_matrix_copy_promoted_file() {
	local source="$1"
	local destination="$2"

	[[ -f ${source} && ! -L ${source} && ! -e ${destination} &&
		! -L ${destination} ]] || return 1
	mkdir -p "${destination%/*}" || return 1
	cp -- "${source}" "${destination}" || return 1
	chmod 600 "${destination}"
}

oci_v081_matrix_publish_sanitized_output() {
	local work_root="$1"
	local output_root="$2"
	local scenario="$3"
	local outcome="$4"
	local observed_stage="$5"
	local mutation_state="$6"
	local fault_teardown_state="$7"
	local cleanup_state="$8"
	local registry="$9"
	local repository_prefix="${10}"
	local targets_csv="${11}"
	local package_capture_safe="${12}"
	local protected_scan_failed="${13}"
	local pre_inventory_validated="${14}"
	local registry_inventory_validated="${15}"
	local cleanup_validated="${16}"
	local package_evidence_validated="${17}"
	local protected_values_file="${18}"
	local docker_config_file="${19}"
	local marker="${work_root}/.rush-delivery-v081-live-owned"
	local artifact_parent="${output_root%/*}"
	local external_parent="${artifact_parent%/*}"
	local staging_root
	local evidence_state=quarantined
	local promotion_failed=false
	local relative_path
	local target
	local -a promoted_targets=()

	[[ ${work_root} == /* && -d ${work_root} && ! -L ${work_root} &&
		-f ${marker} && ! -L ${marker} &&
		$(<"${marker}") == rush-delivery-v081-live-owned &&
		${output_root} == /* && ! -e ${output_root} && ! -L ${output_root} &&
		-d ${artifact_parent} && ! -L ${artifact_parent} &&
		-d ${external_parent} && ! -L ${external_parent} ]] || return 1

	staging_root="$(
		mktemp -d \
			"${external_parent}/rush-delivery-v081-live-evidence.${scenario}.XXXXXX"
	)" || return 1
	chmod 700 "${staging_root}"
	printf 'rush-delivery-v081-live-owned\n' \
		>"${staging_root}/.rush-delivery-v081-live-owned"
	chmod 600 "${staging_root}/.rush-delivery-v081-live-owned"

	if [[ ${package_capture_safe} == true &&
		${protected_scan_failed} == false ]]; then
		evidence_state=sanitized
		if [[ ${pre_inventory_validated} == true ]]; then
			oci_v081_matrix_copy_promoted_file \
				"${work_root}/pre-mutation-inventory.json" \
				"${staging_root}/pre-mutation-inventory.json" || promotion_failed=true
		fi
		if [[ ${registry_inventory_validated} == true ]]; then
			oci_v081_matrix_copy_promoted_file \
				"${work_root}/registry-inventory.json" \
				"${staging_root}/registry-inventory.json" || promotion_failed=true
		fi
		if [[ ${cleanup_validated} == true ]]; then
			oci_v081_matrix_copy_promoted_file \
				"${work_root}/cleanup-inventory.json" \
				"${staging_root}/cleanup-inventory.json" || promotion_failed=true
		fi
		if [[ ${package_evidence_validated} == true ]]; then
			oci_v081_matrix_copy_promoted_file \
				"${work_root}/package-output/.dagger/runtime/package-manifest.json" \
				"${staging_root}/package-output/.dagger/runtime/package-manifest.json" || promotion_failed=true
			IFS=',' read -r -a promoted_targets <<<"${targets_csv}"
			for target in "${promoted_targets[@]}"; do
				for relative_path in provenance.json sbom.spdx.json scan.json; do
					oci_v081_matrix_copy_promoted_file \
						"${work_root}/package-output/.dagger/runtime/evidence/${target}/${relative_path}" \
						"${staging_root}/package-output/.dagger/runtime/evidence/${target}/${relative_path}" || promotion_failed=true
				done
			done
		fi
	fi
	if [[ ${promotion_failed} == true ]]; then
		find "${staging_root}" -depth -delete
		return 1
	fi
	oci_v081_matrix_write_scenario_diagnostic \
		"${staging_root}/scenario-diagnostic.txt" \
		"${scenario}" "${outcome}" "${observed_stage}" \
		"${mutation_state}" "${fault_teardown_state}" \
		"${cleanup_state}" "${evidence_state}" "${registry}" \
		"${repository_prefix}" "${targets_csv}" || {
		find "${staging_root}" -depth -delete
		return 1
	}
	if ! oci_v081_matrix_assert_protected_capture \
		"${staging_root}" "${protected_values_file}" \
		"${docker_config_file}" false; then
		find "${staging_root}" -depth -delete
		return 1
	fi
	if ! mv -- "${staging_root}" "${output_root}"; then
		find "${staging_root}" -depth -delete
		return 1
	fi
}

oci_v081_matrix_copy_example() {
	local destination="$1"

	if [[ -e ${destination} ]]; then
		printf 'v0.8.1 acceptance fixture destination already exists\n' >&2
		return 1
	fi

	mkdir -p "${destination}"
	tar \
		--exclude='./.dagger/runtime' \
		--exclude='./apps/control-plane-api/.rush' \
		--exclude='./apps/control-plane-api/dist' \
		--exclude='./apps/control-plane-api/node_modules' \
		--exclude='./apps/control-plane-api/rush-logs' \
		--exclude='./common/temp' \
		--exclude='./node_modules' \
		-C "${OCI_V081_MATRIX_EXAMPLE_SOURCE}" \
		-cf - . | tar -C "${destination}" -xf -
}

oci_v081_matrix_build_fixture() {
	local mode="$1"
	local destination="$2"
	local git_sha="${3:-0123456789abcdef0123456789abcdef01234567}"
	local digest_seed="${4:-a}"

	oci_v081_matrix_copy_example "${destination}"
	oci_v081_matrix_run_bounded 60 \
		node "${OCI_V081_MATRIX_FIXTURE_BUILDER}" \
		"${mode}" "${destination}" "${git_sha}" "${digest_seed}"
}

oci_v081_matrix_create_archive() {
	local source_directory="$1"
	local archive_path="$2"
	local checksum_record="$3"
	local source_record="$4"
	local git_sha="$5"
	local archive_digest

	[[ ${git_sha} =~ ^[a-f0-9]{40}$ ]] || {
		printf 'v0.8.1 archive source record requires a full lowercase Git SHA\n' >&2
		return 1
	}
	[[ ! -e ${archive_path} && ! -e ${checksum_record} && ! -e ${source_record} ]] || {
		printf 'v0.8.1 archive output or protected record already exists\n' >&2
		return 1
	}

	mkdir -p "$(dirname -- "${archive_path}")"
	tar \
		--create \
		--gzip \
		--format=posix \
		--sort=name \
		--mtime=@0 \
		--owner=0 \
		--group=0 \
		--numeric-owner \
		--pax-option=delete=atime,delete=ctime \
		--file "${archive_path}" \
		--directory "${source_directory}" \
		.
	archive_digest="$(sha256sum "${archive_path}" | cut -d' ' -f1)"
	printf '%s\n' "${archive_digest}" >"${checksum_record}"
	printf '%s\n' "${git_sha}" >"${source_record}"
}

oci_v081_matrix_assert_archive_members_safe() {
	local archive_path="$1"
	local member
	local members_file
	local normalized
	local unsafe_member=false

	members_file="$(mktemp "${OCI_V081_MATRIX_TEMP_ROOT%/}/rush-delivery-v081-archive-members.XXXXXX")" || return 1
	if ! tar --list --gzip --file "${archive_path}" >"${members_file}"; then
		find "${members_file}" -maxdepth 0 -type f -delete
		return 1
	fi
	while IFS= read -r member; do
		normalized="${member#./}"
		if [[ ${normalized} == /* || ${normalized} == '..' ||
			${normalized} == ../* || ${normalized} == */../* ||
			${normalized} == */.. ]]; then
			unsafe_member=true
			break
		fi
	done <"${members_file}"
	find "${members_file}" -maxdepth 0 -type f -delete
	[[ ${unsafe_member} == false ]] || {
		printf 'v0.8.1 package archive contains an escaping member\n' >&2
		return 1
	}
}

oci_v081_matrix_assert_restored_links_safe() {
	local restoration_root="$1"
	local link_path
	local link_target
	local links_file
	local resolved_target
	local unsafe_link=false

	links_file="$(mktemp "${OCI_V081_MATRIX_TEMP_ROOT%/}/rush-delivery-v081-archive-links.XXXXXX")" || return 1
	if ! find "${restoration_root}" -type l -print0 >"${links_file}"; then
		find "${links_file}" -maxdepth 0 -type f -delete
		return 1
	fi
	while IFS= read -r -d '' link_path; do
		link_target="$(readlink "${link_path}")"
		if [[ ${link_target} == /* ]]; then
			unsafe_link=true
			break
		fi
		resolved_target="$(realpath -m "$(dirname -- "${link_path}")/${link_target}")"
		case "${resolved_target}" in
		"${restoration_root}" | "${restoration_root}"/*) ;;
		*)
			unsafe_link=true
			break
			;;
		esac
	done <"${links_file}"
	find "${links_file}" -maxdepth 0 -type f -delete
	[[ ${unsafe_link} == false ]] || {
		printf 'v0.8.1 package archive contains an absolute or escaping link\n' >&2
		return 1
	}
}

oci_v081_matrix_restore_archive() {
	local archive_path="$1"
	local checksum_record="$2"
	local destination="$3"
	local expected_digest
	local actual_digest
	local destination_parent
	local staging_directory

	[[ ! -e ${destination} ]] || {
		printf 'v0.8.1 package archive restore destination already exists\n' >&2
		return 1
	}
	IFS= read -r expected_digest <"${checksum_record}"
	actual_digest="$(sha256sum "${archive_path}" | cut -d' ' -f1)"
	[[ ${actual_digest} == "${expected_digest}" ]] || {
		printf 'v0.8.1 package archive checksum does not match protected metadata\n' >&2
		return 1
	}
	oci_v081_matrix_assert_archive_members_safe "${archive_path}"

	destination_parent="$(dirname -- "${destination}")"
	mkdir -p "${destination_parent}"
	staging_directory="$(mktemp -d "${destination_parent}/.v081-matrix-restore.XXXXXX")"
	if ! tar \
		--extract \
		--gzip \
		--file "${archive_path}" \
		--directory "${staging_directory}" \
		--no-same-owner \
		--delay-directory-restore; then
		find "${staging_directory}" -depth -delete
		return 1
	fi
	if ! oci_v081_matrix_assert_restored_links_safe "${staging_directory}"; then
		find "${staging_directory}" -depth -delete
		return 1
	fi
	mv "${staging_directory}" "${destination}"
}

oci_v081_matrix_claim_mutation_slot() {
	local state_directory="$1"
	local marker

	mkdir -p "${state_directory}"
	marker="${state_directory}/mutating-package-call.started"
	if ! (
		set -o noclobber
		printf 'started\n' >"${marker}"
	) 2>/dev/null; then
		printf 'v0.8.1 live matrix refuses to replay a mutating Package call\n' >&2
		return 1
	fi
}

oci_v081_matrix_write_live_provider() {
	local fixture="$1"
	local registry="$2"
	local repository_prefix="$3"

	[[ ${registry} =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?$ ]] || {
		printf 'v0.8.1 live matrix registry must be a normalized authority\n' >&2
		return 1
	}
	[[ ${repository_prefix} =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] || {
		printf 'v0.8.1 live matrix repository prefix must be normalized\n' >&2
		return 1
	}

	{
		printf 'providers:\n'
		printf '  matrix:\n'
		printf '    kind: oci_registry\n'
		printf '    registry: %s\n' "${registry}"
		printf '    repository_prefix: %s\n' "${repository_prefix}"
		printf '    username_env: OCI_MATRIX_USERNAME\n'
		printf '    token_env: OCI_MATRIX_TOKEN\n'
		printf '    signing_key_env: OCI_MATRIX_SIGNING_KEY\n'
		printf '    signing_password_env: OCI_MATRIX_SIGNING_PASSWORD\n'
		printf '    verification_key_env: OCI_MATRIX_VERIFICATION_KEY\n'
	} >"${fixture}/.dagger/application-images/providers.yaml"
}

oci_v081_matrix_build_live_fixture() {
	local mode="$1"
	local destination="$2"
	local registry="$3"
	local repository_prefix="$4"

	case "${mode}" in
	live-single-target | live-multi-target-success | live-multi-target-preparation-failure | live-multi-target-finalization-failure) ;;
	*)
		printf 'v0.8.1 live matrix fixture mode is unsupported\n' >&2
		return 1
		;;
	esac
	oci_v081_matrix_build_fixture "${mode}" "${destination}"
	oci_v081_matrix_write_live_provider \
		"${destination}" "${registry}" "${repository_prefix}"
}

oci_v081_matrix_run_live_package_once() {
	local fixture="$1"
	local deploy_env_file="$2"
	local output_directory="$3"
	local captured_log="$4"
	local state_directory="$5"
	local docker_config_file="$6"
	local status_variable="$7"
	local captured_status=0
	local module_root="${OCI_V081_MATRIX_REPO_ROOT}"
	local fault_state_file="${OCI_V081_MATRIX_FAULT_STATE_FILE-}"
	local fault_state_line_count
	local -a fault_marker_lines=()

	[[ -f ${deploy_env_file} && -f ${docker_config_file} &&
		! -e ${output_directory} && ! -e ${captured_log} ]] || {
		printf 'v0.8.1 live matrix requires protected inputs and new capture paths\n' >&2
		return 1
	}
	[[ ${status_variable} =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
		printf 'v0.8.1 live matrix package status output name is invalid\n' >&2
		return 1
	}
	if [[ -n ${fault_state_file} && (-e ${fault_state_file} || -L ${fault_state_file}) ]]; then
		fault_state_line_count="$(wc -l <"${fault_state_file}")" || return 1
		[[ -f ${fault_state_file} && ! -L ${fault_state_file} &&
			${fault_state_line_count} -eq 1 ]] || {
			printf 'v0.8.1 live matrix finalization-fault state is malformed\n' >&2
			return 1
		}
		IFS= read -r module_root <"${fault_state_file}"
		[[ ${module_root} == /* && -d ${module_root} && ! -L ${module_root} &&
			-f ${module_root}/.rush-delivery-v081-finalization-fault-owned &&
			! -L ${module_root}/.rush-delivery-v081-finalization-fault-owned ]] || {
			printf 'v0.8.1 live matrix finalization-fault module is invalid\n' >&2
			return 1
		}
		mapfile -t fault_marker_lines <"${module_root}/.rush-delivery-v081-finalization-fault-owned"
		[[ ${#fault_marker_lines[@]} -eq 3 &&
			${fault_marker_lines[0]} == rush-delivery-v081-finalization-fault-owned &&
			${fault_marker_lines[1]} =~ ^source_commit=[a-f0-9]{40}$ &&
			${fault_marker_lines[2]} == failed_target=matrix-worker ]] || {
			printf 'v0.8.1 live matrix finalization-fault marker is invalid\n' >&2
			return 1
		}
	fi
	oci_v081_matrix_claim_mutation_slot "${state_directory}"

	oci_v081_matrix_run_bounded \
		"${OCI_V081_MATRIX_LIVE_MUTATION_TIMEOUT_SECONDS}" \
		env DAGGER_NO_NAG=1 \
		dagger -m "${module_root}" --progress=logs call \
		build-and-package-deploy-targets \
		--repo="${fixture}" \
		--ci-plan-file="${fixture}/ci/oci-plan.json" \
		--git-sha=0123456789abcdef0123456789abcdef01234567 \
		--source-repository-url=https://github.com/BootstrapLaboratory/rush-delivery.git \
		--dry-run=false \
		--deploy-env-file="${deploy_env_file}" \
		--application-image-provider=matrix \
		export --path="${output_directory}" >"${captured_log}" 2>&1 ||
		captured_status=$?
	if [[ ${captured_status} == 124 || ${captured_status} == 137 ]]; then
		OCI_V081_MATRIX_LIVE_OBSERVED_STAGE=mutation-timeout
	else
		OCI_V081_MATRIX_LIVE_OBSERVED_STAGE="$(
			oci_v081_matrix_classify_failure_stage "${captured_log}"
		)"
	fi
	# shellcheck disable=SC2034 # Read by the parent live-scenario EXIT trap.
	OCI_V081_MATRIX_LIVE_MUTATION_STATE="$(
		oci_v081_matrix_classify_mutation_state \
			"${captured_log}" "${OCI_V081_MATRIX_LIVE_OBSERVED_STAGE}" \
			"${captured_status}"
	)"
	if ((captured_status == 0)); then
		OCI_V081_MATRIX_LIVE_OBSERVED_STAGE=none
	fi
	if ! oci_v081_matrix_assert_protected_capture \
		"${captured_log}" "${deploy_env_file}" \
		"${docker_config_file}" true; then
		# Read by the parent runner's EXIT trap before any retained artifact is written.
		OCI_V081_MATRIX_LIVE_PROTECTED_SCAN_FAILED=true
		OCI_V081_MATRIX_LIVE_OBSERVED_STAGE=protected-output
		return 1
	fi
	if [[ -e ${output_directory} || -L ${output_directory} ]]; then
		if ! oci_v081_matrix_assert_protected_capture \
			"${output_directory}" "${deploy_env_file}" \
			"${docker_config_file}" false; then
			OCI_V081_MATRIX_LIVE_PROTECTED_SCAN_FAILED=true
			OCI_V081_MATRIX_LIVE_OBSERVED_STAGE=protected-output
			return 1
		fi
	fi
	# shellcheck disable=SC2034 # Read by the parent live-scenario EXIT trap.
	OCI_V081_MATRIX_LIVE_OUTPUT_SAFE=true
	printf -v "${status_variable}" '%s' "${captured_status}"
}

oci_v081_matrix_assert_zero_publications() {
	local inventory_hook="$1"
	local registry="$2"
	local repository_prefix="$3"
	local expected_targets_csv="$4"

	[[ ${inventory_hook} == /* && -x ${inventory_hook} ]] || {
		printf 'v0.8.1 zero-publication proof requires an absolute executable inventory hook\n' >&2
		return 1
	}
	oci_v081_matrix_run_bounded \
		"${OCI_V081_MATRIX_INVENTORY_TIMEOUT_SECONDS}" \
		"${inventory_hook}" \
		"${registry}" "${repository_prefix}" "${expected_targets_csv}"
}

oci_v081_matrix_capture_inventory() {
	local assertion="$1"
	local inventory_hook="$2"
	local registry="$3"
	local repository_prefix="$4"
	local expected_targets_csv="$5"
	local evidence_file="$6"
	local captured_log="$7"
	local protected_values_file="$8"
	local docker_config_file="$9"
	local inventory_status=0

	[[ ${inventory_hook} == /* && -x ${inventory_hook} ]] || {
		printf 'v0.8.1 live inventory requires an absolute executable hook\n' >&2
		return 1
	}
	[[ ! -e ${evidence_file} && ! -e ${captured_log} ]] || {
		printf 'v0.8.1 live inventory capture output already exists\n' >&2
		return 1
	}
	oci_v081_matrix_run_bounded \
		"${OCI_V081_MATRIX_INVENTORY_TIMEOUT_SECONDS}" \
		"${inventory_hook}" \
		"${assertion}" "${registry}" "${repository_prefix}" \
		"${expected_targets_csv}" "${evidence_file}" \
		>"${captured_log}" 2>&1 || inventory_status=$?
	if ! oci_v081_matrix_assert_protected_capture \
		"${captured_log}" "${protected_values_file}" \
		"${docker_config_file}" false; then
		OCI_V081_MATRIX_LIVE_PROTECTED_SCAN_FAILED=true
		return 1
	fi
	if [[ -e ${evidence_file} || -L ${evidence_file} ]]; then
		if ! oci_v081_matrix_assert_protected_capture \
			"${evidence_file}" "${protected_values_file}" \
			"${docker_config_file}" false; then
			OCI_V081_MATRIX_LIVE_PROTECTED_SCAN_FAILED=true
			return 1
		fi
	fi
	((inventory_status == 0)) || return "${inventory_status}"
	[[ -s ${evidence_file} ]] || {
		printf 'v0.8.1 live inventory hook did not write independent JSON evidence\n' >&2
		return 1
	}
}

oci_v081_matrix_configure_finalization_fault() {
	local fault_hook="$1"
	local registry="$2"
	local repository_prefix="$3"
	local failed_target="$4"
	local captured_log="$5"
	local protected_values_file="$6"
	local docker_config_file="$7"
	local fault_status=0

	[[ ${fault_hook} == /* && -x ${fault_hook} ]] || {
		printf 'v0.8.1 ordered-finalization proof requires an absolute executable fault hook\n' >&2
		return 1
	}
	oci_v081_matrix_run_bounded \
		"${OCI_V081_MATRIX_INVENTORY_TIMEOUT_SECONDS}" \
		"${fault_hook}" \
		configure-finalization-failure \
		"${registry}" "${repository_prefix}" "${failed_target}" \
		>"${captured_log}" 2>&1 || fault_status=$?
	if ! oci_v081_matrix_assert_protected_capture \
		"${captured_log}" "${protected_values_file}" \
		"${docker_config_file}" false; then
		OCI_V081_MATRIX_LIVE_PROTECTED_SCAN_FAILED=true
		return 1
	fi
	return "${fault_status}"
}

oci_v081_matrix_teardown_finalization_fault() {
	local fault_hook="$1"
	local registry="$2"
	local repository_prefix="$3"
	local failed_target="$4"
	local captured_log="$5"
	local protected_values_file="$6"
	local docker_config_file="$7"
	local fault_status=0

	oci_v081_matrix_run_bounded \
		"${OCI_V081_MATRIX_INVENTORY_TIMEOUT_SECONDS}" \
		"${fault_hook}" \
		teardown-finalization-failure \
		"${registry}" "${repository_prefix}" "${failed_target}" \
		>"${captured_log}" 2>&1 || fault_status=$?
	if ! oci_v081_matrix_assert_protected_capture \
		"${captured_log}" "${protected_values_file}" \
		"${docker_config_file}" false; then
		OCI_V081_MATRIX_LIVE_PROTECTED_SCAN_FAILED=true
		return 1
	fi
	return "${fault_status}"
}

oci_v081_matrix_cleanup_live_namespace() {
	local cleanup_hook="$1"
	local registry="$2"
	local repository_prefix="$3"
	local expected_targets_csv="$4"
	local cleanup_evidence="$5"
	local captured_log="$6"
	local protected_values_file="$7"
	local docker_config_file="$8"
	local cleanup_status=0

	[[ ${cleanup_hook} == /* && -x ${cleanup_hook} ]] || {
		printf 'v0.8.1 live cleanup requires an absolute executable hook\n' >&2
		return 1
	}
	oci_v081_matrix_run_bounded \
		"${OCI_V081_MATRIX_INVENTORY_TIMEOUT_SECONDS}" \
		"${cleanup_hook}" inspect-and-clean \
		"${registry}" "${repository_prefix}" "${expected_targets_csv}" \
		"${cleanup_evidence}" >"${captured_log}" 2>&1 || cleanup_status=$?
	if ! oci_v081_matrix_assert_protected_capture \
		"${captured_log}" "${protected_values_file}" \
		"${docker_config_file}" false; then
		OCI_V081_MATRIX_LIVE_PROTECTED_SCAN_FAILED=true
		return 1
	fi
	if [[ -e ${cleanup_evidence} || -L ${cleanup_evidence} ]]; then
		if ! oci_v081_matrix_assert_protected_capture \
			"${cleanup_evidence}" "${protected_values_file}" \
			"${docker_config_file}" false; then
			# shellcheck disable=SC2034 # Read by the parent live-scenario EXIT trap.
			OCI_V081_MATRIX_LIVE_PROTECTED_SCAN_FAILED=true
			return 1
		fi
	fi
	((cleanup_status == 0)) || return "${cleanup_status}"
	[[ -s ${cleanup_evidence} ]] || {
		printf 'v0.8.1 live cleanup hook did not write independent JSON evidence\n' >&2
		return 1
	}
	node "${OCI_V081_MATRIX_VERIFY}" live-cleanup \
		"${cleanup_evidence}" "${registry}" "${repository_prefix}" \
		"${expected_targets_csv}"
}

oci_v081_matrix_expect_prepublication_failure_once() {
	local scenario="$1"
	local fixture="$2"
	local deploy_env_file="$3"
	local output_directory="$4"
	local captured_log="$5"
	local state_directory="$6"
	local inventory_hook="$7"
	local registry="$8"
	local repository_prefix="$9"
	local inventory_evidence="${10}"
	local inventory_log="${11}"
	local docker_config_file="${12}"
	local expected_pattern
	local expected_targets
	local package_status=0

	case "${scenario}" in
	malformed-private-pem)
		expected_pattern='Application image signing env OCI_MATRIX_SIGNING_KEY must contain the expected PEM key'
		expected_targets='control-plane-api'
		;;
	malformed-public-pem)
		expected_pattern='Application image signing env OCI_MATRIX_VERIFICATION_KEY must contain the expected PEM key'
		expected_targets='control-plane-api'
		;;
	wrong-signing-password)
		expected_pattern='Cosign preflight failed for signing password'
		expected_targets='control-plane-api'
		;;
	invalid-key)
		expected_pattern='Cosign preflight failed for signing private key'
		expected_targets='control-plane-api'
		;;
	mismatched-key)
		expected_pattern='Cosign preflight failed for signing/verification key pair'
		expected_targets='control-plane-api'
		;;
	multi-target-preparation-failure)
		expected_pattern='OCI application image preparation failed|Grype scan/policy'
		expected_targets='control-plane-api,matrix-worker'
		;;
	*)
		printf 'v0.8.1 prepublication failure scenario is unsupported\n' >&2
		return 1
		;;
	esac
	if [[ ${scenario} != multi-target-preparation-failure ]]; then
		node "${OCI_V081_MATRIX_VERIFY}" credential-failure-profile \
			"${scenario}" "${deploy_env_file}"
	fi

	oci_v081_matrix_run_live_package_once \
		"${fixture}" "${deploy_env_file}" "${output_directory}" \
		"${captured_log}" "${state_directory}" \
		"${docker_config_file}" package_status
	if ((package_status == 0)); then
		printf 'v0.8.1 live matrix expected a prepublication failure\n' >&2
		return 1
	fi
	[[ ${package_status} -ne 124 && ${package_status} -ne 137 ]] || {
		printf 'v0.8.1 live matrix mutating call exceeded its hard timeout\n' >&2
		return 1
	}
	[[ ${OCI_V081_MATRIX_LIVE_MUTATION_STATE} == not-started ]] || {
		printf 'v0.8.1 live matrix prepublication scenario crossed the publication boundary\n' >&2
		return 1
	}
	grep -Eq "${expected_pattern}" "${captured_log}" || {
		printf 'v0.8.1 live matrix failure did not reach the expected prepublication stage\n' >&2
		return 1
	}
	oci_v081_matrix_capture_inventory \
		zero "${inventory_hook}" "${registry}" "${repository_prefix}" \
		"${expected_targets}" "${inventory_evidence}" "${inventory_log}" \
		"${deploy_env_file}" "${docker_config_file}"
	node "${OCI_V081_MATRIX_VERIFY}" live-failure \
		"${scenario}" "${captured_log}" "${inventory_evidence}" \
		"${expected_targets}" "${registry}" "${repository_prefix}"
}

oci_v081_matrix_run_live_multi_target_success_once() {
	local fixture="$1"
	local deploy_env_file="$2"
	local output_directory="$3"
	local captured_log="$4"
	local state_directory="$5"
	local inventory_hook="$6"
	local registry="$7"
	local repository_prefix="$8"
	local inventory_evidence="$9"
	local inventory_log="${10}"
	local docker_config_file="${11}"
	local package_status=0
	local targets='control-plane-api,matrix-worker'

	oci_v081_matrix_run_live_package_once \
		"${fixture}" "${deploy_env_file}" "${output_directory}" \
		"${captured_log}" "${state_directory}" \
		"${docker_config_file}" package_status
	((package_status == 0)) || {
		printf 'v0.8.1 live matrix multi-target Package call failed\n' >&2
		return 1
	}
	oci_v081_matrix_capture_inventory \
		success "${inventory_hook}" "${registry}" "${repository_prefix}" \
		"${targets}" "${inventory_evidence}" "${inventory_log}" \
		"${deploy_env_file}" "${docker_config_file}"
	node "${OCI_V081_MATRIX_VERIFY}" live-success \
		"${output_directory}" "${inventory_evidence}" "${targets}" \
		"${registry}" "${repository_prefix}"
}

oci_v081_matrix_run_live_finalization_failure_once() {
	local fixture="$1"
	local deploy_env_file="$2"
	local output_directory="$3"
	local captured_log="$4"
	local state_directory="$5"
	local inventory_hook="$6"
	local fault_hook="$7"
	local registry="$8"
	local repository_prefix="$9"
	local inventory_evidence="${10}"
	local inventory_log="${11}"
	local fault_log="${12}"
	local docker_config_file="${13}"
	local package_status=0
	local targets='control-plane-api,matrix-worker,matrix-later'

	# shellcheck disable=SC2034 # Read by the parent runner after this library is sourced.
	OCI_V081_MATRIX_LIVE_FAULT_TEARDOWN_REQUIRED=true
	oci_v081_matrix_configure_finalization_fault \
		"${fault_hook}" "${registry}" "${repository_prefix}" matrix-worker \
		"${fault_log}" "${deploy_env_file}" "${docker_config_file}"
	oci_v081_matrix_run_live_package_once \
		"${fixture}" "${deploy_env_file}" "${output_directory}" \
		"${captured_log}" "${state_directory}" \
		"${docker_config_file}" package_status
	if ((package_status == 0)); then
		printf 'v0.8.1 live matrix expected ordered finalization to fail\n' >&2
		return 1
	fi
	[[ ${package_status} -ne 124 && ${package_status} -ne 137 ]] || {
		printf 'v0.8.1 live matrix finalization call exceeded its hard timeout\n' >&2
		return 1
	}
	oci_v081_matrix_capture_inventory \
		ordered-partial "${inventory_hook}" "${registry}" \
		"${repository_prefix}" "${targets}" "${inventory_evidence}" \
		"${inventory_log}" "${deploy_env_file}" "${docker_config_file}"
	node "${OCI_V081_MATRIX_VERIFY}" live-failure \
		ordered-finalization "${captured_log}" "${inventory_evidence}" \
		"${targets}" "${registry}" "${repository_prefix}"
}
