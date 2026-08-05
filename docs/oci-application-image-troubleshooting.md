# OCI Application-Image Troubleshooting

Use this runbook for Rush Delivery `v0.8.1` OCI Package and digest-only Deploy
failures. The central rule is simple: once registry mutation may have started,
do not automatically replay the whole workflow. Inspect the subject, navigation
tag, signatures, and attestations first.

For the underlying contract, read
[OCI application images](oci-application-images.md). Provider-specific
inspection and cleanup links are in
[Registry recipes](oci-registry-recipes.md).

## First Response

1. Stop automatic retries and preserve the first sanitized failure.
2. Record the entrypoint, dry/live mode, selected target names, provider name,
   full source SHA, registry authority/repository, and reported failure stage.
3. Decide whether the failure is before or after the registry mutation boundary
   using the matrix below. If uncertain, classify it as partial/unknown.
4. Never print or attach an env file, registry token, username sentinel, private
   key, public key, signing password, generated Docker config, Dagger secret, or
   an unreviewed debug/trace export.
5. If mutation is possible, inspect the unique repository namespace, attachment
   tags, and every tagged or untagged package version before a manual retry.
   Keep or remove objects according to the provider's release and cleanup
   policy.
6. If Deploy may have started, inspect the deployment platform separately. A
   retained registry digest does not prove whether a platform rollout occurred.

## Error Matrix

