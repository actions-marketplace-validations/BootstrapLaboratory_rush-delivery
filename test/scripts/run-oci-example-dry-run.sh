#!/usr/bin/env bash
set -euo pipefail

OCI_EXAMPLE_TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OCI_EXAMPLE_REPO_ROOT="$(cd -- "${OCI_EXAMPLE_TEST_DIR}/../.." && pwd)"
OCI_EXAMPLE_SOURCE="${OCI_EXAMPLE_REPO_ROOT}/examples/oci-application-image-rush-repo"
OCI_EXAMPLE_GIT_SHA="0123456789abcdef0123456789abcdef01234567"
OCI_EXAMPLE_TEMP_ROOT="${TMPDIR:-/tmp}"
OCI_EXAMPLE_TEMP="$(mktemp -d "${OCI_EXAMPLE_TEMP_ROOT%/}/rush-delivery-oci-example.XXXXXX")"

cleanup() {
	if [[ ${OCI_EXAMPLE_TEMP} != "${OCI_EXAMPLE_TEMP_ROOT%/}/rush-delivery-oci-example."* ]]; then
		printf 'refusing unsafe OCI example cleanup target\n' >&2
		return 1
	fi

	find "${OCI_EXAMPLE_TEMP}" -depth -delete
}
trap cleanup EXIT

for command in dagger node tar; do
	command -v "${command}" >/dev/null 2>&1 || {
		printf 'OCI example acceptance requires %s\n' "${command}" >&2
		exit 1
	}
done

fixture_directory="${OCI_EXAMPLE_TEMP}/fixture"
mkdir -p "${fixture_directory}"
tar \
	--exclude='./.dagger/runtime' \
	--exclude='./apps/control-plane-api/.rush' \
	--exclude='./apps/control-plane-api/dist' \
	--exclude='./apps/control-plane-api/node_modules' \
	--exclude='./apps/control-plane-api/rush-logs' \
	--exclude='./common/temp' \
	--exclude='./node_modules' \
	-C "${OCI_EXAMPLE_SOURCE}" \
	-cf - . | tar -C "${fixture_directory}" -xf -

output_directory="${OCI_EXAMPLE_TEMP}/output"
DAGGER_NO_NAG=1 dagger call build-and-package-deploy-targets \
	--repo="${fixture_directory}" \
	--ci-plan-file="${fixture_directory}/ci/oci-plan.json" \
	--git-sha="${OCI_EXAMPLE_GIT_SHA}" \
	--source-repository-url="https://github.com/BootstrapLaboratory/rush-delivery.git" \
	--dry-run=true \
	--application-image-provider=off \
	export --path="${output_directory}"

node "${OCI_EXAMPLE_TEST_DIR}/verify-oci-example-dry-run.mjs" \
	"${output_directory}" \
	"${OCI_EXAMPLE_GIT_SHA}"
