#!/usr/bin/env bash
set -euo pipefail

LOCAL_SOURCE_ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_SOURCE_REPO_ROOT="$(cd "${LOCAL_SOURCE_ENGINE_DIR}/../.." && pwd)"
LOCAL_SOURCE_FIXTURE="${LOCAL_SOURCE_REPO_ROOT}/test/fixtures/local-source-repo"
LOCAL_SOURCE_TEMP_DIR="$(mktemp -d)"
LOCAL_SOURCE_TEST_REPO="${LOCAL_SOURCE_TEMP_DIR}/repo with 'quoted' spaces"
readonly LOCAL_SOURCE_ENGINE_DIR LOCAL_SOURCE_REPO_ROOT LOCAL_SOURCE_FIXTURE
readonly LOCAL_SOURCE_TEMP_DIR LOCAL_SOURCE_TEST_REPO

cleanup() {
	rm -rf -- "${LOCAL_SOURCE_TEMP_DIR}"
}
trap cleanup EXIT

cp -R "${LOCAL_SOURCE_FIXTURE}" "${LOCAL_SOURCE_TEST_REPO}"
mkdir -p \
	"${LOCAL_SOURCE_TEST_REPO}/packages/excluded/node_modules" \
	"${LOCAL_SOURCE_TEST_REPO}/packages/required/node_modules"
printf '%s\n' 'must not transfer' >"${LOCAL_SOURCE_TEST_REPO}/packages/excluded/node_modules/drop.txt"
printf '%s\n' 'required generated tool' >"${LOCAL_SOURCE_TEST_REPO}/packages/required/node_modules/keep.txt"

git -C "${LOCAL_SOURCE_TEST_REPO}" init --quiet --initial-branch=main
git -C "${LOCAL_SOURCE_TEST_REPO}" -c user.name='Rush Delivery Test' -c user.email='test@example.invalid' add --force .
git -C "${LOCAL_SOURCE_TEST_REPO}" -c user.name='Rush Delivery Test' -c user.email='test@example.invalid' commit --quiet -m 'test: initialize bounded source fixture'
git -C "${LOCAL_SOURCE_TEST_REPO}" tag deploy/prod/bootstrap
local_source_git_sha="$(git -C "${LOCAL_SOURCE_TEST_REPO}" rev-parse HEAD)"

generated_shell="$({
	"${LOCAL_SOURCE_REPO_ROOT}/github-action/rush-delivery-local" \
		--emit-shell \
		--module="${LOCAL_SOURCE_REPO_ROOT}" \
		--repo="${LOCAL_SOURCE_TEST_REPO}" \
		-- \
		release-packages \
		--git-sha="${local_source_git_sha}" \
		--dry-run=true
})"
directory_shell="${generated_shell%%$'\n'*}"

excluded="$({
	DAGGER_NO_NAG=1 dagger --silent shell -m "${LOCAL_SOURCE_REPO_ROOT}" -c "${directory_shell}
\$repo | exists packages/excluded/node_modules/drop.txt"
} 2>&1)"
[[ ${excluded} == *false* ]] || {
	printf '%s\n' "${excluded}" >&2
	exit 1
}

included="$({
	DAGGER_NO_NAG=1 dagger --silent shell -m "${LOCAL_SOURCE_REPO_ROOT}" -c "${directory_shell}
\$repo | file packages/required/node_modules/keep.txt | contents"
} 2>&1)"
[[ ${included} == *'required generated tool'* ]] || {
	printf '%s\n' "${included}" >&2
	exit 1
}

git_retained="$({
	DAGGER_NO_NAG=1 dagger --silent shell -m "${LOCAL_SOURCE_REPO_ROOT}" -c "${directory_shell}
\$repo | directory .git | entries"
} 2>&1)"
[[ ${git_retained} == *HEAD* && ${git_retained} == *refs/* ]] || {
	printf '%s\n' "${git_retained}" >&2
	exit 1
}

release_result="$({
	DAGGER_NO_NAG=1 dagger --silent shell -m "${LOCAL_SOURCE_REPO_ROOT}" -c "${generated_shell}"
} 2>&1)"
[[ ${release_result} == *'"skipped": true'* ]] || {
	printf '%s\n' "${release_result}" >&2
	exit 1
}

mandatory_failure="$({
	mandatory_directory_shell="${directory_shell%)} --exclude='.git')"
	DAGGER_NO_NAG=1 dagger --silent shell -m "${LOCAL_SOURCE_REPO_ROOT}" -c "
${mandatory_directory_shell}
local-source --repo=\$repo | release-packages --dry-run=true
" 2>&1
} || true)"
[[ ${mandatory_failure} == *'requires retained paths: .git'* ]] || {
	printf '%s\n' "${mandatory_failure}" >&2
	exit 1
}

printf '%s\n' 'rush-delivery bounded local-source engine acceptance passed'