| Observed error or symptom                                                    | Likely stage                          | Safe first diagnostic                                                                                                                                                                                                                                                               | Side effect and action                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A named global provider appears to do nothing                                | Selection/activation                  | Confirm the selected CI plan contains no `oci_image` artifact.                                                                                                                                                                                                                      | Intended: no provider metadata or provider credential entry is resolved/used and no OCI side effect occurs. A supplied aggregate env file may still be parsed for other capabilities.            |
| `applicationImageProvider` is required for live OCI packaging                | Pre-Build activation                  | Confirm the selected target's package artifact is `oci_image` and the provider option is not `off`.                                                                                                                                                                                 | No application-image mutation. Select a valid provider and retry.                                                                                                                                |
| Provider file missing                                                        | Named-provider activation             | Confirm `.dagger/application-images/providers.yaml` exists in the source revision actually passed to Dagger.                                                                                                                                                                        | No mutation. Restore the file and retry. Filesystem-only selection does not need it.                                                                                                             |
| Unknown/invalid provider                                                     | Named-provider activation             | Compare the literal option with provider mapping keys; metadata does not interpolate variables.                                                                                                                                                                                     | No mutation. Correct the name/metadata and retry.                                                                                                                                                |
| Provider requires host env `NAME`                                            | Live credential resolution            | Check in the secret manager/job mapping that the named value exists and is non-empty. Do not print it.                                                                                                                                                                              | No mutation. Correct mapping and retry.                                                                                                                                                          |
| Credential projection validation failed                                      | Cross-file capability validation      | Read the provider, target, field, and environment **name** in the aggregate error.                                                                                                                                                                                                  | No mutation. Rename the project projection or use a dedicated provider name; retry.                                                                                                              |
| Framework-owned environment variable is rejected                             | Deploy metadata parser/runtime        | Search the named target field for `ARTIFACT_*`, `GIT_SHA`, or `DRY_RUN`.                                                                                                                                                                                                            | No new mutation. Rename the project-owned variable; never shadow framework identity.                                                                                                             |
| Cosign preflight toolchain is unavailable before key preflight               | Secret-free tool availability         | Check reachability of the pinned Cosign and BusyBox helper images, DNS, trusted TLS, and Dagger cache/registry status. Do not rotate or print keys.                                                                                                                                 | No destination mutation. Restore both tool images' availability and retry.                                                                                                                       |
| Cosign preflight failed for signing private key                              | Offline key preflight                 | Confirm the secret is the encrypted Cosign private-key file encoded with literal `\n`.                                                                                                                                                                                              | No destination mutation. Recreate/re-encode key and retry.                                                                                                                                       |
| Cosign preflight failed for signing password                                 | Offline key preflight                 | Check secret version and key/password rotation transaction without exposing either value.                                                                                                                                                                                           | No destination mutation. Correct the pair and retry.                                                                                                                                             |
| Cosign preflight failed for verification key                                 | Offline key preflight                 | Confirm the configured value is the public key from the selected key pair, literal-`\n` encoded.                                                                                                                                                                                    | No destination mutation. Correct and retry.                                                                                                                                                      |
| Cosign preflight failed for signing/verification key pair                    | Offline key preflight                 | Compare secret-manager version IDs/fingerprints from protected inventory, not PEM text.                                                                                                                                                                                             | No destination mutation. Activate a matching pair and retry.                                                                                                                                     |
| Docker image build failed                                                    | OCI preparation                       | Check context, Dockerfile containment, prior Rush build output, and the selected platform.                                                                                                                                                                                          | No selected OCI target was published. Fix and retry the batch.                                                                                                                                   |
| Syft generation or SPDX validation failed                                    | OCI preparation                       | Record Syft image/version and sanitized stage error; verify the exact built subject can be exported.                                                                                                                                                                                | No publication. Fix tool/network/subject issue and retry.                                                                                                                                        |
| Grype database download/cache/freshness failed                               | OCI preparation                       | Record Grype version, database build/status metadata, cache availability, and outbound reachability without dumping cache content.                                                                                                                                                  | No publication. Restore governed database availability/freshness and retry.                                                                                                                      |
| Grype produced invalid scanner output                                        | OCI preparation                       | Check whether `matches` is an array and whether each evaluated item has a non-empty ID and supported severity.                                                                                                                                                                      | No publication. Treat as tool/output failure, not “zero findings.”                                                                                                                               |
| Vulnerability policy rejected findings                                       | OCI preparation                       | Review IDs/severities in the sanitized error and full report under security access controls.                                                                                                                                                                                        | No publication. Remediate or add a governed narrow Grype rule, then retry.                                                                                                                       |
| Registry readiness/transport failure before Package mutation                 | Harness/infrastructure                | Probe trusted `https://<authority>/v2/` with bounded timeouts; `200`, `401`, or `403` proves service reachability, not write auth.                                                                                                                                                  | Safe to retry only the bounded probe/read. Do not turn it into an automatic Package retry.                                                                                                       |
| `failed during registry publication authentication`                          | Publication                           | Check token lifetime, username form, credential type, and clock using the provider control plane.                                                                                                                                                                                   | The fixed stage describes the registry response, not proof of zero side effects. Inspect the target repository before retry unless provider audit evidence proves rejection before every upload. |
| `failed during registry publication authorization`                           | Publication                           | Check repository existence plus subject and digest-derived Cosign attachment push/read scopes for the resolved identity.                                                                                                                                                            | Blob or manifest work may already have started. Inspect the target repository and all package versions before retry.                                                                             |
| `failed during registry publication transport`                               | Publication                           | Check bounded DNS, trusted-TLS, connection, timeout, and provider-status evidence without replaying Package.                                                                                                                                                                        | Outcome is unknown/partial because the publication boundary was crossed. Inspect the target repository before retry.                                                                             |
| Generic `failed during registry publication`                                 | Publication                           | Use provider audit events and a complete tagged/untagged package-version inventory; do not infer a credential or network cause from the generic stage.                                                                                                                              | Outcome is unknown/partial. Inspect and clean or quarantine the disposable namespace before a controlled retry.                                                                                  |
| Repository not found/permission denied                                       | Publication                           | Confirm every literal repository path exists and the identity has subject plus Cosign-object push/read permission.                                                                                                                                                                  | Usually pre-manifest, but blob uploads may have started. Inspect the repository before retry.                                                                                                    |
| TLS, unknown authority, or insecure registry error                           | Tool pull/publication/Cosign          | Confirm the endpoint presents a publicly trusted chain from the Dagger/Cosign execution environment.                                                                                                                                                                                | No supported custom-CA or insecure bypass exists. Move to trusted TLS; inspect if upload may have begun.                                                                                         |
| Returned publication reference is malformed/unexpected                       | Post-publish reference validation     | Record expected repository, SHA tag, and sanitized returned authority/name/digest shape.                                                                                                                                                                                            | Publication occurred or may have occurred. Inspect digest/tag; do not sign or deploy it manually as a workaround.                                                                                |
| Cosign sign/attest/verify failed                                             | Ordered finalization                  | Use the canonical subject reference in the sanitized error to inventory attachment tags, all tagged/untagged package versions, and key inventory.                                                                                                                                   | Subject and some Cosign objects may exist. No successful manifest or Deploy; clean/quarantine before retry.                                                                                      |
| Evidence finalization failed after Cosign verification                       | Ordered finalization                  | Record the canonical subject, target, evidence kind/path, and sanitized Dagger stage without attaching unreviewed evidence contents.                                                                                                                                                | Subject, signature, and both attestations may all exist, but no successful manifest or Deploy exists. Inspect and clean/quarantine before retry.                                                 |
| Earlier published target / later target was not started                      | Multi-target finalization             | Follow each canonical earlier/failed reference in stable error order.                                                                                                                                                                                                               | Earlier siblings are external side effects; later listed targets were not started. Inspect each repository independently.                                                                        |
| Transport interruption during/after publication                              | Publication/finalization              | Check provider audit logs, SHA tag, subject digest, attachment tags, and all package versions.                                                                                                                                                                                      | Outcome is unknown/partial. Never assume the first attempt did nothing and never auto-replay the batch.                                                                                          |
| Live Deploy requires a published OCI artifact                                | Deploy preflight                      | Inspect manifest `status`; a provider-off or named dry-run manifest is `planned`.                                                                                                                                                                                                   | No Deploy target starts. Produce a new live Package bundle; do not edit status.                                                                                                                  |
| Frozen credential capability missing or invalid during standalone OCI Deploy | Deploy credential-boundary activation | A `v0.8.1` bundle must contain a valid `.dagger/runtime/application-image-credential-capability.json`; only an older bundle without that file uses `.dagger/application-images/providers.yaml` as a legacy names-only fallback. A present malformed capability always fails closed. | No Deploy target starts and no provider credential value is read. Restore the intact trusted bundle; do not delete the capability or `repository` field to force a weaker path.                  |
| Provider credential projection rejected during standalone Deploy             | Deploy credential-boundary activation | Inspect the named Deploy target/field and the named credential declaration. The check includes every declared provider, not only the provider that originally published the artifact.                                                                                               | No Deploy target starts and no registry operation occurs. Rename and separately scope the project-owned capability; rebuild the trusted bundle after a metadata change.                          |
| OCI source revision does not match deploy `gitSha`                           | Deploy preflight                      | Compare manifest SHA with protected release metadata outside the bundle.                                                                                                                                                                                                            | No Deploy target starts. Restore the correct bundle/SHA pair; do not override or truncate SHA.                                                                                                   |
| Reference must equal repository@digest                                       | Manifest parser/preflight             | Validate the manifest came intact from Package and was not rewritten by CI templating.                                                                                                                                                                                              | No Deploy target starts. Restore the original bundle; do not repair fields by hand.                                                                                                              |
| Evidence file missing/unreadable or hash mismatch                            | Deploy evidence preflight             | Confirm the whole packaged directory was restored atomically and compare its external archive checksum.                                                                                                                                                                             | No live wave starts. Restore the trusted archive; do not copy one evidence file from another run.                                                                                                |
| `.dagger`, `.dagger/runtime`, or `.dagger/runtime/evidence` is a symlink     | Common Deploy bundle preflight        | Inspect those exact paths without dereferencing them and compare the complete archive with its protected identity/checksum.                                                                                                                                                         | No dry or live target starts. Do not patch/repack the bundle; rerun the `v0.8.1` Package producer, export its complete result, and register a new archive and protected release record.          |
| Deploy script cannot see another target's evidence                           | Workspace assembly                    | Confirm it is not depending on `.dagger/runtime/evidence/<other-target>`.                                                                                                                                                                                                           | Intended isolation. Consume only current `ARTIFACT_EVIDENCE_DIR`.                                                                                                                                |
| Deployment platform cannot pull the digest                                   | Project Deploy/platform               | Confirm platform pull identity, network, repository read scope, and retained digest.                                                                                                                                                                                                | Package already succeeded; a platform rollout may have failed. Fix pull identity and retry Deploy with the same digest.                                                                          |
| Docker socket missing                                                        | Project Deploy compatibility          | Determine whether the project deploy script invokes Docker; first-class OCI Package does not.                                                                                                                                                                                       | For OCI-only jobs keep the socket disabled. Enable it only for a trusted legacy deploy script that requires host-level daemon authority; never expose it to untrusted checkout code.             |
| Retained bundle is valid but registry digest is unavailable                  | Rollback/platform pull                | Check registry retention/audit records and exact digest, not the SHA tag.                                                                                                                                                                                                           | The bundle cannot recreate a deleted subject. Recover from an independently retained registry copy or choose another trusted release.                                                            |

