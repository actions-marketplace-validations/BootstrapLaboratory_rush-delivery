#!/usr/bin/env bash
set -euo pipefail
umask 077

die() {
	printf 'rush-delivery action: %s\n' "$*" >&2
	exit 1
}

write_output() {
	local name="$1"
	local value="$2"
	local output_file="${GITHUB_OUTPUT-}"

	if [[ -z ${output_file} ]]; then
		return 0
	fi

	local delimiter
	delimiter="rush_delivery_${name}_${RANDOM}${RANDOM}"
	{
		printf '%s<<%s\n' "${name}" "${delimiter}"
		printf '%s\n' "${value}"
		printf '%s\n' "${delimiter}"
	} >>"${output_file}"
}

append_env_line() {
	local env_file="$1"
	local name="$2"
	local value="$3"

	if [[ -z ${value} ]]; then
		return 0
	fi

	if [[ ! ${name} =~ ^[A-Z][A-Z0-9_]*$ ]]; then
		die "invalid deploy env key: ${name}"
	fi

	if [[ ${value} == *$'\n'* ]]; then
		die "deploy env value for ${name} must be single-line"
	fi

	printf '%s=%s\n' "${name}" "${value}" >>"${env_file}"
}

append_env_content() {
	local env_file="$1"
	local existing_file="$2"
	local content="$3"
	local input_name="$4"

	if [[ -n ${existing_file} ]]; then
		[[ -f ${existing_file} ]] || die "${input_name}-file does not exist: ${existing_file}"
		cat "${existing_file}" >>"${env_file}"
		printf '\n' >>"${env_file}"
	fi

	if [[ -n ${content} ]]; then
		printf '%s\n' "${content}" >>"${env_file}"
	fi
}

append_github_env() {
	local env_file="$1"

	append_env_line "${env_file}" GITHUB_ACTOR "${GITHUB_ACTOR-}"
	append_env_line "${env_file}" GITHUB_REPOSITORY "${GITHUB_REPOSITORY-}"
	append_env_line "${env_file}" GITHUB_API_URL "${RD_GITHUB_API_URL-}"
	append_env_line "${env_file}" GITHUB_TOKEN "${RD_GITHUB_TOKEN-}"
}

copy_file_if_present() {
	local source="$1"
	local dest="$2"

	if [[ -z ${source} ]]; then
		return 0
	fi

	[[ -f ${source} ]] || die "runtime file source does not exist: ${source}"
	mkdir -p "$(dirname "${dest}")"
	cp "${source}" "${dest}"
	chmod go-rwx "${dest}"
}

