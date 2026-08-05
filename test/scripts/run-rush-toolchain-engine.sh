#!/usr/bin/env bash
set -euo pipefail

RUSH_TOOLCHAIN_ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUSH_TOOLCHAIN_REPO_ROOT="$(cd "${RUSH_TOOLCHAIN_ENGINE_DIR}/../.." && pwd)"
export RUSH_TOOLCHAIN_EXAMPLE_ROOT="${RUSH_TOOLCHAIN_REPO_ROOT}/examples/oci-application-image-rush-repo"
export RUSH_TOOLCHAIN_METADATA_FIXTURE="${RUSH_TOOLCHAIN_REPO_ROOT}/test/fixtures/rush-toolchain.yaml"
export RUSH_TOOLCHAIN_PACKAGE_FIXTURE="${RUSH_TOOLCHAIN_REPO_ROOT}/test/fixtures/rush-toolchain-package.json"
export RUSH_TOOLCHAIN_PLAN_FIXTURE="${RUSH_TOOLCHAIN_REPO_ROOT}/test/fixtures/rush-toolchain-ci-plan.json"

result="$({
	DAGGER_NO_NAG=1 dagger --silent shell -m "${RUSH_TOOLCHAIN_REPO_ROOT}" -c '
repo=$(host | directory $RUSH_TOOLCHAIN_EXAMPLE_ROOT --exclude="common/temp")
toolchain=$(host | file $RUSH_TOOLCHAIN_METADATA_FIXTURE)
package=$(host | file $RUSH_TOOLCHAIN_PACKAGE_FIXTURE)
plan=$(host | file $RUSH_TOOLCHAIN_PLAN_FIXTURE)
repo=$($repo | with-file .dagger/toolchains/rush.yaml $toolchain | with-file apps/control-plane-api/package.json $package)
build-deploy-targets $repo $plan --dry-run=true | file apps/control-plane-api/dist/payload.txt | contents
'
} 2>&1)" || {
	printf '%s\n' "${result}" >&2
	exit 1
}

RUSH_TOOLCHAIN_ENGINE_RESULT="${result}" node -e '
const output = process.env.RUSH_TOOLCHAIN_ENGINE_RESULT ?? "";
if (!output.includes("Rush Delivery OCI application-image tutorial payload.")) {
  throw new Error("custom Rush toolchain build did not return the canonical payload");
}
'

printf '%s\n' 'rush-delivery custom Rush toolchain engine acceptance passed'