## Selection And Provider Problems

### No OCI selected with a named global input

This is not an error in `v0.8.1`. Selection determines activation. A
directory-only, archive-only, empty, or npm-only execution ignores the unused
application provider, provider file, and credentials. This permits an existing
filesystem project to upgrade without adding `.dagger` OCI configuration.

If OCI was expected, inspect the CI plan and selected package metadata. Do not
“fix” the behavior by making provider parsing unconditional.

### Provider `off` in live OCI

`off` is valid for OCI dry-run planning and is the default. It is invalid when a
selected OCI artifact is live. Select a provider only after the target and
provider metadata exist. The failure occurs before Rush Build and destination
registry activity; Source acquisition may already have used its own configured
network/credentials.

### Missing or unknown provider

Check all three literal values:

- selected option, for example `--application-image-provider=ghcr`;
- mapping key under `providers:`; and
- provider metadata path exactly
  `.dagger/application-images/providers.yaml`.

The provider option does not select by `kind`, registry name, environment, or
CI variable. `repository_prefix` and `registry` also do not interpolate shell
syntax. Run a named-provider dry run after correction; it validates the planned
repository without requiring or resolving provider credentials. Do not supply
the live OCI env file to that diagnostic.

### Repository validation differs from execution

Invocation-scoped execution skips provider parsing until a selected OCI plan is
known. `validate-metadata-contract` intentionally validates every provider file
that is present and every cross-file credential projection. Therefore a
filesystem execution can succeed while repository lint correctly reports an
invalid unused provider file. Fix repository-lint failures rather than treating
the execution path as equivalent validation.

