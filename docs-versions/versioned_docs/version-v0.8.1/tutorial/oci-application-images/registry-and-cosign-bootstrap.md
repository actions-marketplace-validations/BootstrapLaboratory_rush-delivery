---
title: "3 - Registry And Cosign Bootstrap"
sidebar_label: "3 - Registry And Cosign Bootstrap"
---

This chapter configures one GHCR destination and one password-protected Cosign
key pair. It does not publish an image.

## Prerequisites

- Complete [Provider-Off Dry Run](../provider-off-dry-run).
- Own or administer a GitHub repository and a GHCR namespace that may receive
  `ghcr.io/<owner>/rush-delivery-tutorial/control-plane-api`.
- Install `gh` and authenticate it to the target GitHub repository.
- Prefer an installed Cosign `3.1.2`; a pinned-container workstation option is
  included below.
- Create or select a protected GitHub environment named `production` before
  storing its secrets.

The GHCR owner and every repository component must be lowercase and normalized.
Provider metadata is literal YAML: it does not interpolate shell variables,
GitHub expressions, or `${NAME}` placeholders.

## Review The Complete Provider Template

The checked-in
[`providers.yaml`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/examples/oci-application-image-rush-repo/.dagger/application-images/providers.yaml)
is complete and schema-valid, but `example/...` is intentionally not a pushable
tutorial destination:

```yaml
# GHCR tutorial template: replace "example" with a normalized owner before use.
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.8.1/application-image-providers.schema.json
providers:
  ghcr:
    kind: oci_registry
    registry: ghcr.io
    repository_prefix: example/rush-delivery-tutorial
    username_env: RD_OCI_GHCR_USERNAME
    token_env: RD_OCI_GHCR_TOKEN
    signing_key_env: RD_OCI_COSIGN_PRIVATE_KEY
    signing_password_env: RD_OCI_COSIGN_PASSWORD
    verification_key_env: RD_OCI_COSIGN_PUBLIC_KEY
```

Replace the template with a literal owner now:

```bash
set -euo pipefail

IFS= read -r -p 'Lowercase GHCR owner: ' GHCR_OWNER
[[ ${GHCR_OWNER} =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]]
IFS= read -r -p 'GitHub username that authenticates the GHCR token: ' \
  GHCR_USERNAME
test -n "${GHCR_USERNAME}"
[[ ${GHCR_USERNAME} != *[[:space:]]* ]]

python3 - "${GHCR_OWNER}" \
  .dagger/application-images/providers.yaml <<'PY'
from pathlib import Path
import sys

owner = sys.argv[1]
path = Path(sys.argv[2])
source = path.read_text(encoding="utf-8")
needle = "repository_prefix: example/rush-delivery-tutorial"
if source.count(needle) != 1:
    raise SystemExit("provider template line was not found exactly once")
path.write_text(
    source.replace(
        needle,
        f"repository_prefix: {owner}/rush-delivery-tutorial",
    ),
    encoding="utf-8",
)
PY

grep -F "repository_prefix: ${GHCR_OWNER}/rush-delivery-tutorial" \
  .dagger/application-images/providers.yaml
```

If the owner check fails, normalize the account/organization spelling rather
than adding uppercase or an unsupported path to metadata. If validation later
reports an invalid provider, compare the complete file with the
[v0.8.1 provider schema](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/schemas/v0.8.1/application-image-providers.schema.json).
`GHCR_OWNER` is the destination user or organization namespace;
`GHCR_USERNAME` is the user that authenticates the token. They are often
different when publishing to an organization.

## Generate A Password-Protected Cosign 3.1.2 Key

### Preferred: installed binary

Verify the exact installed version, create a private directory outside the Git
repository, and prompt without putting the password in shell history or process
arguments:

```bash
set -euo pipefail

cosign version
cosign version 2>&1 | grep -F 'GitVersion:    v3.1.2'

export OCI_SECRET_DIR="${TMPDIR:-/tmp}/rush-delivery-oci-secrets-${USER:-operator}"
test ! -e "${OCI_SECRET_DIR}"
umask 077
mkdir -m 0700 "${OCI_SECRET_DIR}"

IFS= read -r -s -p 'New Cosign key password: ' COSIGN_PASSWORD
printf '\n'
test -n "${COSIGN_PASSWORD}"
[[ ${COSIGN_PASSWORD} != [[:space:]]* ]]
[[ ${COSIGN_PASSWORD} != *[[:space:]] ]]
[[ ${COSIGN_PASSWORD} != *$'\r'* ]]
[[ ${COSIGN_PASSWORD} != *$'\n'* ]]
export COSIGN_PASSWORD
cosign generate-key-pair \
  --output-key-prefix "${OCI_SECRET_DIR}/cosign"
printf '%s' "${COSIGN_PASSWORD}" > "${OCI_SECRET_DIR}/cosign-password.txt"
unset COSIGN_PASSWORD
chmod 0600 "${OCI_SECRET_DIR}"/*
```

Sanitized expected output:

```text
GitVersion:    v3.1.2
Private key written to /tmp/.../cosign.key
Public key written to /tmp/.../cosign.pub
```

The whitespace checks reject a password that begins or ends with whitespace,
because the public flat-env record parser trims each physical line. The explicit
CR/LF checks reject line breaks. Internal spaces are allowed.

### Alternative: digest-pinned container on an operator workstation

This Docker command is only a one-time operator key-bootstrap option. It is not
part of OCI Package and does not imply that Rush Delivery needs a host Docker
CLI, daemon, or socket. Podman can be substituted with equivalent bind-mount and
environment semantics.

```bash
set -euo pipefail

COSIGN_IMAGE='ghcr.io/sigstore/cosign/cosign@sha256:d91bc4e7e95e8d2f549c747a72dc174f90579e410a1695f57f686674f84ce849'
export OCI_CONTAINER_KEY_DIR="${TMPDIR:-/tmp}/rush-delivery-cosign-container-${USER:-operator}"
test ! -e "${OCI_CONTAINER_KEY_DIR}"
umask 077
mkdir -m 0700 "${OCI_CONTAINER_KEY_DIR}"

printf '%s\n' \
  'Cosign will prompt twice. Store that password in your protected password manager.'
docker run --rm --interactive --tty \
  --user="$(id -u):$(id -g)" \
  --mount="type=bind,src=${OCI_CONTAINER_KEY_DIR},dst=/keys" \
  "${COSIGN_IMAGE}" \
  generate-key-pair --output-key-prefix=/keys/cosign

IFS= read -r -s -p 'Re-enter the same password for the local env file: ' \
  COSIGN_PASSWORD
printf '\n'
test -n "${COSIGN_PASSWORD}"
[[ ${COSIGN_PASSWORD} != [[:space:]]* ]]
[[ ${COSIGN_PASSWORD} != *[[:space:]] ]]
[[ ${COSIGN_PASSWORD} != *$'\r'* ]]
[[ ${COSIGN_PASSWORD} != *$'\n'* ]]
printf '%s' "${COSIGN_PASSWORD}" > \
  "${OCI_CONTAINER_KEY_DIR}/cosign-password.txt"
unset COSIGN_PASSWORD
chmod 0600 "${OCI_CONTAINER_KEY_DIR}"/*
export OCI_SECRET_DIR="${OCI_CONTAINER_KEY_DIR}"
```

`--rm` removes the temporary container, the explicit host UID/GID owns the key
files, and Cosign reads the generation password from the interactive terminal.
The password is never placed in the Docker container configuration, command
arguments, or shell history. The later Rush Delivery preflight checks that the
re-entered value decrypts the generated key before any application image is
built or published. Do not use `docker create --env=COSIGN_PASSWORD`; that
persists the password in inspectable container configuration until deletion.

Use one key-generation path, never both. The container path explicitly aliases
its directory to `OCI_SECRET_DIR`, so every following command is identical for
both choices.

