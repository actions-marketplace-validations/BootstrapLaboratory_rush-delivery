# OCI Registry Recipes

This guide maps the Rush Delivery `v0.9.0` application-image provider contract
to common registries. Start with the production contract in
[OCI application images](oci-application-images.md), then complete the
[tutorial](tutorial/oci-application-images/README.md) with a disposable
namespace before using a production repository.

The recipes are deliberately explicit about test status:

| Recipe                                  | Repository status                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-neutral contract               | Parser/schema/unit tested. A project-controlled trusted-TLS endpoint is the required live release gate; its result must be recorded for each release candidate and is not claimed as continuous per-commit coverage here. |
| GitHub Container Registry (GHCR)        | Syntax-reviewed against current GitHub and Dagger documentation. It is the preferred project-controlled release-gate service, but a successful live gate must be recorded for each release candidate.                     |
| Google Artifact Registry (GAR)          | Syntax-reviewed against current Google Cloud documentation; no continuous live Rush Delivery test is claimed.                                                                                                             |
| Amazon Elastic Container Registry (ECR) | Syntax-reviewed against current AWS documentation; no continuous live Rush Delivery test is claimed.                                                                                                                      |
| Docker Hub                              | Syntax-reviewed against current Docker and Dagger documentation; no continuous live Rush Delivery test is claimed.                                                                                                        |

Production workflow dependencies must be immutable. Third-party actions in this
guide use full 40-character commit SHAs with a release-version comment; update
the SHA and comment together through reviewed dependency automation. Rush
Delivery examples use `@v0.9.0` to identify this guide's release contract. In a
strict consumer workflow, verify that release tag and replace it with the full
release commit SHA before merge. GitHub documents that only the full commit SHA
is immutable and can enforce full-SHA action references in repository or
organization policy; see its
[action security guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions).

Before adopting a service, run a live pre-production Package against the exact
registry tier, region, repository policy, and identity configuration you will
use. A vendor's general OCI support is not proof that its current settings
accept both Cosign attestations and the complete verification sequence.

## Registry Capability Contract

A compatible endpoint must provide:

- trusted TLS from the Dagger engine and pinned Cosign container;
- OCI image blob and manifest push;
- a canonical returned image digest;
- authenticated reads during Cosign verification;
- storage and discovery for the subject signature plus SPDX and provenance
  attestations;
- retention of the digest and associated Cosign objects for the audit and
  rollback window;
- operator-controlled inspection and cleanup; and
- a distinct pull identity for the deployment platform.