Standalone Deploy has a narrower, manifest-driven exception. After its initial
manifest/source preflight succeeds, a selected published OCI artifact, or a
selected planned OCI artifact with `repository` in a dry run, causes Deploy to
use the names-only credential capability frozen by Package and reject any
selected Deploy runtime projection of credentials declared by any provider
before a composed Build. An older bundle without that internal handoff falls
back to provider metadata. Deploy never resolves those credential values and
performs no registry or Cosign operation. Filesystem artifacts and provider-off
planned OCI artifacts do not activate this boundary. If a mixed selection
activates it, every selected Deploy target is checked.

## Credential And Key Problems

### Missing name versus missing value

Provider YAML contains five environment **names**. A live Package then requires
five non-empty values for the selected provider. A named dry run with no
aggregate env file reads none of them. If a shared env file is supplied for
another capability, its bytes are parsed as a whole, but provider credential
entries are not looked up, used, or converted into Dagger secrets. Confirm
mappings through the CI/secret-manager UI or presence-only checks;
do not run `env`, `set`, `printenv`, `cat <env-file>`, shell tracing, or a command
that expands the secret into its arguments.

All providers in an active provider file contribute protected names, while only
the selected provider's values are read. If switching selected providers makes
a collision appear/disappear, the metadata is not following the contract.