## Verify Markers And Flatten The PEM Values

The private key must be encrypted and the public key must match these markers:

```bash
head -n 1 "${OCI_SECRET_DIR}/cosign.key"
tail -n 1 "${OCI_SECRET_DIR}/cosign.key"
head -n 1 "${OCI_SECRET_DIR}/cosign.pub"
tail -n 1 "${OCI_SECRET_DIR}/cosign.pub"
```

Expected output:

```text
-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----
-----END ENCRYPTED SIGSTORE PRIVATE KEY-----
-----BEGIN PUBLIC KEY-----
-----END PUBLIC KEY-----
```

Rush Delivery's public flat-env parser accepts one physical line per value.
Convert real newlines to literal backslash-`n` pairs, then prove a byte-for-byte
round trip before using the result:

```bash
python3 - \
  "${OCI_SECRET_DIR}/cosign.key" \
  "${OCI_SECRET_DIR}/cosign.key.flat" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8")
Path(sys.argv[2]).write_text(source.replace("\n", r"\n"), encoding="utf-8")
PY

python3 - \
  "${OCI_SECRET_DIR}/cosign.pub" \
  "${OCI_SECRET_DIR}/cosign.pub.flat" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8")
Path(sys.argv[2]).write_text(source.replace("\n", r"\n"), encoding="utf-8")
PY

python3 - \
  "${OCI_SECRET_DIR}/cosign.key.flat" \
  "${OCI_SECRET_DIR}/cosign.key.roundtrip" <<'PY'
from pathlib import Path
import sys

flat = Path(sys.argv[1]).read_text(encoding="utf-8")
Path(sys.argv[2]).write_text(flat.replace(r"\n", "\n"), encoding="utf-8")
PY

python3 - \
  "${OCI_SECRET_DIR}/cosign.pub.flat" \
  "${OCI_SECRET_DIR}/cosign.pub.roundtrip" <<'PY'
from pathlib import Path
import sys

flat = Path(sys.argv[1]).read_text(encoding="utf-8")
Path(sys.argv[2]).write_text(flat.replace(r"\n", "\n"), encoding="utf-8")
PY

cmp "${OCI_SECRET_DIR}/cosign.key" \
  "${OCI_SECRET_DIR}/cosign.key.roundtrip"
cmp "${OCI_SECRET_DIR}/cosign.pub" \
  "${OCI_SECRET_DIR}/cosign.pub.roundtrip"
test "$(wc -l < "${OCI_SECRET_DIR}/cosign.key.flat")" -eq 0
test "$(wc -l < "${OCI_SECRET_DIR}/cosign.pub.flat")" -eq 0
```

The `wc` results are zero because each flat file contains literal `\n` pairs
and no physical newline. Do not paste raw multiline PEM into a public Action
env input: raw multiline acceptance is only an internal normalization test in
`v0.8.1`.

## Create The Local Flat Env File