normalize_runtime_dest() {
	local raw_dest="$1"
	local dest="${raw_dest//\\//}"

	while [[ ${dest} == ./* ]]; do
		dest="${dest#./}"
	done

	while [[ ${dest} == */ ]]; do
		dest="${dest%/}"
	done

	if [[ -z ${dest} || ${dest} == "." ]]; then
		die "runtime file destination must be a bundle-relative path"
	fi

	if [[ ${dest} == /* || ${dest} =~ ^[A-Za-z]:/ ]]; then
		die "runtime file destination must be relative: ${raw_dest}"
	fi

	IFS='/' read -r -a segments <<<"${dest}"
	for segment in "${segments[@]}"; do
		if [[ ${segment} == ".." ]]; then
			die "runtime file destination must stay inside runtime-files: ${raw_dest}"
		fi
	done

	printf '%s' "${dest}"
}

shell_quote_args() {
	local args=("$@")
	local quoted=""

	for arg in "${args[@]}"; do
		quoted+="$(printf '%q' "${arg}") "
	done

	printf '%s' "${quoted% }"
}

runner_temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
action_temp="${runner_temp}/rush-delivery-action"
mkdir -p "${action_temp}"

module="${INPUT_MODULE:-${GITHUB_ACTION_PATH}}"
entrypoint="${INPUT_ENTRYPOINT:-workflow}"
repo_input="${INPUT_REPO-}"
workflow_env_file="${action_temp}/dagger-workflow.env"
deploy_env_file="${action_temp}/dagger-deploy.env"
release_env_file="${action_temp}/dagger-release.env"
runtime_files="${INPUT_RUNTIME_FILES:-${action_temp}/runtime-files}"

: >"${workflow_env_file}"
: >"${deploy_env_file}"
: >"${release_env_file}"
chmod 0600 "${workflow_env_file}" "${deploy_env_file}" "${release_env_file}"

append_env_content "${workflow_env_file}" "${INPUT_WORKFLOW_ENV_FILE-}" "${INPUT_WORKFLOW_ENV-}" "workflow-env"
append_env_content "${deploy_env_file}" "${INPUT_DEPLOY_ENV_FILE-}" "${INPUT_DEPLOY_ENV-}" "deploy-env"
append_env_content "${release_env_file}" "${INPUT_RELEASE_ENV_FILE-}" "${INPUT_RELEASE_ENV-}" "release-env"

case "${INPUT_INCLUDE_GITHUB_ENV:-true}" in
true | TRUE | True | 1 | yes | YES | Yes | on | ON | On)
	case "${entrypoint}" in
	workflow)
		append_github_env "${workflow_env_file}"
		;;
	validate)
		append_github_env "${deploy_env_file}"
		;;
	releasePackages | release-packages)
		append_github_env "${release_env_file}"
		;;
	*) ;;
	esac
	;;
*) ;;
esac

mkdir -p "${runtime_files}"

if [[ -n ${INPUT_RUNTIME_FILE_MAP-} ]]; then
	while IFS= read -r mapping || [[ -n ${mapping} ]]; do
		[[ -z ${mapping} || ${mapping} =~ ^[[:space:]]*# ]] && continue

		if [[ ${mapping} != *"=>"* ]]; then
			die "runtime-file-map entries must use SOURCE=>DEST: ${mapping}"
		fi

		source_path="${mapping%%=>*}"
		raw_dest="${mapping#*=>}"

		if [[ -z ${source_path} ]]; then
			continue
		fi

		dest_path="$(normalize_runtime_dest "${raw_dest}")"
		copy_file_if_present "${source_path}" "${runtime_files}/${dest_path}"
	done <<<"${INPUT_RUNTIME_FILE_MAP}"
fi

git_sha="${INPUT_GIT_SHA:-${GITHUB_SHA-}}"
[[ -n ${git_sha} ]] || die "git-sha input or GITHUB_SHA is required"

event_name="${INPUT_EVENT_NAME:-${GITHUB_EVENT_NAME:-push}}"
force_targets_json="${INPUT_FORCE_TARGETS_JSON:-[]}"
release_targets_json="${INPUT_RELEASE_TARGETS_JSON:-[]}"
validate_targets_json="${INPUT_VALIDATE_TARGETS_JSON:-[]}"
pr_base_sha="${INPUT_PR_BASE_SHA:-${RD_PR_BASE_SHA-}}"
deploy_tag_prefix="${INPUT_DEPLOY_TAG_PREFIX:-deploy/prod}"
artifact_prefix="${INPUT_ARTIFACT_PREFIX:-deploy-target}"
environment="${INPUT_ENVIRONMENT:-prod}"
dry_run="${INPUT_DRY_RUN:-true}"
toolchain_image_provider="${INPUT_TOOLCHAIN_IMAGE_PROVIDER:-off}"
toolchain_image_policy="${INPUT_TOOLCHAIN_IMAGE_POLICY-}"
rush_cache_provider="${INPUT_RUSH_CACHE_PROVIDER:-off}"
rush_cache_policy="${INPUT_RUSH_CACHE_POLICY-}"
application_image_provider="${INPUT_APPLICATION_IMAGE_PROVIDER:-off}"
source_mode="${INPUT_SOURCE_MODE:-git}"
source_import_policy="${INPUT_SOURCE_IMPORT_POLICY:-bounded}"
source_import_ignore_file="${INPUT_SOURCE_IMPORT_IGNORE_FILE:-.dagger/source-import.ignore}"
source_repository_url="${INPUT_SOURCE_REPOSITORY_URL-}"
source_ref="${INPUT_SOURCE_REF:-${GITHUB_REF-}}"
source_auth_token_env="${INPUT_SOURCE_AUTH_TOKEN_ENV:-GITHUB_TOKEN}"
source_auth_username="${INPUT_SOURCE_AUTH_USERNAME-}"
host_workspace_dir="${INPUT_HOST_WORKSPACE_DIR:-${GITHUB_WORKSPACE-}}"
if [[ -v INPUT_DOCKER_SOCKET ]]; then
	docker_socket="${INPUT_DOCKER_SOCKET}"
else
	docker_socket="/var/run/docker.sock"
fi

if [[ -z ${source_repository_url} && -n ${GITHUB_SERVER_URL-} && -n ${GITHUB_REPOSITORY-} ]]; then
	source_repository_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git"
fi

bounded_local_copy="false"
case "${source_mode}" in
git)
	printf '%s\n' '[source-import] bounded local-copy settings are ignored in Git source mode' >&2
	;;
local_copy)
	case "${source_import_policy}" in
	bounded) bounded_local_copy="true" ;;
	legacy) ;;
	*) die "source-import-policy must be bounded or legacy" ;;
	esac
	;;
*) die "source-mode must be git or local_copy" ;;
esac

if [[ -z ${toolchain_image_policy} ]]; then
	if [[ ${entrypoint} == "validate" ]]; then
		toolchain_image_policy="pull-or-build"
	else
		toolchain_image_policy="lazy"
	fi
fi

if [[ -z ${rush_cache_policy} ]]; then
	if [[ ${entrypoint} == "validate" ]]; then
		rush_cache_policy="pull-or-build"
	else
		rush_cache_policy="lazy"
	fi
fi

append_source_args() {
	args+=("--source-mode=${source_mode}")

	if [[ -n ${source_repository_url} ]]; then
		args+=("--source-repository-url=${source_repository_url}")
	fi

	if [[ -n ${source_ref} ]]; then
		args+=("--source-ref=${source_ref}")
	fi

	if [[ -n ${source_auth_token_env} ]]; then
		args+=("--source-auth-token-env=${source_auth_token_env}")
	fi

	if [[ -n ${source_auth_username} ]]; then
		args+=("--source-auth-username=${source_auth_username}")
	fi

	if [[ -n ${repo_input} ]]; then
		args+=("--repo=${repo_input}")
	fi
}

case "${entrypoint}" in
workflow)
	args=(
		workflow
		"--git-sha=${git_sha}"
		"--event-name=${event_name}"
		"--force-targets-json=${force_targets_json}"
		"--release-targets-json=${release_targets_json}"
		"--pr-base-sha=${pr_base_sha}"
		"--deploy-tag-prefix=${deploy_tag_prefix}"
		"--artifact-prefix=${artifact_prefix}"
		"--environment=${environment}"
		"--dry-run=${dry_run}"
		"--workflow-env-file=${workflow_env_file}"
		"--deploy-env-file=${deploy_env_file}"
		"--toolchain-image-provider=${toolchain_image_provider}"
		"--toolchain-image-policy=${toolchain_image_policy}"
		"--rush-cache-provider=${rush_cache_provider}"
		"--rush-cache-policy=${rush_cache_policy}"
		"--application-image-provider=${application_image_provider}"
		"--runtime-files=${runtime_files}"
	)
	if [[ ${release_targets_json} != "[]" || -s ${release_env_file} ]]; then
		args+=("--release-env-file=${release_env_file}")
	fi
	if [[ ${bounded_local_copy} == "false" ]]; then
		append_source_args
	fi

	if [[ -n ${host_workspace_dir} ]]; then
		args+=("--host-workspace-dir=${host_workspace_dir}")
	fi

	if [[ -n ${docker_socket} ]]; then
		args+=("--docker-socket=${docker_socket}")
	fi
	;;
validate)
	args=(
		validate
		"--git-sha=${git_sha}"
		"--event-name=${event_name}"
		"--pr-base-sha=${pr_base_sha}"
		"--validate-targets-json=${validate_targets_json}"
		"--deploy-env-file=${deploy_env_file}"
		"--toolchain-image-provider=${toolchain_image_provider}"
		"--toolchain-image-policy=${toolchain_image_policy}"
		"--rush-cache-provider=${rush_cache_provider}"
		"--rush-cache-policy=${rush_cache_policy}"
	)
	if [[ ${bounded_local_copy} == "false" ]]; then
		append_source_args
	fi
	;;
releasePackages | release-packages)
	args=(
		release-packages
		"--git-sha=${git_sha}"
		"--dry-run=${dry_run}"
		"--release-env-file=${release_env_file}"
		"--toolchain-image-provider=${toolchain_image_provider}"
		"--toolchain-image-policy=${toolchain_image_policy}"
		"--rush-cache-provider=${rush_cache_provider}"
		"--rush-cache-policy=${rush_cache_policy}"
	)
	if [[ ${bounded_local_copy} == "false" ]]; then
		append_source_args
	fi
	;;
*)
	die "unsupported entrypoint: ${entrypoint}"
	;;
esac

dagger_shell=""
if [[ ${bounded_local_copy} == "true" ]]; then
	bounded_repo="${repo_input:-${GITHUB_WORKSPACE:-.}}"
	launcher_args=(
		"--emit-shell"
		"--module=${module}"
		"--repo=${bounded_repo}"
		"--source-import-policy=${source_import_policy}"
		"--source-import-ignore-file=${source_import_ignore_file}"
	)
	if [[ -n ${INPUT_EXTRA_ARGS-} ]]; then
		launcher_args+=("--trusted-extra-args=${INPUT_EXTRA_ARGS}")
	fi
	launcher_args+=("--" "${args[@]}")
	dagger_shell="$("${GITHUB_ACTION_PATH}/github-action/rush-delivery-local" "${launcher_args[@]}")"
	call_args=""
else
	call_args="$(shell_quote_args "${args[@]}")"
	if [[ -n ${INPUT_EXTRA_ARGS-} ]]; then
		call_args="${call_args} ${INPUT_EXTRA_ARGS}"
	fi
fi

write_output module "${module}"
write_output args "${call_args}"
write_output shell "${dagger_shell}"
write_output workflow-env-file "${workflow_env_file}"
write_output deploy-env-file "${deploy_env_file}"
write_output release-env-file "${release_env_file}"
write_output runtime-files "${runtime_files}"