### Actual newlines versus literal `\n`

Rush Delivery's public env file is one logical `NAME=value` per line. PEM values
must contain literal backslash-plus-`n` separators. An actual newline splits the
record and can produce a missing-name error, invalid env-line error, or malformed
key.

Malformed-record diagnostics identify the physical line number and redact its
contents. If a diagnostic from another wrapper contains the raw PEM body or
value, treat that wrapper output as sensitive, stop sharing it, and fix its
redaction before continuing.

Regenerate the flat value from the protected key file using the tested procedure
in [Registry and Cosign bootstrap](tutorial/oci-application-images/03-registry-and-cosign-bootstrap.md),
perform its in-memory round-trip check, then update the secret manager. Do not
diagnose this by printing the encoded or decoded key. Raw multiline PEM is an
internal normalization capability, not a supported multiline env-file record.

### PEM markers are not cryptographic proof

The encrypted private key should have the Cosign encrypted-private-key markers,
and the public key should have public-key markers. Marker checks only provide a
format diagnostic. The live preflight is authoritative because it decrypts the
key, derives its public identity, signs a challenge, and verifies the challenge
with both derived and configured keys.

For wrong-password or mismatch errors, compare secret-manager version IDs and a
separately governed fingerprint inventory. Rotate the private key, password, and
active public key as one controlled transaction. Do not put OCI signing
material in `runtime-file-map`: that bundle is for deployment-platform files and
is visible to project Deploy code.

### Protected-name collision

The aggregate error names every provider/credential/target/field collision.
Rename either the provider capability or the project-owned variable. The check
covers:

- package Build pass-through names, both sides of mappings, and dry defaults;
- Deploy pass-through names, both sides of mappings, static env, dry defaults,
  required host names, and host-path mount source variables; and
- npm `auth.token_env` in a composed workflow with active OCI.

Do not alias the same secret under a new project-visible name. Name-based
validation cannot detect value identity; use separate least-privilege
credentials.

## Registry And Network Problems

### Readiness is not authorization

A `GET https://<registry>/v2/` response of `200`, `401`, or `403` shows that a
trusted-TLS registry service responded. It does not prove repository existence,
push scope, returned-reference behavior, or Cosign compatibility. Retry this
side-effect-free probe only with bounded attempts and timeouts.

Classify DNS failure, connection reset/refusal, timeout, TLS handshake timeout,
and unexpected EOF before mutation as registry transport. Once publish may have
started, the same symptoms mean `registry-transport-ambiguous`.

### Authentication and repository authorization

Rush Delivery emits four fixed, secret-safe publication stages. They are
operational classifications, not verbatim registry errors:

- `registry publication authentication` identifies a credential-identity or
  credential-validity denial, such as an explicit `401 Unauthorized`;
- `registry publication authorization` identifies a repository/scope denial,
  such as an explicit `403 Forbidden` or `insufficient_scope`;
- `registry publication transport` identifies DNS, connection, trusted-TLS, or
  bounded-request availability failure; and
- `registry publication` is the fail-closed fallback for every unrecognized
  registry error.