The [OCI Distribution Specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md)
defines image push, digest, tag, and deletion APIs. Cosign also documents a
broad but qualified
[registry support matrix](https://github.com/sigstore/cosign#registry-support).
Rush Delivery `v0.9.0` pins Cosign `3.1.2` and passes
`--new-bundle-format=false` on every registry sign, attest, and verify command.
That mode stores one digest-derived `.sig` attachment and a shared `.att`
attachment containing both attestations. It does not use or require the OCI 1.1
Referrers API. “Associated Cosign artifact” in this guide means either of those
tag-addressed objects or an untagged historical version—not a claim that the
Referrers API is in use. This is distinct from Cosign's legacy Docker media-type
fallback, which Rush Delivery does not enable. Custom CAs and insecure/HTTP
registries also remain unsupported. Test the exact endpoint rather than relying
on the product name alone.

Rush Delivery supplies the selected username/token directly to Dagger registry
authentication and mounts a generated Docker config as a Dagger secret for
Cosign. `docker login`, a host Docker CLI, and a Docker socket are not Package
prerequisites.

## Provider-Neutral Recipe

Use this shape for a standards-compatible private registry:

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/application-image-providers.schema.json
providers:
  release:
    kind: oci_registry
    registry: registry.example.com
    repository_prefix: platform/application-images
    username_env: RD_OCI_REGISTRY_USERNAME
    token_env: RD_OCI_REGISTRY_TOKEN
    signing_key_env: RD_OCI_COSIGN_PRIVATE_KEY
    signing_password_env: RD_OCI_COSIGN_PASSWORD
    verification_key_env: RD_OCI_COSIGN_PUBLIC_KEY
```

For `artifact.image: control-plane-api`, the destination is
`registry.example.com/platform/application-images/control-plane-api`.
`registry` is an authority, not `https://registry.example.com`; metadata does
not interpolate environment variables.

### Provisioning and permissions

Use the registry's control plane to create the namespace/repository before the
release. The publishing identity needs the narrow equivalent of:

- pull/read manifests and blobs, because Package verifies what it wrote;
- initiate, upload, and complete blobs;
- create/update the deterministic `sha-<full-git-sha>` tag and subject manifest;
- create/read the digest-derived `.sig` and `.att` attachment tags and their
  manifests; and
- read those objects for verification.

Give delete/retention administration to a separate cleanup identity when the
provider permits it. Give the deployment platform only subject pull/read access.

Map credentials without placing values in metadata:

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.9.0
  with:
    application-image-provider: release
    docker-socket: ""
    dry-run: "false"
    deploy-env: |
      RD_OCI_REGISTRY_USERNAME=${{ vars.RD_OCI_REGISTRY_USERNAME }}
      RD_OCI_REGISTRY_TOKEN=${{ secrets.RD_OCI_REGISTRY_TOKEN }}
      RD_OCI_COSIGN_PRIVATE_KEY=${{ secrets.RD_OCI_COSIGN_PRIVATE_KEY }}
      RD_OCI_COSIGN_PASSWORD=${{ secrets.RD_OCI_COSIGN_PASSWORD }}
      RD_OCI_COSIGN_PUBLIC_KEY=${{ secrets.RD_OCI_COSIGN_PUBLIC_KEY }}
```

The PEM secrets must contain literal `\n` separators, not actual
line breaks. Restrict live credentials to protected release jobs and trusted
events. The registry username is intentionally a non-secret variable because
Dagger may display it in the registry-auth call graph; never put sensitive data
in that value. Do not send live secrets to fork or untrusted pull-request
execution.

### Retention and cleanup

Retain the immutable subject, navigation tag, signature, combined attestation
attachment,
manifest/evidence bundle, public-key history, and external bundle checksum/SHA
record for the same rollback period. Preview lifecycle rules where supported.
Before deleting a partial release, inventory every tagged and untagged package
version. Tag deletion alone may not remove the subject, current attachments, or
superseded attachment history.

### Repository acceptance topology

Rush Delivery's repository-maintainer harness uses the canonical public example
with a trusted-TLS endpoint and a cryptographically unique repository namespace.
The official GitHub workflow is locked to the project's own GHCR namespace;
outside that exact repository context the harness requires an explicit endpoint,
repository prefix, retention policy, and harness-owned credentials. These
test-harness settings are not a consumer-facing dynamic provider feature. The
public provider metadata remains static.

For repository maintainers, the test-only invocation is shaped as follows:

```sh
acceptance_run="$(node -e \
  'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"

OCI_ACCEPTANCE_REGISTRY=ghcr.io \
OCI_ACCEPTANCE_REPOSITORY_PREFIX="bootstraplaboratory/rush-delivery-acceptance-${acceptance_run}" \
OCI_ACCEPTANCE_RETENTION_POLICY=delete-complete-package-on-exit \
OCI_ACCEPTANCE_CLEANUP_HOOK="$PWD/test/scripts/cleanup-ghcr-acceptance.sh" \
OCI_ACCEPTANCE_USERNAME="$GITHUB_ACTOR" \
OCI_ACCEPTANCE_TOKEN="$REGISTRY_TEST_TOKEN" \
GITHUB_TOKEN="$REGISTRY_TEST_TOKEN" \
test/scripts/run-oci-acceptance.sh
```

Run this from the repository root so the cleanup hook is an absolute executable
path. The cleanup identity needs permission to delete the complete test package;
if that stronger cleanup permission is deliberately separated from the push
identity, supply the corresponding job-scoped `GITHUB_TOKEN` instead of reusing
`REGISTRY_TEST_TOKEN`.

Use a project-controlled namespace with a cleanup/expiry policy. An explicitly
selected disposable service such as `ttl.sh` may be used as a fallback test
endpoint only after its availability, trusted TLS, retention, and Cosign
behavior are accepted for that run; it is not a silent default or production
recommendation. The harness generates ephemeral signing material within Dagger,
uses no host Docker/Podman CLI or socket, retries only bounded readiness/read
probes, and never automatically retries the mutating Package flow. After a
successful Package it exports the immutable digest with a bounded read retry,
checks the bundle, image archive, logs, evidence, manifest, and result for
credential sentinels, and invokes raw `deploy-release` to prove the exact digest
handoff. A transport failure after publication may have begun is an ambiguous
partial outcome that requires registry inspection and cleanup.

## GitHub Container Registry

**Test status:** syntax-reviewed. Use GHCR as the project-controlled live
release-gate endpoint, and record the gate result for the exact release
candidate. Do not infer continuous vendor coverage from unit tests.

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/application-image-providers.schema.json
providers:
  ghcr:
    kind: oci_registry
    registry: ghcr.io
    repository_prefix: acme/rush-delivery-images
    username_env: RD_OCI_GHCR_USERNAME
    token_env: RD_OCI_GHCR_TOKEN
    signing_key_env: RD_OCI_COSIGN_PRIVATE_KEY
    signing_password_env: RD_OCI_COSIGN_PASSWORD
    verification_key_env: RD_OCI_COSIGN_PUBLIC_KEY
```

Replace `acme` with the lowercase user or organization namespace. The resulting
example package is
`ghcr.io/acme/rush-delivery-images/control-plane-api`.

### Repository and publisher identity

GitHub recommends the job-scoped `GITHUB_TOKEN` for a workflow publishing a
package associated with its own repository. Set job permissions to
`contents: write` and `packages: write` for the composed live workflow, and map:

```yaml
permissions:
  contents: write
  packages: write

steps:
  - uses: BootstrapLaboratory/rush-delivery@v0.9.0
    with:
      application-image-provider: ghcr
      docker-socket: ""
      dry-run: "false"
      deploy-env: |
        RD_OCI_GHCR_USERNAME=${{ github.actor }}
        RD_OCI_GHCR_TOKEN=${{ github.token }}
        RD_OCI_COSIGN_PRIVATE_KEY=${{ secrets.RD_OCI_COSIGN_PRIVATE_KEY }}
        RD_OCI_COSIGN_PASSWORD=${{ secrets.RD_OCI_COSIGN_PASSWORD }}
        RD_OCI_COSIGN_PUBLIC_KEY=${{ secrets.RD_OCI_COSIGN_PUBLIC_KEY }}
```

`contents: write` is used by the successful composed workflow to move its
deploy tag; a raw Package-only job can keep `contents: read`. Neither setting is
needed by the GHCR protocol itself.

GitHub documents `GITHUB_TOKEN` publication, classic PAT scopes, and package
linking in [Working with the Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
Rush Delivery adds `org.opencontainers.image.source` when a source repository
URL is supplied. Confirm after the first push that the package is connected to
the intended repository and that Actions access is inherited or explicitly
granted. GitHub's
[package access guide](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
distinguishes Read, Write, and Admin package roles.

A repository that publishes the package through a workflow, or is explicitly
connected to the package, normally receives package Admin access. A job-scoped
`GITHUB_TOKEN` can therefore delete or restore package versions through GitHub's
preview REST API when that repository retains Admin access; `packages: write`
is not a provider-enforced separation from cleanup. Put any cleanup call in a
different, approved workflow and protected environment. A classic PAT without
`delete:packages` gives stronger token-scope separation, but classic package
scopes are not restricted to one package, repository prefix, or namespace;
effective access must also be constrained through the dedicated account,
organization, package, SSO, and Actions access policies.

If the built-in job token cannot target the required namespace, use a dedicated
classic PAT with `write:packages` (which includes read) and authorize SSO when
required. Do not grant `delete:packages` to the publisher unless the same job is
explicitly responsible for cleanup. Keep package administration and live
publishing out of untrusted PR jobs.

### GHCR pull, retention, and cleanup

Public GHCR packages can be pulled anonymously. For private/internal packages,
grant the deployment repository or platform identity Read access and use a
pull-only token; never reuse the publishing token as runtime pull identity.
Public visibility also exposes the image's registry-hosted Cosign signature and
attestation package versions:
classify the SPDX dependency inventory and provenance source/build parameters
before choosing anonymous pull access.
Cloud Run does not accept that GHCR token through its runtime service account:
direct GHCR deployment is for public images, while private GHCR must be exposed
through an authenticated Artifact Registry remote repository. Google documents
this restriction in
[Deploying container images to Cloud Run](https://docs.cloud.google.com/run/docs/deploying)
and lists `https://ghcr.io` as a supported
[custom remote-repository upstream](https://docs.cloud.google.com/artifact-registry/docs/repositories/remote-overview#custom_urls).

The deterministic SHA tag is navigation only. Retain the digest and Cosign
objects for every deployable release. Cleanup requires package Admin access;
GitHub documents package/version removal in
[Deleting and restoring a package](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package).
Inventory the subject plus every tagged and untagged signature/attestation
package version before deleting a failed subject, and verify the package list
afterward. GitHub's Actions delete/restore API
support is documented as preview, so do not make recovery depend on an
unverified automatic deletion workflow.

## Google Artifact Registry

**Test status:** syntax-reviewed against current Google Cloud documentation; no
continuous live Rush Delivery test is claimed.

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/application-image-providers.schema.json
providers:
  gar:
    kind: oci_registry
    registry: us-central1-docker.pkg.dev
    repository_prefix: acme-production/rush-delivery-images
    username_env: RD_OCI_GAR_USERNAME
    token_env: RD_OCI_GAR_TOKEN
    signing_key_env: RD_OCI_COSIGN_PRIVATE_KEY
    signing_password_env: RD_OCI_COSIGN_PASSWORD
    verification_key_env: RD_OCI_COSIGN_PUBLIC_KEY
```

Here `acme-production` is the Google Cloud project ID and
`rush-delivery-images` is an Artifact Registry Docker repository. Google
documents the full
[`LOCATION-docker.pkg.dev/PROJECT/REPOSITORY` naming form](https://docs.cloud.google.com/artifact-registry/docs/docker/names).

### Repository and permissions

Create the Docker repository before publishing:

```sh
gcloud artifacts repositories create rush-delivery-images \
  --project=acme-production \
  --location=us-central1 \
  --repository-format=docker \
  --description='Rush Delivery application images'
```

The current command and optional immutable-tag behavior are documented in
[Create standard repositories](https://cloud.google.com/artifact-registry/docs/repositories/create-repos).
Grant the publishing service account `roles/artifactregistry.writer` on this
repository. Package needs both push and read access for Cosign verification;
the Writer role supplies repository read/write capability. Use
`roles/artifactregistry.reader` for the deployment platform. Reserve
`roles/artifactregistry.repoAdmin` or a narrower custom delete role for cleanup;
Google's [image management guide](https://cloud.google.com/artifact-registry/docs/docker/manage-images)
separates tag/upload permissions from delete permissions.

The predefined Writer role is not a strict no-delete publisher role: Google's
[current role matrix](https://cloud.google.com/iam/docs/roles-permissions/artifactregistry)
includes broader deletion authority, including
`artifactregistry.attachments.delete`. Rush Delivery's tag-addressed Cosign
objects are ordinary OCI image artifacts and do not exercise the separate GAR
Attachment resource API; removing that one unrelated permission is therefore
not a complete no-delete policy. If publisher deletion must be prohibited,
create and live-test a custom repository role containing only the required
manifest, blob, and tag operations. Re-run acceptance whenever Google or Cosign
changes its registry operations.

Decide whether to enable immutable tags before the first release. Rush Delivery
uses the deterministic `sha-<full-git-sha>` navigation tag. With Artifact
Registry tag immutability, that tag can never move to a different digest, so a
same-source rebuild that produces different bytes is rejected even though the
subject itself is digest-addressed. Tagged versions in an immutable-tag
repository also cannot be deleted by cleanup policy. Treat the existing subject
as the release for that SHA, or use a separately governed repository/versioning
strategy for a replacement; validate retry and retention behavior in
pre-production. See Google's
[immutable-tag push contract](https://cloud.google.com/artifact-registry/docs/docker/pushing-and-pulling#tagging)
and
[cleanup tag-state rules](https://cloud.google.com/artifact-registry/docs/repositories/cleanup-policy#tag-state).

### Short-lived authentication

Prefer Workload Identity Federation and a short-lived access token over a
service-account key. Configure the pool provider's attribute mapping and CEL
condition to admit only the exact GitHub organization, repository, and
protected `production` environment, then grant that exact federated principal
`roles/iam.workloadIdentityUser` on the dedicated publisher service account.
Do not grant the whole pool. Google documents the required principal binding and
attribute restrictions in
[Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation)
and its
[federation security guidance](https://docs.cloud.google.com/iam/docs/best-practices-for-using-workload-identity-federation).
For the placeholders below, the provider condition must be equivalent to
`assertion.repository == 'acme/control-plane' && assertion.environment == 'production'`;
map both claims explicitly and keep the GitHub environment protected.

The following job exchanges the protected GitHub OIDC assertion directly for a
one-hour service-account access token and maps only that output to Rush
Delivery. The full action SHAs are the reviewed `actions/checkout@v5` and
`google-github-actions/auth@v3` revisions; retain the version comments when a
dependency updater replaces a SHA.

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - id: google-auth
        name: Exchange GitHub OIDC for a GAR access token
        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3
        with:
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: rush-delivery-publisher@acme-production.iam.gserviceaccount.com
          token_format: access_token
          access_token_lifetime: 3600s
          create_credentials_file: false
          export_environment_variables: false

      - name: Publish with Rush Delivery
        uses: BootstrapLaboratory/rush-delivery@v0.9.0
        with:
          application-image-provider: gar
          docker-socket: ""
          dry-run: "false"
          deploy-env: |
            RD_OCI_GAR_USERNAME=oauth2accesstoken
            RD_OCI_GAR_TOKEN=${{ steps.google-auth.outputs.access_token }}
            RD_OCI_COSIGN_PRIVATE_KEY=${{ secrets.RD_OCI_COSIGN_PRIVATE_KEY }}
            RD_OCI_COSIGN_PASSWORD=${{ secrets.RD_OCI_COSIGN_PASSWORD }}
            RD_OCI_COSIGN_PUBLIC_KEY=${{ secrets.RD_OCI_COSIGN_PUBLIC_KEY }}
```

The OIDC permission only allows GitHub to request an assertion; the pool
condition, service-account binding, and repository IAM role determine what it
can become and modify. `contents: write` is for the composed Rush Delivery
workflow's successful deploy-tag update, not GAR authentication; a raw
Package-only job can keep `contents: read`. The auth action is configured not to
create a credentials file or export ambient Google variables because Rush
Delivery needs only the explicit token output. The action's
[access-token contract](https://github.com/google-github-actions/auth#generating-oauth-20-access-tokens)
documents `token_format`, lifetime, and output behavior.

Google's
[Artifact Registry authentication guide](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication)
states that `oauth2accesstoken` tokens are valid for 60 minutes. The same guide
also supports `_json_key` with raw service-account JSON and
`_json_key_base64` with base64 JSON. Those are long-lived fallbacks: for Rush
Delivery's one-line env file, use a single-line/minified raw JSON value or the
base64 form, and protect it as a high-risk secret. Do not use a credential helper
as a substitute for the five provider values; Rush Delivery does not read the
host Docker configuration.

### GAR pull, retention, and cleanup

Grant each deployment platform the exact Artifact Registry read capability it
actually uses. For Cloud Run, the deployer needs Artifact Registry Reader and
the Cloud Run service agent must be able to read the image repository; the
service account selected with `--service-account` is the running application's
service identity, not its image-import credential. For GKE kubelet image pulls,
grant Artifact Registry Reader to the node service account or configure an
`imagePullSecret` with a separate reader credential; Workload Identity
Federation for GKE does not provide image-pull credentials. Package credentials
never reach either platform. See Google's
[Cloud Run deployment roles](https://docs.cloud.google.com/run/docs/deploying#required_roles)
and
[service identity model](https://docs.cloud.google.com/run/docs/securing/service-identity),
plus the
[GKE Artifact Registry integration](https://docs.cloud.google.com/artifact-registry/docs/integrate-gke)
and
[GKE image-pull troubleshooting contract](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/image-pulls).

Apply cleanup policies only after a dry-run review and keep every production or
rollback digest plus associated Cosign objects. Google documents rule order,
keep precedence, and asynchronous application in the
[cleanup policy overview](https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy-overview).
For a partial publication, list the subject, attachment tags, and every tagged
or untagged related package version, then use the provider's digest deletion
command under a cleanup identity. Verify the complete remaining inventory after
deletion instead of assuming a tag cleanup removed everything.

## Amazon Elastic Container Registry

**Test status:** syntax-reviewed against current AWS documentation; no
continuous live Rush Delivery test is claimed.

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/application-image-providers.schema.json
providers:
  ecr:
    kind: oci_registry
    registry: 111122223333.dkr.ecr.us-east-1.amazonaws.com
    repository_prefix: rush-delivery
    username_env: RD_OCI_ECR_USERNAME
    token_env: RD_OCI_ECR_TOKEN
    signing_key_env: RD_OCI_COSIGN_PRIVATE_KEY
    signing_password_env: RD_OCI_COSIGN_PASSWORD
    verification_key_env: RD_OCI_COSIGN_PUBLIC_KEY
```

For `artifact.image: control-plane-api`, create the exact ECR repository
`rush-delivery/control-plane-api`:

```sh
aws ecr create-repository \
  --region us-east-1 \
  --repository-name rush-delivery/control-plane-api
```

Repeat for every distinct image suffix. Do not expect Package to create an ECR
repository.

### IAM and short-lived authentication

Use GitHub OIDC or another federation path to assume a release-specific IAM
role instead of storing long-lived AWS access keys. AWS recommends limiting the
GitHub OIDC trust policy to the intended organization, repository, and protected
branch/environment in
[Create a role for OIDC federation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html).

For a job protected by the GitHub `production` environment, use the environment
subject form and the standard STS audience in the role trust policy. Replace the
account, organization, and repository placeholders; do not widen `sub` to an
organization or wildcard repository:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:acme/control-plane:environment:production"
        }
      }
    }
  ]
}
```

The corresponding job must request `id-token: write` and declare that exact
environment. This full action SHA is the reviewed
`aws-actions/configure-aws-credentials@v6.2.3` revision:

```yaml
jobs:
  package:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

      - name: Assume the ECR publisher role
        uses: aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c # v6.2.3
        with:
          role-to-assume: arn:aws:iam::111122223333:role/rush-delivery-publisher
          aws-region: us-east-1
```

AWS documents the `aud`/`sub` checks and the environment subject form in its
[GitHub OIDC condition-key guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html#condition-keys-wif)
and the action documents the required
[OIDC workflow permission](https://github.com/aws-actions/configure-aws-credentials#oidc).

The publisher needs `ecr:GetAuthorizationToken` plus repository-scoped upload
and verification-read actions. AWS's
[least-privilege push example](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-push-iam.html)
lists `BatchCheckLayerAvailability`, `BatchGetImage`,
`CompleteLayerUpload`, `InitiateLayerUpload`, `PutImage`, and
`UploadLayerPart`. Include `GetDownloadUrlForLayer` for verification reads.
Scope repository actions to every exact `rush-delivery/<image>` ARN. Put delete
actions in a separate cleanup role.

After assuming the role, generate the ECR password immediately before Package:

```sh
ecr_token="$(aws ecr get-login-password --region us-east-1)"

readonly ecr_env="$RUNNER_TEMP/rush-delivery-ecr.env"
umask 077
trap 'rm -f -- "$ecr_env"' EXIT
{
  printf 'RD_OCI_ECR_USERNAME=AWS\n'
  printf 'RD_OCI_ECR_TOKEN=%s\n' "$ecr_token"
  printf 'RD_OCI_COSIGN_PRIVATE_KEY=%s\n' "$RD_OCI_COSIGN_PRIVATE_KEY"
  printf 'RD_OCI_COSIGN_PASSWORD=%s\n' "$RD_OCI_COSIGN_PASSWORD"
  printf 'RD_OCI_COSIGN_PUBLIC_KEY=%s\n' "$RD_OCI_COSIGN_PUBLIC_KEY"
} >"$ecr_env"
unset ecr_token
```

Pass `$ecr_env` as `deploy-env-file` and delete it in an exit trap. AWS's
[ECR authentication guide](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html)
requires username `AWS`, says the token inherits the IAM principal's scope, and
documents a 12-hour lifetime. `docker login` in that guide explains the wire
credentials; Rush Delivery passes them directly and does not require the login
command.

### ECR pull, retention, and cleanup

Give the runtime role only ECR authorization and pull operations for the exact
repository. Keep it distinct from the publishing role.

Preview lifecycle policies before activation and ensure they retain the release
and rollback subjects plus the digest-derived `.sig` and `.att` image tags. AWS
documents that lifecycle actions are asynchronous in
[Creating a lifecycle policy](https://docs.aws.amazon.com/AmazonECR/latest/userguide/lp_creation.html).
ECR's lifecycle behavior for OCI reference artifacts does not describe this
`v0.9.0` storage mode; Rush Delivery does not publish those reference artifacts.
Treat the subject and both tag-addressed Cosign attachments as separately
retained OCI image content.

For partial publication, use a cleanup role to inventory the subject,
attachment tags, and untagged image history, delete only the reviewed targets in
the provider-required order, and verify the complete repository inventory
afterward. Rush Delivery does not automate deletion.

## Docker Hub

**Test status:** syntax-reviewed against current Docker and Dagger
documentation; no continuous live Rush Delivery test is claimed.

```yaml
# yaml-language-server: $schema=https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/application-image-providers.schema.json
providers:
  dockerhub:
    kind: oci_registry
    registry: docker.io
    repository_prefix: acme
    username_env: RD_OCI_DOCKERHUB_USERNAME
    token_env: RD_OCI_DOCKERHUB_TOKEN
    signing_key_env: RD_OCI_COSIGN_PRIVATE_KEY
    signing_password_env: RD_OCI_COSIGN_PASSWORD
    verification_key_env: RD_OCI_COSIGN_PUBLIC_KEY
```

For `artifact.image: control-plane-api`, the repository is
`docker.io/acme/control-plane-api`. Use a single-segment image suffix for this
recipe and create `acme/control-plane-api` before publishing. Docker documents
repository naming and visibility in
[Create a repository](https://docs.docker.com/docker-hub/repos/create/), while
Dagger's [container publishing recipe](https://docs.dagger.io/cookbook/containers/)
uses the `docker.io` registry authority.

### Publisher identity and CI mapping

For a personal access token (PAT), set `RD_OCI_DOCKERHUB_USERNAME` to the
personal Docker ID that owns the token. Give a dedicated release identity a
time-bounded Write PAT and only the account/team access needed to push the
chosen personal or organization repository. Docker PAT permissions are Read,
Write, or Delete; the PAT itself is not repository-scoped.

For an organization access token (OAT), set the username to the exact
organization name, not the user who created the token. On Docker Team or
Business, grant the OAT Image Push for only this repository. OATs offer
repository-level Image Pull/Image Push permissions but no image-delete
permission, and Docker documents that they are incompatible with Docker Desktop
and Image Access Management. Docker documents PAT creation and rotation in
[Personal access tokens](https://docs.docker.com/security/access-tokens/) and
repository-scoped organization tokens in
[Organization access tokens](https://docs.docker.com/enterprise/security/access-tokens/).

```yaml
- uses: BootstrapLaboratory/rush-delivery@v0.9.0
  with:
    application-image-provider: dockerhub
    docker-socket: ""
    dry-run: "false"
    deploy-env: |
      RD_OCI_DOCKERHUB_USERNAME=${{ vars.RD_OCI_DOCKERHUB_USERNAME }}
      RD_OCI_DOCKERHUB_TOKEN=${{ secrets.RD_OCI_DOCKERHUB_TOKEN }}
      RD_OCI_COSIGN_PRIVATE_KEY=${{ secrets.RD_OCI_COSIGN_PRIVATE_KEY }}
      RD_OCI_COSIGN_PASSWORD=${{ secrets.RD_OCI_COSIGN_PASSWORD }}
      RD_OCI_COSIGN_PUBLIC_KEY=${{ secrets.RD_OCI_COSIGN_PUBLIC_KEY }}
```

Image Push must cover the subject and Cosign objects. An OAT cannot be the
cleanup credential: use a separately controlled organization owner/admin path
in Docker Home or the Hub API, or a dedicated personal administrative identity
with a Delete PAT when the repository access model permits it. Keep that
identity outside the publishing job and exercise deletion in a disposable
repository before relying on it. Do not use an account password and do not run
`docker login` for Rush Delivery. Keep the Docker Hub username non-secret;
Dagger may display it in registry-auth progress.

### Docker Hub pull, retention, and cleanup

Public repositories can be pulled without a secret but remain subject to
Docker Hub usage/rate policy. Private deployment should use a separate Read or
Image Pull token configured in the target platform. Pair a PAT with its
personal Docker ID or an OAT with its organization name exactly as above.
Docker documents pull identity and rate attribution in
[Docker Hub pull usage and limits](https://docs.docker.com/docker-hub/usage/pulls/).

Retain the digest, deterministic tag, signatures, and attestations together.
Docker Hub supports OCI artifacts, but cleanup should be verified in the
repository's image/artifact view. Tag removal alone is not proof that an image
digest or every Cosign object was removed. Docker documents manual tag deletion
in [Tags on Docker Hub](https://docs.docker.com/docker-hub/repos/manage/hub-images/tags/)
and broader artifact support in
[Image management](https://docs.docker.com/docker-hub/repos/manage/hub-images/).

## Common Post-Provisioning Test

For every registry:

1. Run `validate-metadata-contract`.
2. Run provider-off OCI dry run; confirm no registry, digest, or evidence is
   emitted.
3. Run named-provider dry run without credentials; confirm the planned literal
   repository.
4. In a protected disposable namespace, run one live Package and export the
   returned directory.
5. Confirm the manifest reference is exactly `repository@digest`, all three
   evidence hashes match, and no credential sentinel appears in output.
6. Use real Cosign verification to prove the subject signature and both
   attestation predicates. For package-version inventory, require one subject
   plus at least two non-subject versions and allow additional untagged history;
   counts alone are not semantic proof.
7. Configure the deployment platform's separate pull identity and pull by the
   manifest digest.
8. Exercise cleanup on disposable content, including an intentionally partial
   subject/attachment package-version set.
9. Record the exact service/tier/region, policy, client versions, and date of the
   successful test. Re-run after registry, Cosign, permissions, or retention
   changes.

When a live attempt fails, follow
[OCI application-image troubleshooting](oci-application-image-troubleshooting.md)
before retrying.