Create a time-bounded GHCR token for a dedicated release/bot identity. For a
classic personal access token this normally means `write:packages`, which also
includes package read; organization policy or SSO may require authorization.
Do not add `delete:packages` to the publishing token. Classic PAT package scopes
are account-wide capabilities, not a token-level restriction to the tutorial
namespace or one package. Constrain effective access with the bot's
organization/package permissions, keep unrelated package access off that
account, record an owner and expiry, and test rotation before revoking the old
token. Do not use a developer's general-purpose PAT. GitHub documents the
package scopes and repository linkage in
[Working with the Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

```bash
IFS= read -r -s -p 'GHCR token: ' RD_OCI_GHCR_TOKEN
printf '\n'
test -n "${RD_OCI_GHCR_TOKEN}"
[[ ${RD_OCI_GHCR_TOKEN} != [[:space:]]* ]]
[[ ${RD_OCI_GHCR_TOKEN} != *[[:space:]] ]]
[[ ${RD_OCI_GHCR_TOKEN} != *$'\r'* ]]
[[ ${RD_OCI_GHCR_TOKEN} != *$'\n'* ]]
printf '%s' "${RD_OCI_GHCR_TOKEN}" > \
  "${OCI_SECRET_DIR}/ghcr-token.txt"
unset RD_OCI_GHCR_TOKEN

printf '%s' "${GHCR_USERNAME}" > "${OCI_SECRET_DIR}/ghcr-username.txt"

RD_OCI_COSIGN_PRIVATE_KEY="$(<"${OCI_SECRET_DIR}/cosign.key.flat")"
RD_OCI_COSIGN_PUBLIC_KEY="$(<"${OCI_SECRET_DIR}/cosign.pub.flat")"
RD_OCI_COSIGN_PASSWORD="$(<"${OCI_SECRET_DIR}/cosign-password.txt")"
RD_OCI_GHCR_TOKEN="$(<"${OCI_SECRET_DIR}/ghcr-token.txt")"

{
  printf 'RD_OCI_GHCR_USERNAME=%s\n' "${GHCR_USERNAME}"
  printf 'RD_OCI_GHCR_TOKEN=%s\n' "${RD_OCI_GHCR_TOKEN}"
  printf 'RD_OCI_COSIGN_PRIVATE_KEY=%s\n' \
    "${RD_OCI_COSIGN_PRIVATE_KEY}"
  printf 'RD_OCI_COSIGN_PASSWORD=%s\n' "${RD_OCI_COSIGN_PASSWORD}"
  printf 'RD_OCI_COSIGN_PUBLIC_KEY=%s\n' \
    "${RD_OCI_COSIGN_PUBLIC_KEY}"
} > "${OCI_SECRET_DIR}/deploy.env"

unset RD_OCI_COSIGN_PRIVATE_KEY RD_OCI_COSIGN_PUBLIC_KEY
unset RD_OCI_COSIGN_PASSWORD RD_OCI_GHCR_TOKEN
chmod 0600 "${OCI_SECRET_DIR}/deploy.env"
cut -d= -f1 "${OCI_SECRET_DIR}/deploy.env"
```

Expected output is names only:

```text
RD_OCI_GHCR_USERNAME
RD_OCI_GHCR_TOKEN
RD_OCI_COSIGN_PRIVATE_KEY
RD_OCI_COSIGN_PASSWORD
RD_OCI_COSIGN_PUBLIC_KEY
```

The canonical [`.gitignore`](https://github.com/BootstrapLaboratory/rush-delivery/blob/v0.8.1/examples/oci-application-image-rush-repo/.gitignore)
also rejects local generated state and common key/env names:

```text
common/temp/
**/.rush/temp/
**/node_modules/
**/rush-logs/
apps/control-plane-api/dist/
.dagger/runtime/
.env
.env.*
*.env
*.key
*.pem
*.pub
oci-package/
oci-package.tar
oci-package.tar.sha256
```

The primary protection is still storing the material outside the repository
with mode `0700`/`0600`; `.gitignore` is only a backstop.

## Store Protected GitHub Values

The following forms read values from files and do not echo them or put them in
CLI arguments. Run them from the target GitHub repository or add
`--repo=OWNER/REPOSITORY` to every command.

```bash
gh secret set RD_OCI_GHCR_TOKEN --env=production \
  < "${OCI_SECRET_DIR}/ghcr-token.txt"
gh secret set RD_OCI_COSIGN_PRIVATE_KEY --env=production \
  < "${OCI_SECRET_DIR}/cosign.key.flat"
gh secret set RD_OCI_COSIGN_PASSWORD --env=production \
  < "${OCI_SECRET_DIR}/cosign-password.txt"
gh variable set RD_OCI_GHCR_USERNAME --env=production \
  < "${OCI_SECRET_DIR}/ghcr-username.txt"
gh secret set RD_OCI_COSIGN_PUBLIC_KEY --env=production \
  < "${OCI_SECRET_DIR}/cosign.pub.flat"
```

If a command reports that the environment does not exist or access is denied,
create/authorize the protected `production` environment and retry. Do not fall
back to unprotected repository secrets for a live release merely to bypass an
environment gate.

## Select GHCR In A Credential-Free Dry Run

The named-provider dry run parses the provider and constructs its literal
repository, but deliberately does not read or cryptographically preflight any
key/token value:

```bash
export TUTORIAL_DRY_SHA="0123456789abcdef0123456789abcdef01234567"
NAMED_PLAN_DIR="${TMPDIR:-/tmp}/rush-delivery-oci-ghcr-plan"
test ! -e "${NAMED_PLAN_DIR}"

dagger -m "${RUSH_DELIVERY_MODULE}" call \
  build-and-package-deploy-targets \
  --repo=. \
  --ci-plan-file=ci/oci-plan.json \
  --artifact-prefix=deploy-target \
  --git-sha="${TUTORIAL_DRY_SHA}" \
  --source-repository-url=https://github.com/example/control-plane.git \
  --dry-run=true \
  --application-image-provider=ghcr \
  export --path="${NAMED_PLAN_DIR}"

jq -r '.artifacts["control-plane-api"].repository' \
  "${NAMED_PLAN_DIR}/.dagger/runtime/package-manifest.json"
```

Expected output:

```text
ghcr.io/<literal-lowercase-owner>/rush-delivery-tutorial/control-plane-api
```

If the output literally contains `example`, stop: the template has not been
made pushable. A request for any `RD_OCI_*` value during this dry run is a
failure of the no-credential contract.

## Credential Lifecycle And Trust Boundary

The five roles are distinct:

- username and token authenticate the subject publish plus Cosign's
  digest-derived signature/attestation attachment-tag writes;
- the encrypted private key signs the digest and two attestations;
- the password decrypts that private key only inside framework-owned Cosign
  execution;
- the public key verifies the private-key match and published objects.

Their environment names are also a validated part of the boundary: every one
must be globally unique across every provider in the file. Never reuse a token,
key, or password name as `username_env`; the registry username is intentionally
non-secret because Dagger's registry-auth call graph may display it.

Live Package performs an offline cryptographic preflight once per selected
provider before application-image build/publication: derive the public key,
sign a fixed challenge, and verify it with both the derived and configured
public keys. Dagger may need to pull the pinned Cosign container first. Registry
authentication itself cannot always be proven without a destination-registry
operation, so a later publication can still fail for permissions or endpoint
policy.

Rotate a token independently of the signing key. When rotating the signing key,
publish the new public key through reviewed configuration and retain every old
public key for at least as long as any image/bundle signed by it remains
deployable. Loss of the private key prevents new signatures but should not
invalidate retained releases; loss of an old public key prevents independent
verification of those releases. The v2 manifest records that the configured key
verified the digest-bound objects at Package time, but does not record a key
fingerprint, Rekor entry, certificate identity, or public-transparency proof.
Keep key identity/rotation records in the release control plane.

After secrets are stored and backed up according to policy, remove expendable
workstation copies with explicit paths. For example, inspect
`printf '%s\n' "${OCI_SECRET_DIR}"` first, then use
`find "${OCI_SECRET_DIR}" -type f -delete` and `rmdir "${OCI_SECRET_DIR}"`.
File deletion is not guaranteed secure erasure on copy-on-write or journaled
storage; use managed secret storage for production keys.

## Checkpoint

```bash
dagger -m "${RUSH_DELIVERY_MODULE}" call validate-metadata-contract \
  --repo=. >/dev/null
jq -e --arg repository \
  "ghcr.io/${GHCR_OWNER}/rush-delivery-tutorial/control-plane-api" \
  '.artifacts["control-plane-api"]
   | .status == "planned" and .repository == $repository
     and (has("digest") | not) and (has("evidence") | not)' \
  "${NAMED_PLAN_DIR}/.dagger/runtime/package-manifest.json"
```

Both commands should exit zero without reading `deploy.env`.

Next: [Publish And Inspect](../publish-and-inspect).