Rush Delivery discards the original registry exception because clients can put
tokens, signed URLs, or other protected values in it. Do not weaken this
boundary by enabling trace output or wrapping the publisher to print the raw
exception. The fixed stage also cannot prove that a failed target is empty: the
ordered publication boundary is crossed before each registry result is known,
and a registry can accept blobs before rejecting a later request. Treat all
four stages as possibly mutating unless independent provider audit and complete
repository/package-version inventory prove otherwise.

Use the provider-specific username/token form and check expiry:

- GHCR: job `GITHUB_TOKEN` with `packages: write`, or a dedicated classic PAT;
- GAR: username `oauth2accesstoken` with a freshly minted short-lived token,
  or a deliberately accepted service-account-key fallback;
- ECR: username `AWS` with `get-login-password` output from the correct region;
- Docker Hub: Docker ID/organization name with a dedicated PAT/OAT.

The publisher needs write plus verification read for the subject and Cosign
objects. The deployment platform needs a separate pull identity. See
[Registry recipes](oci-registry-recipes.md) for current official links.

An authentication denial independently proven to occur before every upload can
be retried after credentials are fixed. A fixed Rush Delivery authentication or
authorization stage alone is not that proof. Inspect the registry first when an
upload/manifest request may have begun or inventory completeness is uncertain.

### Trusted TLS and custom CA

`v0.8.1` exposes no custom-CA, self-signed-certificate, plain-HTTP, or
insecure-registry option for application-image providers. Do not add a CLI flag
to bypass TLS verification around Rush Delivery. Use a registry endpoint whose
certificate chain is trusted by both the Dagger engine and pinned Cosign image,
or re-plan custom trust as a separate public contract.

### Malformed returned reference

Rush Delivery asks Dagger to publish
`<repository>:sha-<full-git-sha>` and accepts only a returned digest for the
expected repository/tag. It canonicalizes Deploy identity to
`<repository>@sha256:<64 lowercase hex>`.

A malformed or rewritten return happens after the publish call. Record the
expected repository and SHA tag, inspect provider audit logs and digest listings,
and treat the namespace as mutated. Do not manually manufacture a manifest or
continue signing a different reference.

### Cosign legacy-attachment incompatibility

The live path must create one subject signature and two attestations, then read
and verify all three. Rush Delivery pins `--new-bundle-format=false` on all six
registry Cosign commands. With Cosign `3.1.2`, that means a digest-derived
`.sig` attachment and a shared `.att` attachment containing both predicates;
the OCI 1.1 Referrers API is not used. A registry can accept the image and still
reject an attachment manifest, tag update, or read. Preserve the canonical
subject, exact fixed Cosign stage, provider service/tier/region, and sanitized
registry error. Compare the exact endpoint with the provider and
[Cosign registry support](https://github.com/sigstore/cosign#registry-support)
documentation.

One subject plus at least two non-subject package versions is the inventory
lower bound after success. Extra untagged history may remain when the second
attestation replaces the `.att` tag. Counts never prove semantic completeness:
the successful Package must independently verify the signature, SPDX
attestation, and provenance attestation.

If Package reports a sign, attestation, or verification failure, no successful
manifest is written and Deploy does not start, but registry objects may remain.
Quarantine or clean them before a controlled retry.

## Scanner Problems

### Database download, cache, and freshness

The Grype container is digest-pinned, while the vulnerability database is a
mutable cached/network input. Check:

- outbound access to the configured database service;
- cache availability and permissions for the Dagger cache volume;
- database build time and age status;
- timeout/rate-limit/proxy diagnostics; and
- whether a previous valid cache exists for the pinned Grype version.

Anchore documents automatic updates and stale-database failure in
[Vulnerability Database](https://oss.anchore.com/docs/guides/vulnerability/database/).
Do not disable age validation or update checks as an incident shortcut without
an approved security decision. A later run can find different vulnerabilities
because upstream feeds changed; record database identity/time with release
evidence when reproducibility matters.

### Policy rejection

`fail_on` is exact-set matching. If policy is `[high]`, a Critical finding alone
does not cause the policy rejection. List both `high` and `critical` for the
usual production policy.

Review the complete scan evidence only in an access-controlled location. If an
exception is justified, edit the repository-owned Grype config with supported
fields, a narrow vulnerability/package scope, owner, reason, review/expiry date,
and removal follow-up. Anchore documents supported rules and JSON suppression
behavior in [Filter scan results](https://oss.anchore.com/docs/guides/vulnerability/filter-results/).
Do not create an undocumented Rush Delivery-specific ignore list.

### Changed findings between runs

Compare source SHA, Docker build input, pinned Grype image, database build/status,
and ignore config. The executable pin does not pin the vulnerability database.
A changed finding is not evidence of application-image registry mutation;
scanning is in preparation, before the publication barrier.

## Partial Publication And Multi-Target Recovery

Preparation is all-or-nothing with respect to application-image publication:
every selected filesystem artifact and every OCI Docker build/SBOM/scan must
succeed first. Finalization is intentionally sequential and nontransactional.

On a finalization error, parse the sanitized report into three sets:

- **Earlier published:** each named target/reference completed finalization.
  Preserve or clean it deliberately.
- **Failed target:** if a canonical digest reference is shown, publication
  succeeded and signing/evidence work failed later. If no reference is shown,
  publication still may have started.
- **Later not started:** no finalization was invoked for these targets.

For every earlier/failed repository:

1. Query the provider control plane/audit log for the deterministic
   `sha-<full-git-sha>` tag and recent manifests.
2. Record each canonical subject digest found.
3. Discover the digest-derived signature/attestation tags and every tagged or
   untagged related package version for each subject.
4. Compare inventory with the failed Cosign stage; do not infer completeness
   only from object count.
5. Decide to retain/quarantine or delete under provider policy. Use a separate
   cleanup identity and the provider links in
   [Registry recipes](oci-registry-recipes.md).
6. Verify the result of cleanup. Only then authorize a manual rerun of the full
   Package flow.

There is no successful package manifest for the failed attempt. Never synthesize
one from registry state, because Package did not complete its verification and
evidence contract.

## Manifest, Bundle, And Evidence Problems

### Planned manifest used live

A dry run produces `status: planned`; provider `off` omits the repository and a
named provider may include it. Neither is deployable live. Produce a new live
Package bundle. Changing `planned` to `published` cannot create a digest,
evidence, signature, or attestation and is always invalid.

### Source mismatch

Deploy compares every selected OCI artifact's `source_revision` with the full
lowercase `gitSha` supplied by the caller. In a split stage, obtain the expected
SHA from protected release metadata outside the unsigned bundle. A mismatch
usually means the wrong bundle was restored, the wrong release record was
selected, or a truncated/mutable ref was supplied. Restore the correct pair; do
not edit either value.

### Repository/reference/digest disagreement

A published reference must be exactly `repository@digest`, with a lowercase
`sha256` digest. Mutable tags are rejected. A disagreement indicates a damaged,
rewritten, or adversarial manifest. Verify the external archive checksum and
restore the whole known-good bundle atomically.

### Missing or changed evidence

The manifest paths must stay below
`.dagger/runtime/evidence/<current-target>/`, and the provenance, SPDX, and scan
bytes must match their recorded SHA-256 values. Evidence validation for every
selected published target runs before the first live Deploy wave.

Do not patch the individual file or digest. Verify the archive checksum from
protected metadata, reject archive member/link escapes, and atomically restore
the complete bundle into a new directory. If the external checksum also differs,
obtain the correct immutable CI artifact.

### Unsigned bundle limitation

Local hashing detects accidental or isolated modification. It does not detect an
attacker who can replace the unsigned manifest and evidence together with a
schema-valid coordinated bundle. The operator must protect producer and consumer
jobs, store the bundle immutably/access-controlled, record its checksum or
artifact identity externally, and supply an independent full Git SHA. Signed
portable manifests and Deploy-time Cosign verification are not `v0.8.1`
features.

### Wrong bundle or unavailable digest during rollback

Verify the older archive against that release's external checksum **before**
extraction, then compare its manifest SHA to the independently stored release
SHA. Use its digest unchanged. If the registry no longer retains the subject or
the platform can no longer pull it, the local bundle cannot recreate it. Choose
another retained trusted release or restore the registry object from a separately
governed registry backup.

## Deploy And Docker-Socket Problems

OCI Package uses Dagger-native Dockerfile build and registry APIs. It does not
need `/var/run/docker.sock`, a host Docker/Podman CLI, or a daemon supplied to
the module. The Dagger CLI may itself use a configured container runtime to run
the Dagger engine; that infrastructure relationship is separate from forwarding
a socket to project Deploy code.

The GitHub Action retains a non-empty Docker-socket default only for existing
project-owned deploy scripts that execute Docker. For OCI-only jobs set:

```yaml
with:
  docker-socket: ""
```

If a legacy script genuinely requires Docker, keep the compatibility input only
in the trusted job that runs that script and treat socket access as privileged.
Never enable it to fix registry publication or Cosign failures.

Deployment-platform pull authorization is also separate. Configure the Cloud
Run, Kubernetes, Swarm, or other platform identity to read the exact repository
and digest. Do not pass the Package token into Deploy or mount OCI Cosign keys
through `runtimeFiles`.

## Retry Decision

Safe to retry after correcting the cause, because Rush Delivery guarantees the
destination registry was not mutated:

- provider metadata/selection and ownership validation;
- missing provider credential value;
- Cosign key preflight;
- selected filesystem validation/materialization;
- Docker build;
- SPDX generation/validation; and
- Grype execution, report validation, or policy.

Safe to retry automatically only as a bounded individual operation:

- pre-mutation trusted-TLS readiness/capability probe; and
- immutable registry read whose response cannot alter release state.

Require inspection and a human/policy decision before retry:

- publish request or returned-reference validation;
- provenance/sign/attest/verify or local-evidence finalization;
- any transport failure after mutation may have begun;
- multi-target failure with earlier published siblings; and
- Deploy execution failure.

Do not treat an infrastructure label as proof of non-mutation. Preserve the
original sanitized failure class when retries are exhausted.

## Sanitized Diagnostic Bundle

Collect only what is necessary:

- Rush Delivery version/tag and exact Dagger CLI/engine version;
- entrypoint, dry/live mode, event type, selected target names, and provider
  name;
- full source SHA and non-secret source repository URL;
- registry authority and expected repository path;
- canonical digest references already present in sanitized framework errors;
- failure stage and whether publication may have started;
- the package manifest only after checking that it contains no sentinel or
  unexpected field;
- SHA-256 values and paths for local evidence, not key material;
- pinned Syft/Grype/Cosign versions and image digests;
- Grype database build/status metadata and network failure class;
- provider audit/event identifiers and a complete subject/associated-package-
  version inventory; and
- reviewed logs with values redacted at collection time.

Never include:

- workflow/deploy/release env files or their raw lines;
- registry username/token values or bearer/basic-auth headers;
- private key, public key, signing password, or fingerprints derived by dumping
  key files into logs;
- Docker `config.json`, base64 auth, Dagger Secret objects, or secret-bearing
  command arguments;
- image filesystem/history dumps until they have passed a credential-sentinel
  review; or
- verbose Dagger/provider traces that have not been proven secret-safe.

When reporting a credential problem, provide only the provider name, credential
role, secret-manager version identifier, and failure stage. When reporting a
partial publication, provide canonical subject references and cleanup status,
never credentials.

The source repository URL itself must be a public coordinate: do not put tokens
in userinfo, query strings, or fragments. Rush Delivery rejects those channels
without echoing the submitted locator; use the explicit Source authentication
input instead.
