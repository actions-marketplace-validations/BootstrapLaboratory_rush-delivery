# Harden OCI Application Images And Complete Production Guides

Status: accepted for implementation.

Baseline: `BootstrapLaboratory/rush-delivery` commit
`d98d666e17845a5d7089571fe7c8b256484e6a25`, released as `v0.8.0`.

Target release: `v0.8.1`.

This is a corrective security, compatibility, implementation, documentation,
schema, example, and release task. It completes the production contract of the
OCI application-image feature introduced in `v0.8.0`; it does not add another
artifact kind, provider kind, Dagger entrypoint, or package-manifest version.

## Context

Rush Delivery can now build a selected deploy target as an OCI image during
Package, generate SBOM and vulnerability evidence, publish the image, sign and
attest the returned digest with Cosign, and hand the immutable reference to a
project-owned Deploy script.

The first release established the main data model and stage boundary, but an
implementation and documentation audit found gaps that must be corrected before
the feature should be presented as production-ready:

- a globally supplied named application-image provider is still resolved for a
  filesystem-only selected plan, even though no OCI work exists;
- provider credentials come from an environment overlay that can also feed Rush
  Build and Deploy metadata, so the current Package-only credential statement is
  stronger than the enforced boundary;
- project deploy metadata can currently overwrite framework-generated
  `ARTIFACT_*`, `GIT_SHA`, and `DRY_RUN` values;
- PEM marker checks do not prove that an encrypted private key is usable or that
  it matches the configured public key before publication starts;
- multiple OCI targets can publish partially, and the current aggregate failure
  does not describe all known external side effects;
- a full deploy workspace can expose evidence for targets other than the target
  being executed;
- the current docs do not precisely explain offline Cosign verification,
  exact-set vulnerability policy, mutable scanner database inputs, unsigned
  split-stage manifests, or nontransactional registry behavior;
- generic upgrade examples opt into a named OCI provider too early;
- there is no complete, tested path from an ordinary Rush project through dry
  run, key bootstrap, publication, evidence inspection, digest-only deployment,
  CI, split-stage handoff, rollback, and cleanup;
- production registry recipes, operator procedures, result examples, failure
  diagnosis, key rotation, retention, and limitations are incomplete.

## Goal

Deliver a `v0.8.1` release in which:

1. filesystem-only projects that do not rely on accidental framework-env
   shadowing, framework-evidence mount collisions, or authentication embedded in
   repository locators upgrade without adding application-image metadata,
   credentials, or Action inputs; those narrow security migrations are
   documented separately;
2. selected application-image credential names cannot be projected into
   project-controlled Build, npm Release, or Deploy execution;
3. deploy metadata cannot shadow framework-owned artifact and control values;
4. preventable signing-key and multi-target preparation failures happen before
   application-image registry mutation;
5. remaining registry side effects and trust boundaries are deterministic,
   sanitized, and accurately reported;
6. code, schemas, examples, tests, tutorials, production guidance, and release
   notes describe the same enforceable contract; and
7. a new operator can execute a complete production workflow without inventing
   missing files, commands, security assumptions, or recovery steps.

## Release And Compatibility Decision

- [x] Ship this work as patch release `v0.8.1` because it enforces already
      documented invariants and fixes opt-in behavior without adding a public
      metadata shape, provider kind, entrypoint, or manifest version.
- [x] Keep the package-manifest contract at
      `rush-delivery-package-manifest/v2`.
- [x] Keep the `v0.8.0` OCI artifact/provider field shapes valid except for
      newly rejected unsafe cross-file environment-name collisions, provider
      credential-name aliases, OCI target names that cannot be one evidence
      directory segment, and noncanonical v2 manifest paths/formats; document
      those narrow migrations explicitly.
- [x] Keep directory/archive-only manifests byte- and shape-compatible with the
      current unversioned output.
- [x] Keep directory/archive deploy-result fields and behavior unchanged.
- [x] Keep `applicationImageProvider`/`application-image-provider` defaulting to
      `off`.
- [x] Keep the GitHub Action's `/var/run/docker.sock` default for existing
      project-owned deploy scripts; document it as a compatibility default and
      explicitly disable it in OCI-only examples.
- [x] Treat metadata that writes framework-owned environment names or projects
      application-provider credentials into project code as invalid. Document
      the required rename; accidental shadowing and credential projection are
      not compatibility guarantees.
- [x] Also reject repository locators that embed authentication/query/fragment
      data and file-mount destinations that can replace framework evidence.
      Document explicit auth inputs and safe retargeting as narrow security
      migrations; preserve every non-colliding legacy file-mount target spelling.
- [x] Create a complete immutable [`../schemas/v0.8.1`](../schemas/v0.8.1)
      snapshot because deploy-schema validation and exact release alignment
      change, even though the OCI metadata shapes remain the same.
- [x] If implementation requires a new Dagger input, metadata field, provider
      kind, signed-bundle contract, or manifest version, stop this patch and
      re-plan that addition for a minor release instead of silently expanding
      `v0.8.1`.
- [x] Treat clean-clone self-check repair and live-acceptance registry
      reliability as internal release-infrastructure prerequisites for this
      patch. They must not add a Dagger entrypoint/input, GitHub Action input,
      `.dagger` metadata field, schema shape, or application runtime behavior.
- [x] Keep registry coordinates in `v0.8.1` static as defined by the existing
      provider metadata. A configurable acceptance endpoint is private to the
      repository test harness and is not an environment-selected provider
      feature for consumers.

### Dagger Cache And Secret-Persistence Contract

- [x] Give every public Dagger function an explicit cache policy. Pure
      session-stable inspection functions may use session caching; functions
      that observe mutable external state, execute project code, or can create
      side effects must use `cache: "never"`.
- [x] Do not overstate `cache: "never"`: it disables Dagger function-result
      caching, not ordinary container layer caching. Add a fresh, random,
      non-secret execution input to Cosign preflight/publication, Grype scans,
      project Deploy scripts, and npm release so identical invocations rerun
      those security-sensitive or externally mutating commands. Keep
      deterministic image-build and other safe layer caching intact.
- [x] Never persist a secret or a derived authorization value into a Dagger
      filesystem layer. In particular, Git release push auth must use a static
      askpass helper that reads the token from a Dagger secret environment at
      process time; it must not write a Basic header or token to `.git/config`.
      Keep Cosign preflight's key-derived files on an ephemeral mount rather
      than in a cached layer.
- [x] Document and test these semantics against Dagger's official
      [function-caching](https://docs.dagger.io/extending/function-caching/) and
      [secret-handling](https://docs.dagger.io/extending/secrets/) guidance.

## Non-Negotiable Architecture

### Conditional Provider Activation

- [x] Determine selected package artifact kinds before doing any
      application-image provider work.
- [x] When zero selected plans are `oci_image`, do not parse the provider input,
      load `.dagger/application-images/providers.yaml`, select a provider,
      resolve credentials, create Dagger secrets, require an OCI Git SHA, or run
      signing preflight.
- [x] Treat a named or malformed application-image provider input as irrelevant
      when the selected plan contains no OCI artifact. No-OCI behavior is
      determined by selected artifacts, not by a globally supplied unused
      option.
- [x] Preserve the OCI provider truth table:

| Selected artifacts | Provider  | Dry run | Required behavior                                                                                                                                             |
| ------------------ | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no OCI             | any value | either  | Ignore the unused option; do not load provider metadata or credentials.                                                                                       |
| OCI                | `off`     | `true`  | Emit relative planned image intent without provider metadata or credentials.                                                                                  |
| OCI                | named     | `true`  | Load and validate the selected provider definition; do not resolve or use provider credential entries, create provider Dagger secrets, or run external tools. |
| OCI                | `off`     | `false` | Fail before Rush Build, OCI build, registry access, or Deploy.                                                                                                |
| OCI                | named     | `false` | Validate metadata early; resolve credentials only at the start of live Package.                                                                               |

### Credential Capability Boundary

- [x] Introduce one canonical application-provider credential-name model for
      `username_env`, `token_env`, `signing_key_env`,
      `signing_password_env`, and `verification_key_env`.
- [x] When application-image provider metadata is active, treat credential
      names from every declared provider as protected. Switching the selected
      provider must not make unsafe Build or Deploy metadata become safe.
- [x] Read values only for the selected live provider, and only when Package is
      ready to run its offline key preflight and OCI operations.
- [x] Convert the selected token, private key, password, public key, and generated
      Docker authentication config to Dagger secrets immediately. The registry
      username remains the non-secret string required by Dagger's registry-auth
      API and may appear in Dagger's client progress/call graph; require it to be
      non-secret and document that limitation. It stays framework-owned and is
      never projected into project code or returned in result models. Do not
      place sensitive plaintext values in a Dagger directory, ordinary container
      environment, command arguments, generated files, or returned models.
- [x] Require all five credential environment names to be globally unique
      across all declared providers and reject aliases before reading values.
      In particular, no secret role may reuse a `username_env` name and reach
      Dagger's intentionally non-secret registry-username channel. Keep
      diagnostics deterministic and names-only, and document this narrow
      security migration.
- [x] Define env-file wording precisely: public entrypoints may parse a supplied
      aggregate env file for other capabilities. In dry/no-OCI paths the
      application-provider subsystem must not index, resolve, use, log, or turn
      provider-named entries into Dagger secrets. Recommend omitting provider
      values entirely from invocations that do not need live OCI Package.
- [x] Keep provider credentials out of project-controlled execution by rejecting
      protected names in all of these surfaces:
  - package `build.pass_env`;
  - package `build.map_env` source names and output names;
  - package `build.dry_run_defaults` names;
  - deploy `runtime.pass_env`;
  - deploy `runtime.map_env` source names and output names;
  - deploy `runtime.env` names;
  - deploy `runtime.dry_run_defaults` names;
  - deploy `runtime.required_host_env` names;
  - deploy host-path `runtime.file_mounts[].source_var` names;
  - npm release `auth.token_env` when the composed workflow also activates an
    application-image provider.

- [x] Validate the boundary before Rush Build or another project-controlled
      container can consume the value. Errors name provider, target, metadata
      field, and environment variable, but never a value.
- [x] Maintain separate control-plane and project-projection views. Framework-
      owned source auth, toolchain/cache adapters, deploy-tag updates, and
      release Git auth retain the raw map needed by their explicit inputs; only
      maps projected into project Build, npm publish/lifecycle, and Deploy
      processes are filtered after validation.
- [x] Keep raw provider input available only to framework-owned coordinator code
      long enough to resolve the selected Package secrets. Do not place it in
      the built or packaged repository returned to another stage.
- [x] Treat the repository locator copied into OCI labels and provenance as a
      public coordinate, never an authentication channel. Accept only supported
      absolute Git/HTTP(S)/SSH URLs or narrowly validated `git@host:path`
      locators; reject password/userinfo (except the literal SSH user `git`),
      query strings, fragments, whitespace, control characters, and arbitrary
      SCP-like values with diagnostics that do not repeat the rejected input.
- [x] For standalone `deployRelease`, conditionally reload provider metadata
      names (never credential values) when the selected manifest contains a
      named-provider planned OCI artifact or a published OCI artifact, reject
      selected Deploy projections against every declared provider, and retain
      the same runtime-bypass check used by composed workflow execution.
      Filesystem artifacts and provider-off planned OCI artifacts must continue
      to ignore provider metadata.
- [x] Define the guarantee precisely: selecting an application provider does not
      automatically project its credential names into project-controlled Build,
      npm, or Deploy code. Framework-owned Source, toolchain-image, Rush-cache,
      deploy-tag, or release-Git adapters may still read the same name only when
      the caller separately configures that capability to do so. A caller can
      also deliberately reuse the same underlying value under another name;
      documentation must recommend distinct least-privilege credentials and
      must not claim name/value identity detection across explicit capabilities.
- [x] Ensure provider-off and no-OCI flows do not load provider metadata merely
      to construct a protected-name set.
- [x] Make execution validation invocation-aware:
  1. initial workflow validation checks the repository, mesh, and target
     metadata without parsing application-image providers;
  2. Detect and package-plan construction determine selected artifact kinds;
     and
  3. only a selected OCI plan loads provider definitions and runs selected-plan
     provider/collision validation.

- [x] Keep the explicit repository-wide `validate`/metadata-contract entrypoint
      intentionally stricter: it validates every present provider file and all
      cross-file collisions even when no invocation-specific OCI plan is
      selected. Document this distinction so repository linting and execution
      are not described as identical operations.

### Framework-Owned Deploy Environment

- [x] Reserve the entire `ARTIFACT_` output namespace plus `GIT_SHA` and
      `DRY_RUN` for Rush Delivery.
- [x] Document the currently emitted framework values:
  - `ARTIFACT_PATH`;
  - `ARTIFACT_KIND`;
  - `ARTIFACT_IMAGE_NAME`;
  - `ARTIFACT_IMAGE_REFERENCE`;
  - `ARTIFACT_IMAGE_REPOSITORY`;
  - `ARTIFACT_IMAGE_DIGEST`;
  - `ARTIFACT_IMAGE_PLATFORMS_JSON`;
  - `ARTIFACT_SOURCE_REVISION`;
  - `ARTIFACT_EVIDENCE_DIR`;
  - `GIT_SHA`;
  - `DRY_RUN`.

- [x] Reject reserved names in deploy `runtime.env`, `pass_env`, `map_env`
      output names, `dry_run_defaults`, `required_host_env`, and host-path
      `source_var`. Reject ownership collisions even if both values happen to be
      identical.
- [x] Reject `ARTIFACT_FUTURE_NAME` as well as the current variables so future
      framework additions cannot silently break existing deploy metadata.
- [x] Add parser, root-schema, metadata-contract, and runtime checks. The
      runtime check must protect direct internal/model callers and old metadata
      that did not pass through the current schema.
- [x] Construct project environment and framework environment separately, check
      for collisions, and apply framework-owned values last. Object-spread order
      alone is not an enforcement mechanism.
- [x] Make each dry-run summary and returned result derive from the exact final
      environment computed for that invocation. Dry and live invocations are
      not byte-equal: `DRY_RUN`, defaults, planned/published fields, digest, and
      evidence necessarily differ.
- [x] Make flat env-file syntax diagnostics secret-safe. A malformed physical
      line or invalid name reports its line number and redacted content, never
      the raw line, key text, or value; this includes an actual-newline PEM body.

### Signing Preflight And OCI Execution Barrier

- [x] Retain useful PEM marker and literal-`\n` decoding diagnostics, but stop
      calling marker checks cryptographic validation.
- [x] Before any application image is built, scanned, authenticated to its
      destination registry, or published, run one offline cryptographic
      preflight for the selected live provider with the existing digest-pinned
      Cosign image. Pulling that tool image may itself require ordinary registry
      network access; “offline” describes Cosign's key operation, not Dagger
      image availability.
- [x] Materialize the pinned Cosign tool image and a digest-pinned static shell
      helper in a distinct secret-free
      availability stage before attaching provider secrets or classifying key
      commands. A tool-image pull/DNS/TLS failure must be reported as sanitized
      tool availability, never as a private-key/password/public-key failure.
- [x] Have the preflight decrypt the private key with the supplied password,
      derive/parse its public identity, parse the configured verification key,
      and prove the key pair matches. Compare canonical key identity rather than
      raw whitespace.
- [x] Keep private material in Dagger secrets. Do not collect or print the
      private key, password, token, signature payload, or secret-bearing command.
- [x] Report only the provider and failed credential role for malformed private
      keys, malformed public keys, wrong passwords, and mismatched pairs.
- [x] Run the preflight once per selected provider, not once per target. Dry runs
      never resolve values or run the preflight.
- [x] Split live OCI execution into two internal phases without changing the
      public artifact or manifest model:
  1. prepare each selected image by building it, exporting the exact subject,
     validating its SPDX SBOM, and scanning it;
  2. publish the prepared subject, validate the returned digest, create
     provenance, sign, attest, verify, and construct evidence.

- [x] Run preparation in parallel, await all preparation operations, aggregate
      failures in stable selected-target order, and start no registry mutation
      unless every selected OCI target prepared successfully.
- [x] Preserve a mixed-selection barrier: all selected filesystem validations,
      archive/directory package commands, and their materialization must also
      succeed before any OCI publication begins.
- [x] Keep provider secrets out of the preparation function entirely; provide
      them only to publication/finalization.
- [x] Finalize prepared targets one at a time in stable selected-target order to
      bound partial external side effects. Stop starting later targets after a
      finalization failure.
- [x] Await every operation already started before returning an error.
- [x] On finalization failure, do not write a successful package manifest and do
      not start Deploy. Report, in deterministic order:
  - the failed target and stage;
  - any canonical digest reference known to have been published for that
    target;
  - every earlier sibling target known to have completed publication;
  - every later target that was not started; and
  - a sanitized cleanup warning.

- [x] Never include a credential, Docker auth payload, private repository token,
      mutable navigation tag as a deploy reference, or Dagger secret value in
      aggregate errors.
- [x] Keep publication explicitly nontransactional. Do not promise or implement
      automatic provider-specific deletion in this patch.

### Evidence And Split-Stage Trust

- [x] Keep Package-time Cosign verification and Deploy-time local bundle checks
      as different guarantees.
- [x] Preserve strict v2 parsing, lowercase digest-only references, exact
      repository/reference agreement, full source-revision matching, and
      target-prefixed evidence paths.
- [x] Require every OCI package target name to be one safe evidence-directory
      segment in the package-target schema, metadata parser, and action planner,
      so an unsafe selected OCI target fails before Rush Build. Preserve legacy
      filesystem target names that do not use the OCI evidence subtree.
- [x] Keep package-manifest v2 schema and runtime parsing aligned on canonical
      evidence paths, exact `slsa-provenance-v1`/`spdx-json` document formats,
      and normalized filesystem `deploy_path`/`path` values with no trailing
      separators or dot segments.
- [x] Validate every selected published OCI target's evidence before the first
      live deploy script in any wave starts.
- [x] Exclude `.dagger/runtime/evidence` from the generic deploy workspace for
      both partial and `mode: full` workspaces, then mount only the current
      published OCI target's verified evidence directory at the framework-owned
      `ARTIFACT_EVIDENCE_DIR`.
- [x] Prevent an explicit partial workspace path or a broader parent directory
      from reintroducing another target's evidence. Filesystem targets receive
      no OCI evidence directory unless project source independently contains a
      non-runtime path with that content.
- [x] Prevent a normalized repository-backed `runtime.file_mounts` host path
      from reintroducing `.dagger/runtime/evidence` or any descendant. This
      runtime-bypass check must apply after absolute workspace paths have been
      converted to repository-relative paths.
- [x] Normalize the destination of both runtime file-mount forms and reject an
      exact framework evidence destination, any descendant, and any parent that
      could replace or mask `/workspace/.dagger/runtime/evidence`. Enforce this
      in schema-expressible canonical forms, the parser, and direct-call runtime
      checks while preserving non-colliding legacy spellings.
- [x] Keep `ARTIFACT_EVIDENCE_DIR` absent for filesystem artifacts and planned
      OCI artifacts.
- [x] Canonicalize every Package output from the post-Build repository view:
      preserve project-owned non-runtime `.dagger` files/directories (including
      filesystem artifacts), remove the complete pre-existing `.dagger/runtime`
      path whether it is a file, directory, or symlink, materialize concrete
      `.dagger` and `.dagger/runtime` directories, and only then write the new
      manifest, frozen credential-name capability, and evidence. Never mutate a
      symlink redirect target while doing so.
- [x] Run one common Deploy bundle-shape preflight before dry or live target
      execution. Reject a supplied bundle when `.dagger`, `.dagger/runtime`, or
      `.dagger/runtime/evidence` is a symlink; do not silently repair or follow
      the alias.
- [x] Define `evidence.signature.verified: true` as a record that Package
      successfully verified the subject signature and required attestations
      against the configured public key. Define `signature.reference` as the
      immutable image subject used for Cosign lookup, not as a portable locator
      for a signature object.
- [x] State that Deploy does not query the registry or rerun Cosign. It validates
      the manifest shape, source revision, digest reference, evidence paths, and
      local document hashes against the supplied manifest.
- [x] Treat an exported packaged directory, its manifest, and its evidence as one
      trusted release-control bundle. Local rehashing does not defend against an
      attacker who can replace both manifest and evidence.
- [x] Require split-stage operators to use access-controlled immutable artifact
      storage, protected producer/consumer jobs, an externally recorded artifact
      identity or checksum, atomic restoration of the whole bundle, and an
      expected full Git SHA obtained from protected release metadata outside the
      unsigned bundle. Deploy compares the manifest revision to that independent
      expected SHA.
- [x] Keep signed portable bundles and Deploy-time registry Cosign verification
      out of this patch; they require a separately designed public contract.

### Vulnerability And Cosign Semantics

- [x] Keep `scan.fail_on` as an exact set of rejected normalized severities, not
      a threshold. In particular, `[high]` rejects High findings but does not
      implicitly reject Critical findings; production policy normally lists
      both `high` and `critical`.
- [x] Describe `scan.ignore_file` accurately as a repository-owned Grype YAML
      configuration passed through `--config`, not as a Rush Delivery-specific
      list format.
- [x] Provide a tested minimal Grype configuration. Record exception reason,
      owner, review/expiry date, and removal follow-up in YAML comments or an
      adjacent governed record; pass only keys supported by the pinned Grype
      configuration format to `--config`.
- [x] Validate the minimum Grype report structure before evaluating policy:
      `matches` must be an array (an explicit empty array is valid), and each
      evaluated match must contain a non-empty vulnerability ID and supported
      severity. Treat missing/malformed fields or unsupported severity as
      invalid scanner output and fail closed; do not silently treat a malformed
      report as “no findings” or pretend `unknown` is selectable in
      `scan.fail_on`.
- [x] Keep the Syft, Grype, Cosign, and preflight BusyBox helper container
      images digest-pinned.
- [x] State separately that the Grype vulnerability database and cache are
      mutable network-supplied inputs. Document outbound-network, cache,
      availability, freshness, reproducibility, and fail-closed assumptions.
- [x] Preserve the current private-registry-friendly key-backed Cosign mode:
      signing and attestations use `--tlog-upload=false`; verification uses
      `--insecure-ignore-tlog`. Pin `--new-bundle-format=false` on all six
      registry sign, attest, and verify commands so Cosign `3.1.2` uses
      digest-derived `.sig` and shared `.att` tag attachments rather than the
      OCI 1.1 Referrers API; distinguish this from legacy Docker media types and
      leave the local blob preflight unchanged.
- [x] State what this mode proves: the configured key verified the digest-bound
      subject signature and required attestations during Package.
- [x] State what it does not prove: Rekor inclusion, public transparency,
      keyless workload identity, trusted timestamping, public auditability, or a
      new cryptographic verification during Deploy.

## Phase 0: Freeze The Released Baseline And Add Reproductions

Implementation record: this task was committed before implementation, and the
released baseline was frozen from `v0.8.0`. During the first uncommitted
implementation batch, however, some production changes and regression tests
were developed together rather than preserving a separately runnable red-test
commit for every defect. Do not later claim literal red-first chronology for
those cases. Acceptance must instead retain the concrete regression, immutable
baseline comparison, adversarial review, live proof where required, and all
clean-checkout gates. This recorded sequencing deviation does not waive any
behavioral or release gate below.

- [x] Confirm the working baseline is tag `v0.8.0` at
      `d98d666e17845a5d7089571fe7c8b256484e6a25` and record any intentional
      baseline drift in this task before implementation.
- [x] Run the existing setup and quality baseline with the repository's actual
      commands: `yarn install --frozen-lockfile` when dependencies need setup,
      then `npm run typecheck` and `npm test`.
- [x] Confirm the installed Dagger CLI and
      [`../dagger.json`](../dagger.json) both use `v0.20.7`; do not upgrade the
      engine for this task unless a separately documented requirement is found.
- [x] Read and follow
      [`../.ai/rules/BashModules.md`](../.ai/rules/BashModules.md) before editing
      the canonical deploy script, OCI acceptance scripts, or the GitHub Action
      shell wrapper.
- [x] Add `v0.8.0` at the front of `publishedVersions` in
      [`../website-docusaurus/scripts/sync-versioned-docs.mjs`](../website-docusaurus/scripts/sync-versioned-docs.mjs)
      before changing any current documentation.
- [x] Generate the `v0.8.0` versioned documentation and sidebars only through
      `npm --prefix website-docusaurus run sync-versioned-docs`, which must read
      the immutable `v0.8.0` tag.
- [x] Compare the generated `v0.8.0` snapshot inputs with `git show v0.8.0:...`
      and fail if current working-tree docs leaked into the snapshot.
- [x] Never hand-edit the generated `v0.8.0` documentation, sidebars, or the
      released [`../schemas/v0.8.0`](../schemas/v0.8.0) snapshot.
- [x] Retain focused regression tests for no-OCI provider activation, credential
      projection, reserved environment collisions, key-mismatch timing, and
      multi-target side effects. Where a regression was developed with its
      production fix, use the frozen `v0.8.0` comparison, compatibility goldens,
      and recorded adversarial review as defect evidence; do not claim literal
      red-first chronology. Compatibility goldens and already-correct positive
      behavior must pass.
- [x] Capture current filesystem-only manifest and deploy-result fixtures as
      compatibility goldens.
- [x] Add prototype-shaped-name regressions so absent `constructor`/`toString`
      selections never resolve inherited object properties, while explicitly
      declared prototype-shaped legacy service/target names remain safe. Build
      normalized maps without allowing `__proto__` assignment to mutate their
      prototypes, and require own-property lookup for selected providers,
      services, and manifest artifacts.

### Internal Release-Infrastructure Prerequisites

These repairs make the existing release gates trustworthy. They are not new
Rush Delivery consumer capabilities and must be complete before implementation
results can be accepted.

- [x] Add a clean-clone regression that supplies tracked module source with the
      ignored generated `sdk/` directory absent, with no prior
      `dagger develop`, no host `node_modules`, and no cached generated output.
      Demonstrate the current nested self-check failure before repairing it.
- [x] Repair [`../src/self-check/self-check.ts`](../src/self-check/self-check.ts)
      so `dagger call self-check` deterministically generates or provisions the
      matching TypeScript SDK inside its isolated execution before typecheck and
      tests need it. Do not read an untracked host SDK, require a caller to run
      `dagger develop`, commit generated SDK output, hand-edit generated files,
      or change the Dagger engine/public module contract.
- [x] Keep the generated SDK ephemeral to the self-check execution and prove
      the repair works for a repository checkout or archive containing tracked
      files only. A developer's pre-existing `sdk/` directory must
      neither be required nor able to mask the regression.
- [x] Refactor the live OCI acceptance harness so registry endpoint,
      harness-owned provider coordinates, credentials, and unique namespace can
      be supplied through test-only script configuration. Do not expose that
      configuration through the Rush Delivery Dagger API, GitHub Action API,
      project metadata, schemas, tutorial provider contract, or returned
      models.
- [x] In the harness, inherit GitHub credentials only for the exact automatic
      GHCR project mode. An explicit non-GHCR endpoint must require explicit
      acceptance credentials and must never silently reuse `GITHUB_ACTOR` or
      `GITHUB_TOKEN`; the public product contract remains unchanged.
- [x] Prototype the live registry topology before relying on it as a gate. Prefer
      a project-controlled trusted-TLS endpoint with a harness-owned disposable
      namespace. If an in-engine registry would require unsupported product
      custom-CA or insecure-registry behavior, use an explicitly configured
      standards-compatible external endpoint instead of weakening the product
      contract. Record the chosen endpoint's TLS, capability, retention,
      redaction, and cleanup guarantees and do not make `ttl.sh` the sole default.
- [x] Allocate a cryptographically unique per-run namespace, register cleanup
      before mutation begins, and preserve the no-host-Docker-socket contract.
      Generate test Cosign material inside the Dagger/test execution; the live
      gate must not require a host Docker or Podman CLI, socket, or daemon.
- [x] Define bounded retry policy by operation and failure class. Retry only
      transient transport failures in harness provisioning, readiness,
      side-effect-free capability probes, and safe immutable reads, with fixed
      attempt/time limits and sanitized diagnostics. Never retry the complete
      Package/publish/sign/attest/verify flow automatically; if transport fails
      after mutation may have started, report the outcome as unknown or partial
      and enter evidence inspection/cleanup rather than assuming it is safe to
      publish again.
- [x] Give harness setup/readiness/transport failures stable diagnostics that
      are distinct from Rush Delivery authentication, security-policy,
      key-preflight, publication, signature, attestation, manifest, and evidence
      failures. Retry exhaustion must retain the original sanitized failure
      class and must not turn a product-contract failure into infrastructure
      flakiness.
- [x] Add deterministic harness tests for transient success within the retry
      bound, retry exhaustion, a non-retryable product failure, an ambiguous
      post-mutation transport failure, cleanup registration/execution, and
      secret-sentinel absence from all diagnostics.

### Phase 0 Exit Gate

- [x] Released docs are frozen from the tag; every identified defect has concrete
      regression coverage plus either an observed pre-fix failure or the
      recorded frozen-baseline/adversarial evidence; compatibility and positive
      tests pass; clean-clone self-check is independent of host-generated SDK
      state; the live-registry harness has bounded, classified failure behavior;
      and current root-documentation changes began only after the `v0.8.0`
      snapshot was generated and verified.

## Phase 1: Correct Provider Activation And Environment Ownership

- [x] Refactor
      [`../src/stages/package-stage/execute-package-plans.ts`](../src/stages/package-stage/execute-package-plans.ts)
      so the zero-OCI path returns through the existing filesystem packaging
      contract without creating provider state.
- [x] Refactor workflow/build-package planning so selected package definitions
      and the selected provider definition are known before Rush Build, without
      resolving live credential values early.
- [x] Reuse the loaded package plans instead of parsing the same target metadata
      independently before Build and Package.
- [x] Apply the same conditional activation to `workflow`,
      `packageDeployTargets`, and `buildAndPackageDeployTargets`; preserve the
      standalone filesystem-only behavior of every entrypoint.
- [x] Fail a live selected OCI plan with provider `off` before executing the Rush
      lifecycle, application image build, or application-image external side
      effect. Source acquisition may already have occurred.
- [x] Add the two-pass execution validation described above: initial validation
      skips application-provider parsing, while post-Detect validation loads it
      only for a selected OCI plan and checks only executable selected-plan
      projections.
- [x] Preserve explicit repository-wide validation as the path that checks every
      declared application provider and all target cross-file collisions.
- [x] Add a central protected-name/collision utility shared by metadata
      validation, Build environment resolution, npm Release orchestration, and
      Deploy runtime resolution.
- [x] Add cross-file metadata validation that reports all protected credential
      projections together in stable path/field order.
- [x] Add schema-representable reserved namespace restrictions to the root
      [`../schemas/deploy-target.schema.json`](../schemas/deploy-target.schema.json).
- [x] Add parser enforcement in
      [`../src/stages/deploy/parse-deploy-target.ts`](../src/stages/deploy/parse-deploy-target.ts)
      and runtime enforcement in
      [`../src/stages/deploy/runtime-env.ts`](../src/stages/deploy/runtime-env.ts).
- [x] Fix
      [`../src/stages/deploy/execute-target.ts`](../src/stages/deploy/execute-target.ts)
      so metadata environment cannot overwrite framework environment and the
      final map is the single source for dry-run and live execution.
- [x] Ensure errors remain actionable when more than one target or field is
      invalid, and never resolve a protected value merely to report its name.

### Phase 1 Required Tests

- [x] Directory-only, archive-only, empty, and npm-only plans succeed with a
      named provider input and no application-provider file.
- [x] A filesystem-only plan also ignores an otherwise invalid unused provider
      input.
- [x] A mixed repository selecting only filesystem targets does not activate the
      provider; a selection containing an OCI target does.
- [x] OCI provider-off/named × dry/live behavior matches the truth table.
- [x] Named OCI dry run loads provider metadata but succeeds without any
      credential values and never resolves/indexes provider entries from a
      supplied aggregate env map.
- [x] Live OCI reads exactly the five selected provider values and no values for
      unselected providers.
- [x] Source URL tests reject userinfo, query, fragment, malformed locators, and
      secret sentinels without echoing the rejected locator or sentinel.
- [x] Token, private key, password, public key, and generated Docker config are
      Dagger secrets; username remains a framework-owned non-secret string and
      is absent from project environments/results. Dagger's own progress graph
      may show the username; never configure a secret value in that field.
- [x] Same-provider and cross-provider credential-name aliases fail before any
      value lookup; a direct-model bypass cannot reuse a secret role through
      `username_env`.
- [x] Every protected credential channel fails closed: Build `pass_env`, both
      sides of Build `map_env`, Build defaults, Deploy `pass_env`, both sides of
      Deploy `map_env`, static Deploy env, Deploy defaults, required host env,
      host-path source vars, and composed npm auth.
- [x] Every reserved output channel rejects `ARTIFACT_PATH`, each current OCI
      `ARTIFACT_*` name, an unknown future `ARTIFACT_*` name, `GIT_SHA`, and
      `DRY_RUN`.
- [x] Parser, root schema, metadata-contract, and runtime-bypass tests agree.
- [x] Flat env-file parser tests prove malformed values and actual-newline PEM
      bodies are redacted from diagnostics.
- [x] Execution no-OCI tests ignore an invalid present provider file, while the
      explicit repository validator reports that same invalid file.
- [x] Standalone filesystem and provider-off planned OCI Deploy ignore provider
      metadata, while standalone named/published OCI Deploy validates provider
      credential names without resolving or using their values and fails before
      any deploy script if a selected runtime projects one.
- [x] Same-value collisions fail; harmless non-reserved environment still works.
- [x] Filesystem-only compatibility goldens remain byte- and shape-identical.

### Phase 1 Exit Gate

- [x] No-OCI workflows are provider-independent, project metadata cannot
      receive protected application credentials, and framework Deploy variables
      have one unambiguous owner.

## Phase 2: Harden Package Preflight And Multi-Target Side Effects

- [x] Refactor application-image packaging into explicit prepare and finalize
      operations with typed inputs/results.
- [x] Keep image, platform, Git SHA, source URL, context, Dockerfile, SBOM, scan,
      and prepared subject in the prepare result without provider credentials.
- [x] Preserve the repository-relative Dockerfile coordinate in the action plan
      and provenance, then convert it exactly once to a context-relative path
      for Dagger's narrowed build directory. Validate containment for parsed
      metadata and direct internal inputs; never double-relativize the path.
- [x] Create a pure/testable Cosign command plan so the intentional
      `--tlog-upload=false` and `--insecure-ignore-tlog` flags cannot drift from
      documentation unnoticed.
- [x] Add the one-time cryptographic provider preflight before invoking any
      prepare operation.
- [x] Aggregate all prepare failures deterministically and verify the registry
      publish method was never called when any prepare operation fails.
- [x] Finalize in selected-target order and retain sanitized state for every
      target that crossed the publication boundary.
- [x] Validate Dagger's returned publication reference before signing and before
      recording it as a possible side effect.
- [x] Ensure the successful path still publishes once, signs the digest, attaches
      SPDX and provenance attestations, verifies all required objects, and emits
      the existing v2 artifact shape.
- [x] Keep the local Grype scan report as evidence only; do not call it a registry
      attestation. Only SPDX SBOM and provenance are attached attestations.
- [x] Preserve the source revision and immutable digest as the only Deploy image
      identity; the `sha-<full-git-sha>` tag remains navigation only.

### Phase 2 Required Tests

- [x] Internal credential normalization/preflight accepts a valid raw multiline
      key in a unit test and the public flat-env path accepts literal-`\n`.
      Tutorials and end-to-end acceptance use literal-`\n`; raw multiline PEM is
      not representable in the current one-line env-file contract.
- [x] Malformed private PEM, malformed public PEM, wrong password, and mismatched
      public key fail before any application image build, destination-registry
      authentication, publication, or mutation. A Cosign tool-image pull is not
      part of that guarantee.
- [x] A simulated Cosign tool materialization failure is sanitized and remains
      distinguishable from every credential-role failure.
- [x] Multiple selected targets run one provider preflight.
- [x] Dry runs never resolve/index provider credential entries, create provider
      Dagger secrets, or preflight credentials. Tests that claim no bytes were
      read must omit the aggregate env file entirely.
- [x] One target failing Docker build, SPDX validation, or Grype policy prevents
      every selected target from publishing.
- [x] Feed a real parsed/action-planned canonical target into Docker build-path
      selection and prove the narrowed context receives `Dockerfile` (or the
      correct nested context-relative path) while provenance retains the
      canonical repository-relative value.
- [x] A directory/archive validation or packaging-command failure in a mixed
      selection also prevents every selected OCI target from publishing.
- [x] Parallel preparation awaits all started work and reports failures in
      selected-target order rather than completion order.
- [x] A publish failure after all preparation passes reports earlier completed
      targets and later not-started targets.
- [x] A post-publish sign/attest/verify failure reports the target's canonical
      digest reference and cleanup warning without printing credentials.
- [x] No failed batch produces a successful package manifest or begins Deploy.
- [x] Exact-set scan tests prove High-only does not reject Critical, Critical-only
      does not reject High, combined policy rejects both, supported severities
      normalize correctly, and a missing/unsupported report severity fails as
      invalid scanner output.
- [x] Scanner-integrity tests reject absent/non-array `matches`, missing IDs,
      malformed vulnerability entries, and unsupported severities while
      accepting an explicit empty `matches` array.
- [x] Validate the documented empty Grype configuration and wire it byte-for-byte
      to the pinned Grype invocation. The exact merged-candidate GHCR run in
      Phase 10 must prove that the pinned Grype image accepts it. Do not
      manufacture a database-dependent
      “narrowly ignored CVE” fixture against Grype's drifting network database.
      If a non-empty exception is ever checked in, require a separate governed
      test with a controlled database snapshot that proves its exact scope and
      expiry/removal record before claiming ignored-finding behavior.
- [x] Pure Cosign plan tests pin every sign, attest, verify, and
      verify-attestation flag.

### Phase 2 Exit Gate

- [x] Preventable key/filesystem-package/build/SBOM/scan failures precede all
      application-image registry mutation, and every unavoidable partial side
      effect is bounded, deterministic, and sanitized.

## Phase 3: Enforce Evidence Isolation And Trustworthy Deploy Handoff

- [x] Refactor
      [`../src/stages/deploy/runtime-workspace.ts`](../src/stages/deploy/runtime-workspace.ts)
      to remove framework runtime evidence from the generic repository view
      before applying either full or partial workspace metadata.
- [x] Mount only the current target's evidence from the original trusted
      packaged directory after the generic workspace has been applied.
- [x] Make explicit workspace requests for the framework evidence subtree fail
      with guidance to consume `ARTIFACT_EVIDENCE_DIR` instead.
- [x] Preserve access to ordinary `.dagger` project metadata where requested;
      removing the framework evidence subtree must not remove unrelated source
      files.
- [x] Keep evidence preflight ahead of the first deploy wave, not once per script
      after earlier targets may already have deployed.
- [x] Make source mismatch, planned-live artifact, evidence path, evidence hash,
      repository/reference, and verification-assertion errors distinguishable
      without overstating cryptographic verification.
- [x] Ensure the OCI deploy-result model always returns `artifactKind` and
      `artifactImage`, returns `artifactReference` only for published artifacts,
      and never fabricates `artifactPath`.
- [x] Preserve the existing filesystem deploy-result shape.

### Phase 3 Required Tests

- [x] Partial and full workspaces for OCI target A cannot read target B evidence.
- [x] A filesystem target in a mixed v2 manifest receives no OCI evidence.
- [x] An explicit parent directory such as `.dagger` cannot bypass evidence
      filtering.
- [x] A repository-backed host-path file mount cannot bypass target evidence
      filtering by naming `.dagger/runtime/evidence` or a descendant, including
      relative/absolute paths with interior `.` segments, repeated separators,
      or backslashes that Dagger later canonicalizes.
- [x] Both runtime file-mount forms reject normalized destinations equal to,
      below, or above the framework evidence mount, including parser/schema and
      direct-runtime bypass tests; unrelated legacy targets remain accepted.
- [x] Selected evidence is available exactly at `ARTIFACT_EVIDENCE_DIR` and its
      three document hashes match the manifest.
- [x] Missing files, target mismatch, path traversal, modified evidence, and
      malformed or invariant-breaking manifest changes (including
      digest/reference/source/path/evidence disagreement), planned live
      artifacts, mutable references, and source mismatch fail before any deploy
      script starts. Do not claim detection of a coordinated schema-valid
      manifest-plus-evidence replacement.
- [x] Schema/parser/planner tests reject unsafe OCI target path segments before
      Build, reject wrong evidence formats and noncanonical evidence/filesystem
      paths, and retain nested filesystem-only target-name compatibility.
- [x] For both dry and live invocations, a real deploy script or summary sees the
      final environment computed for that invocation. Tests compare ownership,
      precedence, and invariant fields rather than asserting dry/live byte
      equality.
- [x] A split-stage acceptance exports the complete packaged directory, restores
      it in a separate call, supplies an independently trusted expected Git SHA,
      and proves the original digest reaches the Deploy script without rebuild
      or tag lookup.
- [x] A real Dagger Package entrypoint preserves a filesystem directory artifact
      and Build output under `.dagger/generated-output`, discards stale runtime
      file/directory/symlink variants, writes new runtime metadata below
      concrete directories, and leaves every former redirect target byte-for-byte
      unchanged.
- [x] Standalone Deploy rejects `.dagger`, `.dagger/runtime`, and
      `.dagger/runtime/evidence` aliases before both dry and live target
      execution; the regression must exercise the common preflight rather than
      relying only on live workspace assembly.

### Phase 3 Exit Gate

- [x] Deploy receives only its owned framework environment and target evidence,
      and tests/documentation can state exactly which checks are cryptographic,
      local-consistency, or operator trust.

## Phase 4: Create One Canonical Executable OCI Example

Create [`../examples/oci-application-image-rush-repo`](../examples/oci-application-image-rush-repo)
as the source for tutorial commands and OCI acceptance tests. Do not teach from
a private external repository or a test-only fixture.

- [x] Add a minimal valid Rush project whose normal Rush build deterministically
      creates the output consumed by its Dockerfile.
- [x] Use a final `scratch` image containing only the deterministic tutorial
      payload so mutable vulnerability data cannot make the happy-path example
      randomly fail.
- [x] State that the `scratch` subject proves OCI build/evidence/publication and
      digest handoff, but is not an HTTP service deployable to Cloud Run. Cloud
      Run, Kubernetes, and Swarm commands are adaptation excerpts, not claims
      that the scratch payload completed a real vendor rollout.
- [x] Include a complete copyable tree:

```text
examples/oci-application-image-rush-repo/
├── .gitignore
├── package.json
├── rush.json
├── ci/oci-plan.json
├── common/
│   ├── scripts/
│   │   ├── install-run.js
│   │   ├── install-run-rush.js
│   │   ├── install-run-rush-pnpm.js
│   │   └── install-run-rushx.js
│   └── config/rush/
│       ├── command-line.json
│       ├── common-versions.json
│       ├── pnpm-config.json
│       └── pnpm-lock.yaml
├── apps/control-plane-api/
│   ├── package.json
│   ├── src/payload.txt
│   ├── scripts/build.mjs
│   └── Dockerfile
├── deploy/consume-image.sh
└── .dagger/
    ├── application-images/
    │   ├── providers.yaml
    │   └── grype.yaml
    ├── deploy/services-mesh.yaml
    ├── deploy/targets/control-plane-api.yaml
    ├── package/targets/control-plane-api.yaml
    └── rush-cache/providers.yaml
```

- [x] Generate/check the minimal Rush scaffold with the pinned Rush/pnpm
      versions rather than hand-inventing it. Include every file required for a
      clean `rush install`, `build`, `lint`, `test`, and `verify` run, and make
      `package.json` define deterministic scripts for all four lifecycle names.
- [x] Keep Rush-generated `common/scripts/install-run*.js` bootstrap bundles
      byte-exact for the pinned Rush version. Exclude those generated bundles
      from repository formatters and pin their hashes in tests so a clean Rush
      install cannot be broken by an otherwise successful formatting pass.
- [x] Make all metadata names agree with Rush project name, services mesh,
      package target, deploy target, CI plan, and image suffix.
- [x] Use `v0.8.1` immutable schema URLs in every metadata editor hint.
- [x] Include a real Grype config, not a pseudo-format or unexplained empty file.
- [x] Make the checked-in provider file a schema-valid, clearly labelled GHCR
      tutorial template. Live automated acceptance may create a temporary copy
      with only registry/provider coordinates replaced by its unique trusted-TLS
      test namespace; all application/build/deploy files remain canonical.
- [x] Keep generated CI state out of `.dagger/runtime`: use the checked-in
      tutorial plan at `ci/oci-plan.json` or generate a plan into a temporary
      external path, while `.gitignore` excludes all `.dagger/runtime` state.
- [x] Include names-only local env templates in docs, never credential values in
      the example.
- [x] Ignore generated build output, local env/key files, exported package
      bundles, and `.dagger/runtime` state.
- [x] Make `deploy/consume-image.sh` executable and provider-neutral. It must:
  - require `ARTIFACT_KIND=oci_image`;
  - require and validate every published OCI `ARTIFACT_*` value;
  - reject `ARTIFACT_PATH`;
  - reject mutable-tag-only references;
  - require exact `repository@digest` agreement;
  - require the evidence directory and expected files;
  - consume `ARTIFACT_IMAGE_REFERENCE` unchanged; and
  - print only sanitized target/reference information.

- [x] Keep Cloud Run, Kubernetes, and Swarm commands as separate production-guide
      excerpts; do not put vendor switching in the canonical script or framework.
- [x] Remove the former `test/fixtures/oci-rush-repo` duplication so live
      acceptance executes the public example rather than a drifting fixture.
- [x] Define snippet synchronization before writing docs: generate complete file
      blocks from the canonical example, or mark and byte-compare each duplicated
      fenced block against its source file. Parsing alone is not a drift check.
- [x] Validate example YAML against root and `v0.8.1` schemas, validate its
      metadata contract, run its Rush build, run `bash -n` and repository shell
      lint, and execute its provider-off dry-run acceptance.

### Phase 4 Exit Gate

- [x] Every file used by the tutorial is checked in once, executable, validated,
      and also exercised by automated acceptance.

## Phase 5: Write The End-To-End Tutorial

Add a dedicated learning path under
[`../docs/tutorial/oci-application-images`](../docs/tutorial/oci-application-images)
and link it from [`../docs/tutorial/README.md`](../docs/tutorial/README.md).

Create these chapters:

```text
docs/tutorial/oci-application-images/
├── README.md
├── 01-build-and-scan-target.md
├── 02-provider-off-dry-run.md
├── 03-registry-and-cosign-bootstrap.md
├── 04-publish-and-inspect.md
├── 05-deploy-the-digest.md
├── 06-github-actions.md
└── 07-split-stages-and-rollback.md
```

Every chapter must state prerequisites, show complete commands/files, include
sanitized expected output, explain failure meaning, end with a verifiable
checkpoint, and link to the next chapter.

### Tutorial 1: Build And Scan Target

- [x] Explain when to choose `oci_image`, `directory`, or
      `rush_deploy_archive`.
- [x] Start from the canonical minimal Rush project and show the complete build
      script, Dockerfile, package target, and Grype config together.
- [x] Explain that the normal workflow builds before Package, while standalone
      `packageDeployTargets` expects already-built input.
- [x] Explain repository-relative context/Dockerfile resolution, Dockerfile
      containment, image suffix, single required platform, trusted source labels,
      and full 40-character Git SHA.
- [x] Teach exact-set scan semantics and show why the production example lists
      both `high` and `critical`.
- [x] Explain the mutable Grype database and governed exception workflow.
- [x] State the supported `v0.8.1` surface and link limitations instead of
      implying support for unimplemented Docker build features.

### Tutorial 2: Provider-Off Dry Run

- [x] Start with `applicationImageProvider=off` and no secrets.
- [x] Run metadata validation before workflow execution.
- [x] Show copy-paste Dagger commands using an exact synthetic 40-character SHA.
- [x] Show the planned artifact/summary for provider `off`: image, platform, and
      source revision, with no repository, digest, or evidence.
- [x] Contrast filesystem-only, provider-off OCI, and named-provider OCI dry run
      in a small behavior matrix.
- [x] Prove the provider-off dry run performs no application-image build,
      destination-registry request, Syft/Grype/Cosign execution, provider
      credential read, signing operation, or Deploy. State that source
      acquisition, module/base-image pulls, dependency install, and Rush Build
      may still use network depending on the chosen entrypoint and cache state.

### Tutorial 3: Registry And Cosign Bootstrap

- [x] Use GHCR as the one primary linear tutorial registry. Require the reader to
      set a literal normalized owner/repository prefix in provider metadata at a
      checkpoint; metadata does not interpolate shell or GitHub variables.
      Clearly label the checked-in `example/...` prefix as a template that is
      not pushable until replaced.
- [x] Show the complete provider metadata before asking the reader to select it.
- [x] Provide a tested Cosign `3.1.2` password-protected key-generation sequence
      for both an installed binary and the digest-pinned container.
- [x] Label any Docker/Podman command used for the one-time pinned-container key
      bootstrap as an operator workstation option, not as an OCI Package or host
      Docker-socket requirement; offer the installed-binary path first.
- [x] Prompt for passwords without putting them in shell history or process
      arguments.
- [x] Show the expected encrypted private/public PEM markers.
- [x] Provide tested, shell-safe conversion between multiline PEM and a single
      flat-env value containing literal `\n`, including a round-trip check.
- [x] Use literal-`\n` PEM values in every public env-file/Action command. Raw
      multiline input is only an internal normalization test unless the public
      flat-env parser is separately redesigned.
- [x] Store local env material outside the repository with restrictive
      permissions; include `.gitignore` and cleanup guidance.
- [x] Show exact `gh secret set`/`gh variable set` forms without echoing values.
- [x] Run a named-provider dry run that validates repository construction but
      does not read or preflight keys.
- [x] Explain credential roles, minimum subject/attachment-tag push permissions, dedicated
      credentials, rotation, loss/recovery, retention of old public keys, and
      why the manifest does not record a key fingerprint. For GHCR classic
      PATs, state that `write:packages` is not token-scoped to one namespace or
      package; require a dedicated least-access release identity, omit
      `delete:packages`, and cover expiry, rotation, SSO, and package/org access
      controls.
- [x] Explain that key preflight is cryptographically offline and precedes
      application-image publication, while Dagger may first pull the pinned
      Cosign image and registry authentication cannot always be proven without a
      destination-registry operation.

### Tutorial 4: Publish And Inspect

- [x] Use `build-and-package-deploy-targets ... export --path=...` as the primary
      command from a clean checkout so generated build output is present in the
      returned Dagger directory.
- [x] Show `package-deploy-targets ... export --path=...` only after an explicit
      prior Build whose complete built directory was exported/restored; never
      imply that the standalone Package entrypoint builds source.
- [x] Show the exact live command with CI plan, Git SHA, source URL, provider,
      env file, and export path.
- [x] Explain observable ordering: provider/key preflight; all target
      build/SBOM/scan preparation; ordered publish/provenance/sign/attest/verify;
      evidence; manifest.
- [x] Inspect the export with tested `find` and `jq` commands.
- [x] Include complete schema-valid planned, published, and mixed-v2 manifests
      using full-length synthetic digests and SHAs.
- [x] Explain every OCI artifact/evidence field, including document digests,
      image digest, `signature.reference`, navigation tag, and which evidence is
      attached to the registry.
- [x] Show meaningful sanitized SPDX, Grype, and provenance excerpts without
      presenting truncated excerpts as complete schema examples.
- [x] Verify that the canonical reference contains `@sha256:` and that no
      credential sentinel appears in the bundle.

### Tutorial 5: Deploy The Digest

- [x] Show and execute the complete generic deploy script.
- [x] Explain publication identity separately from deployment-platform pull
      identity.
- [x] Show the full framework runtime-variable table for planned and published
      OCI artifacts and the reserved namespace rule.
- [x] Show schema-valid dry and live deploy result JSON with `artifactKind`,
      `artifactImage`, and optional `artifactReference`; never invent
      `artifactPath` for OCI.
- [x] Include clearly labelled Cloud Run, Kubernetes, and Swarm excerpts.
      Kubernetes and Swarm pass `ARTIFACT_IMAGE_REFERENCE` unchanged. Cloud Run
      passes a public GHCR reference unchanged, but maps private GHCR through an
      authenticated Artifact Registry remote repository while preserving
      `ARTIFACT_IMAGE_DIGEST`; distinguish the deployer and Cloud Run service
      agent's image-import access from the application's `--service-account`
      runtime identity.
- [x] Demonstrate source mismatch, planned-live manifest, mutable reference,
      missing evidence, and evidence-hash failures without exposing secrets.

### Tutorial 6: GitHub Actions

- [x] Begin with a filesystem-compatible baseline that omits the application
      provider or explicitly leaves it `off`, and contains no OCI secrets.
- [x] Add OCI as a separate opt-in worked example only after package/provider
      metadata exists.
- [x] Include minimum job permissions, protected release environments,
      trusted-event conditions, fork/PR behavior, secret/variable mapping, and
      full SHA/source inputs. Make permissions match the selected registry
      identity: a dedicated PAT supplies its own package scope, while a
      `${{ github.token }}` publisher needs `packages: write` and verified
      package Actions access.
- [x] Keep live registry and signing credentials out of untrusted pull requests.
- [x] Set `docker-socket: ""` in OCI-only jobs and explain why the Action's
      non-empty default remains for legacy deploy compatibility.
- [x] Show the composite Action's supported composed `workflow` form. Show
      package/split-stage publication as a separate raw Dagger CLI step inside a
      GitHub Actions job; do not imply that the composite Action exposes
      `package-deploy-targets` or `build-and-package-deploy-targets`.
- [x] Use Action and module references for `v0.8.1`. Pin every third-party
      action in production snippets to a reviewed full 40-character commit SHA
      with a human-readable release comment. Explain how strict consumers
      resolve and pin the reviewed Rush Delivery release commit while the guide
      keeps `@v0.8.1` visible as its version contract.

### Tutorial 7: Split Stages And Rollback

- [x] Give exact detect, build/package export, artifact upload, artifact restore,
      and `deploy-release` commands; do not say only “persist the manifest.”
- [x] Archive the complete packaged directory with a tested format that preserves
      file modes and symlinks, compute its checksum, and upload the archive. Do
      not rely on a raw-directory artifact upload preserving filesystem
      semantics.
- [x] Use immutable/access-controlled CI artifact storage and protected jobs.
      Record the archive checksum/artifact identity and original full Git SHA in
      protected release metadata outside the unsigned bundle; verify checksum
      before extraction, reject archive path/link escapes, extract atomically,
      and compare the restored manifest to that SHA. Pin upload/download actions
      to reviewed full commit SHAs rather than mutable tags.
- [x] State that the default all-in-one Action result does not automatically
      retain a reusable packaged directory for rollback.
- [x] Demonstrate rollback by restoring an earlier trusted archive, verifying it
      against its externally recorded identity/checksum, supplying the
      independently recorded release SHA to Deploy, checking that the manifest's
      `source_revision` agrees, and consuming its digest without editing the
      manifest or resolving a tag.
- [x] Cover registry subject/attachment retention, package-bundle retention,
      deploy-tag effects, pull identity, retry safety, and cleanup of possible
      post-publication or sibling artifacts.
- [x] State the unsigned-manifest/coordinated-replacement limitation directly.

### Phase 5 Exit Gate

- [x] A reader can follow one linear path from a minimal Rush repository through
      credential-free planning, key creation, live publication, evidence
      inspection, digest-only deployment, CI, split-stage handoff, and rollback
      without relying on omitted knowledge.

## Phase 6: Build The Production Guide And Operations References

Expand [`../docs/oci-application-images.md`](../docs/oci-application-images.md)
into the authoritative production contract/runbook. Add
[`../docs/oci-registry-recipes.md`](../docs/oci-registry-recipes.md) and
[`../docs/oci-application-image-troubleshooting.md`](../docs/oci-application-image-troubleshooting.md).

### Production Contract

- [x] Add a stage/capability diagram from source and Detect through Rush Build,
      Package preparation/finalization, trusted bundle, and digest-only Deploy.
- [x] Add complete field tables for OCI package targets and application-image
      providers, with required/optional status, constraints, and schema links.
- [x] Add entrypoint input/output guidance for `workflow`,
      `packageDeployTargets`, `buildAndPackageDeployTargets`, and
      `deployRelease`.
- [x] Add provider selection × artifact selection × dry/live behavior table.
- [x] Add a capability/environment table showing which values may reach Source,
      toolchain-image and Rush-cache adapters, Build, OCI Package tools, npm
      Release, deploy-tag/Git adapters, and Deploy. Distinguish framework-owned
      explicit adapter use from automatic projection into project code.
- [x] Add legacy filesystem, planned OCI, published OCI, and mixed v2 manifest
      examples, plus filesystem and OCI deploy-result examples.
- [x] Document every current/reserved `ARTIFACT_*` variable and make
      `ARTIFACT_PATH` versus OCI image variables mutually clear.
- [x] Add a Package-versus-Deploy verification table distinguishing registry
      cryptography, trusted manifest assertions, local hashes, source checks,
      platform pull authentication, and operator-owned artifact storage.
- [x] Document the offline Cosign mode, key preflight, key custody/rotation,
      exact scan semantics, Grype database behavior, evidence content, tool
      versions/digests, and evidence retention.
- [x] Add a failure/side-effect matrix covering provider metadata, credential
      lookup, key preflight, Docker build, SBOM validation, scan policy, publish,
      returned-reference validation, provenance, sign, attest, verify,
      multi-target finalization, manifest parsing, evidence verification, and
      deploy execution.
- [x] Explain the Dagger function-cache versus layer-cache boundary, the exact
      calls that receive fresh non-secret execution inputs, and why normal
      deterministic build caching still applies.
- [x] Explain that release Git credentials remain process-only through askpass,
      and that deploy-tag GitHub API bases must be credential-free absolute
      HTTPS URLs (including valid GitHub Enterprise API paths). Remote response
      bodies must never be included in credential-bearing request errors.
- [x] Add retry and rollback procedures that take expected bundle identity and
      Git SHA from protected external release metadata, verify the archive before
      extraction, and only then compare/use the unsigned manifest and digest.
- [x] For each failure point state: whether registry mutation may have occurred,
      whether a manifest can exist, whether Deploy can start, what is safe to
      log, what can be retried, and what cleanup may be required.
- [x] Explain `runtime.workspace.mode: full` with the framework evidence subtree
      exception and the target-specific remount.
- [x] Distinguish deploy-platform signing material mounted as runtime files from
      OCI Package Cosign keys. Never recommend putting OCI signing keys in
      `runtime-file-map`.
- [x] Document current limitations: one platform; no Docker build args, build
      secrets, SSH mount, or Dockerfile target; no keyless/OIDC/Rekor mode; no
      trusted timestamp; no custom-CA/insecure-registry configuration; no
      framework vendor deploy logic; no automatic cleanup; no signed portable
      manifest; and registry support required for Cosign's tag-addressed
      signature/attestation artifacts.
- [x] Warn that target image suffixes must not collide within the same provider
      namespace because navigation tags are deterministic per SHA.

### Registry Recipes

For each recipe, show complete provider YAML, credential acquisition, minimum
subject/attachment-tag push permissions, CI mapping, repository preparation, target-platform
pull identity, retention, and cleanup. Verify details against current official
provider documentation during implementation and link those sources.

- [x] Add a provider-neutral standards-based OCI registry recipe used by the
      disposable-registry acceptance test. The live test harness must use the
      Phase 0 project-controlled or explicitly configured trusted-TLS endpoint,
      allow only a test-only compatible endpoint override, use a
      cryptographically unique per-run repository namespace, and arrange registry
      expiration/cleanup; a plain local HTTP `registry:2` is not compatible with
      this release's no-insecure-registry contract. Do not document the harness
      override as consumer provider configuration.
- [x] Add a GitHub Container Registry recipe with protected-job permissions and
      a clear choice between the job token and a dedicated least-privilege
      token. State that Cloud Run supports public GHCR directly, while private
      GHCR requires an authenticated Artifact Registry remote repository rather
      than a runtime-service-account pull token. Explain that a publishing or
      connected repository normally has package Admin access, so its
      `GITHUB_TOKEN` may delete/restore through the preview API and is not a
      provider-enforced cleanup boundary. Contrast a PAT without
      `delete:packages`, while stating that classic PAT package scopes are not
      namespace/package scoped.
- [x] Add a Google Artifact Registry recipe covering supported username/token
      forms and short-lived identity guidance. Include an executable GitHub WIF
      exchange with `id-token: write`, exact repository/environment admission,
      a narrowly bound `roles/iam.workloadIdentityUser` publisher service
      account, and the generated access-token output mapped directly to Rush
      Delivery. Document that predefined Writer includes broad deletion
      authority, while the separate GAR Attachment resource API is not used by
      this tag-addressed Cosign mode; require a tested custom role for strict
      no-delete publication, and
      explain deterministic SHA-tag retry/cleanup effects when immutable tags
      are enabled.
- [x] Add an Amazon ECR recipe covering the `AWS` username, short-lived login
      token, repository creation, token lifetime, and Cosign artifact retention.
      Include executable GitHub OIDC configuration with `id-token: write`, the
      standard STS audience, an exact protected-environment `sub`, and a
      full-SHA-pinned credential action. Do not apply ECR's OCI reference-
      artifact lifecycle behavior or ORAS cleanup flow to `v0.8.1`; document
      retention and cleanup of the subject plus `.sig`/`.att` image tags.
- [x] Add a Docker Hub recipe using an access token and organization/user
      namespace. Distinguish PAT authentication with a personal Docker ID from
      OAT authentication with the organization name; document PAT
      Read/Write/Delete versus repository-scoped OAT Image Pull/Image Push,
      OAT product incompatibilities, and the fact that cleanup needs a separate
      owner/admin or Delete-PAT path rather than another OAT.
- [x] Label each recipe as continuously tested, manually exercised, or
      syntax-reviewed; do not imply CI coverage that does not exist.
- [x] State required registry capabilities: trusted TLS, image push, returned
      digest, Cosign signature and attestation tag storage, complete tagged and
      untagged version inventory, cleanup permissions, and deployment-platform
      pull access. State that OCI 1.1 Referrers API support is not required or
      exercised.
- [x] Do not teach `docker login` as a Rush Delivery prerequisite; explain that
      Dagger and Cosign receive selected authentication directly.

### Troubleshooting And Recovery

- [x] Organize troubleshooting by observed error, likely stage, safe first
      diagnostic, possible side effect, resolution, and retry/cleanup action.
- [x] Distinguish pre-mutation registry transport/readiness failures from
      authentication, policy, Package, signing, attestation, verification,
      manifest, and evidence failures. For an interrupted mutating operation,
      require inspection and cleanup before a manual retry; never imply that an
      automatic retry proved the first attempt had no side effect.
- [x] Cover no OCI selected with a named global input, provider `off` in live
      OCI, missing provider file, unknown provider, missing env name/value,
      actual-newline versus literal-`\n` corruption, malformed PEM, wrong
      password, mismatched public key, and protected-name collision.
- [x] Cover registry auth denial, repository permission/not-found, trusted-TLS or
      custom-CA limitation, malformed returned reference, Cosign legacy-
      attachment
      incompatibility, and deployment-platform pull denial.
- [x] Cover Grype database download/cache/freshness errors, policy rejection,
      governed ignore configuration, and changed findings between runs.
- [x] Cover publish success followed by provenance/sign/attest/verify failure,
      earlier sibling publication, later skipped targets, orphan discovery, and
      provider-specific manual cleanup links.
- [x] Cover planned manifest used live, source mismatch, repository/reference
      disagreement, missing/changed evidence, unsigned trusted-bundle limits,
      wrong restored bundle, and unavailable retained digest.
- [x] Cover Docker socket confusion: OCI operations need no host socket, while a
      legacy project deploy script may still require one.
- [x] Never recommend printing an env file, private/public key pair, password,
      registry token, Docker config, Dagger secret, or unsanitized debug trace.
- [x] Provide a sanitized diagnostic bundle checklist containing versions,
      selected target names, provider name, registry authority/repository,
      canonical digest references, failure stage, manifest with secrets absent,
      evidence hashes, and redacted logs.

### Upgrade Guide

- [x] Add a `v0.8.0` to `v0.8.1` upgrade checklist to the production guide.
- [x] State that filesystem-only consumers need no `.dagger` or credential
      additions for OCI and that a globally supplied named provider no longer
      affects a no-OCI selection. Qualify that metadata which currently shadows
      the framework-reserved namespace must rename those variables.
- [x] State that OCI package/provider field shapes and manifest-v2 shapes are
      unchanged, while unsafe cross-file provider credential projections and
      framework-reserved runtime names are newly rejected.
- [x] Tell OCI consumers to update Action/module/schema pins, search deploy
      metadata for `ARTIFACT_*`, `GIT_SHA`, and `DRY_RUN`, dedicate provider env
      names, and run provider-off plus named-provider dry runs before live use.
- [x] Explain the full-workspace evidence isolation correction and how scripts
      must use `ARTIFACT_EVIDENCE_DIR`.
- [x] Give retained-bundle operators an actionable runtime-path migration:
      bundles may not symlink `.dagger`, `.dagger/runtime`, or
      `.dagger/runtime/evidence`; rebuild with the `v0.8.1` Package producer and
      export/register the complete new bundle instead of patching, partially
      copying, or merely repacking the old artifact. Warn that live OCI
      repackaging is a new controlled publication attempt.
- [x] State that the application provider default remains `off` and the legacy
      Action Docker-socket default remains unchanged.
- [x] Describe corrected provider selection, credential isolation, key preflight,
      collision enforcement, fail-closed malformed/unknown scanner output, and
      multi-target reporting as security/reliability fixes without implying that
      released `v0.8.0` snapshots were edited.

### Phase 6 Exit Gate

- [x] The production guide separates framework guarantees from operator
      responsibilities and makes no claim that lacks an implementation test or
      a clearly labelled external trust assumption.

## Phase 7: Repair Generic Docs, Navigation, And Example Safety

- [x] Remove unconditional `application-image-provider: release` and OCI secret
      blocks from generic baseline examples in [`../README.md`](../README.md),
      [`../docs/api.md`](../docs/api.md),
      [`../docs/entrypoints.md`](../docs/entrypoints.md),
      [`../docs/workflows.md`](../docs/workflows.md),
      [`../docs/github-actions.md`](../docs/github-actions.md), both quick starts,
      tutorial chapter 09, and both website homepages.
- [x] Make every baseline either omit the application provider or explicitly use
      `off`; introduce a named provider only in a self-contained OCI section that
      already supplied package/provider metadata.
- [x] Set `docker-socket: ""` in every OCI-only Action example while preserving
      the Action metadata default and its compatibility test.
- [x] Update [`../action.yml`](../action.yml) so the `docker-socket` description
      identifies `/var/run/docker.sock` as a legacy deploy-script compatibility
      default and tells OCI-only users to set an empty value.
- [x] Update the general tutorial metadata tree and adaptation guide to include
      `.dagger/application-images` and the `oci_image` project shape.
- [x] Link the OCI tutorial, production guide, recipes, and troubleshooting from
      the README, docs index, quick starts, metadata, providers, workflows, API,
      entrypoints, GitHub Action docs, and both homepages where contextually
      useful.
- [x] Add the tutorial group and new references to
      [`../website/docs-tree.yaml`](../website/docs-tree.yaml) and
      [`../website-docusaurus/docs-tree.yaml`](../website-docusaurus/docs-tree.yaml).
- [x] Fix repository-relative AI documentation links in
      [`../docs/README.md`](../docs/README.md) so they point to
      [`../.ai/architecture.md`](../.ai/architecture.md) and
      [`../.ai/conventions.md`](../.ai/conventions.md).
- [x] Audit every internal Markdown link and both generated site navigations;
      remove or correct stale/broken paths.
- [x] Keep exact validation rules in schemas and use relative links from prose;
      do not copy large regex contracts into multiple guides.
- [x] Label snippets as runnable, sanitized output, provider-specific example, or
      illustrative pseudocode. Never present placeholders as executable values.
- [x] Correct generic runtime-file wording so deploy-platform credentials may be
      mounted there, but OCI registry tokens and Cosign material may not.
- [x] Update every current Action/module/schema version reference to `v0.8.1`
      only after `v0.8.0` docs have been frozen.

### Phase 7 Exit Gate

- [x] Filesystem-first onboarding remains safe, OCI opt-in is self-contained,
      navigation exposes one coherent learning path, and all repository links
      resolve.

## Phase 8: Version Schemas, Provenance, Sites, And Release Inputs

- [x] Update root deploy-target schema descriptions/restrictions for the
      framework-reserved environment namespace and any other schema-expressible
      correction.
- [x] Update the root package-target and package-manifest schemas for the
      schema-expressible OCI target-name, exact evidence-format, and canonical
      path corrections proven by Phase 3 tests.
- [x] Keep dynamic cross-file provider credential restrictions in the metadata
      contract and document why JSON Schema alone cannot express them.
- [x] After root schemas are final, copy every root schema into a new complete
      [`../schemas/v0.8.1`](../schemas/v0.8.1) directory and change only the
      snapshot `$id` values to immutable `v0.8.1` URLs.
- [x] Do not modify any file in [`../schemas/v0.8.0`](../schemas/v0.8.0) or an
      older versioned schema directory.
- [x] Update metadata examples, fixtures, canonical example, root docs, both
      sites, and editor hints to `schemas/v0.8.1/...`.
- [x] Update hard-coded OCI provenance `buildType` and builder identity from
      `v0.8.0` to `v0.8.1` while keeping provenance shape stable.
- [x] Update current Action and remote Dagger module examples from `v0.8.0` to
      `v0.8.1`; preserve historical versioned docs as generated.
- [x] Add `v0.8.0` to `archivedDocsVersions` in
      [`../website-docusaurus/docusaurus.config.ts`](../website-docusaurus/docusaurus.config.ts)
      when changing `currentDocsVersion` to `v0.8.1`, so the frozen version has
      the correct label, route, banner, and version dropdown entry.
- [x] Set the Docusaurus current docs version and both current website version
      displays to `v0.8.1`.
- [x] Regenerate both sites through their sync commands; do not hand-edit
      generated copies when a source/sync path exists.
- [x] Add schema snapshot tests requiring every root schema to have a matching
      `v0.8.1` file and immutable versioned `$id`.
- [x] Add version-consistency tests covering Action/module examples, homepages,
      current docs version, schema editor hints, provenance identity, and tool
      pins.
- [x] Keep the root package unversioned unless repository conventions change in
      a separate decision.

### Phase 8 Exit Gate

- [x] Root code/docs/sites/schemas all identify `v0.8.1`, released `v0.8.0`
      snapshots remain immutable, and generated artifacts match their declared
      source.

## Phase 9: Automated Documentation And Security Acceptance

### Documentation Contract Tests

- [x] Add a test that asserts generic README, quick-start, workflow, Action, API,
      tutorial, and homepage baseline snippets never select a named
      application-image provider or require OCI credentials.
- [x] Validate all canonical example YAML against both root and `v0.8.1`
      schemas.
- [x] Validate every complete planned/published/mixed manifest example against
      the public schema and runtime parser.
- [x] Parse every complete JSON/YAML example and run `bash -n` plus project shell
      lint for every complete shell script.
- [x] Exercise runnable tutorial commands or their canonical script equivalents;
      explicitly exclude and label sanitized output/pseudocode blocks.
- [x] Generate canonical complete-file snippets or byte-compare each labelled
      duplicate fenced block with its source file so documentation cannot stay
      syntactically valid while semantically drifting.
- [x] Assert the documented `ARTIFACT_*` list, deploy result fields, tool
      versions/digests, exact scan semantics, and Cosign flags match code.
- [x] Assert every public function has an intentional Dagger cache scope, every
      mutable/security-sensitive execution path receives a fresh non-secret
      cache input, and release Git auth source contains no persisted Basic header
      or token-derived file write.
- [x] Add link validation for root docs, tutorial chapters, `.ai` links, schema
      links, docs trees, and generated site routes.
- [x] Require every statement phrased as a credential, integrity, isolation, or
      side-effect guarantee to map to an automated test; otherwise rewrite it as
      an operator responsibility or limitation.

### Secret-Sentinel Acceptance

- [x] Use unique sentinel values for token, private key, password, public key,
      derived Basic-auth/Docker-config forms, plus a recognizable non-secret
      username, and capture combined stdout/stderr for success and every failure
      class. Run the secret-redaction gate with Dagger client progress silenced;
      separately lock the documented fact that unsilenced Dagger progress may
      show the non-secret username.
- [x] Prove secret sentinels do not appear in Rush Build env, Docker build context,
      image config/history/filesystem, filesystem artifacts, packaged workspace,
      Deploy env/script, npm Release container, manifest, evidence, dry-run text,
      returned JSON, normal logs, aggregate errors, or cleanup diagnostics.
- [x] Prove dry runs do not resolve or index provider sentinel entries. A
      no-env-file dry run also proves that no credential-bearing file is read.
- [x] Prove only the selected live provider's five named values are read. Prove
      token/private key/password/public key and generated Docker config are
      Dagger secrets; the username remains a non-secret Dagger registry-auth
      input and is never projected into project execution or result models.
- [x] Ensure tests compare captured bytes without printing the sentinel values on
      failure.

### End-To-End Acceptance Matrix

- [x] Filesystem-only `workflow`, `packageDeployTargets`,
      `buildAndPackageDeployTargets`, and `deployRelease` remain compatible with
      no application-provider file or credentials.
- [x] Provider-off OCI dry run succeeds without provider credentials,
      application-image build, destination-registry access, Syft/Grype/Cosign
      execution, or Docker socket. Do not assert that unrelated source, module,
      base-image, dependency, or Rush operations are globally network-free.
- [x] Named-provider OCI dry run validates the planned canonical repository and
      still avoids provider credential resolution/use and all application-image
      external operations.
- [x] Track and locally contract-test live single-target OCI acceptance against
      a trusted-TLS disposable registry and unique per-run namespace without a
      host Docker or Podman CLI, socket, or daemon. The actual project-controlled
      endpoint run is an exact-merged-candidate Phase 10 gate because GitHub can
      dispatch a newly added workflow only after it exists on the default branch.
- [x] Acceptance-harness fault injection proves transient pre-mutation
      transport recovery is bounded, exhaustion is classified, product
      security/evidence failures are never retried as infrastructure failures,
      and ambiguous post-mutation failures stop for inspection/cleanup without
      replaying the complete release flow.
- [x] Track and locally contract-test the live multi-target scenarios that prove
      the scan-before-publish barrier and ordered finalization/error reporting;
      execute them against GHCR on the exact merged candidate in Phase 10.
- [x] Track and locally contract-test key-preflight scenarios proving malformed,
      locked, invalid, and mismatched keys are expected to publish nothing;
      verify zero GHCR inventory on the exact merged candidate in Phase 10.
- [x] Reserved-env attack acceptance proves a deploy script cannot replace
      framework artifact identity or control values.
- [x] Full/partial/mixed-workspace acceptance proves target evidence isolation.
- [x] Split-stage archive/checksum/restore/deploy acceptance preserves modes and
      symlinks and proves the same digest plus independently recorded SHA cross
      the trusted bundle boundary without rebuild.
- [x] Rollback acceptance verifies a retained archive against protected external
      release metadata and deploys its digest without modifying its manifest.
- [x] OCI-only GitHub Action argument tests prove explicit empty Docker socket;
      legacy default tests prove existing Docker-dependent deploy scripts remain
      supported.

### Repository Quality Gates

- [x] Run `yarn install --frozen-lockfile` in a clean environment.
- [x] Run `npm ci --prefix website` and
      `npm ci --prefix website-docusaurus`; the site packages have independent
      frozen lockfiles and are not installed by the root Yarn command.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run site:sync-docs`, `npm run site:sync-static`,
      `npm run site:check`, and `npm run site:build`.
- [x] Run `npm run site:docusaurus:sync-docs`,
      `npm run site:docusaurus:sync-static`,
      `npm run site:docusaurus:check`, and
      `npm run site:docusaurus:build`.
- [x] Run `git diff --check`.
- [x] Run `trunk check -a -y` and resolve every task-related finding.
- [x] Confirm `dagger version` is `v0.20.7`.
- [x] Run a Dagger module load plus `dagger call ping` and
      `dagger call self-check` with the matching engine. Repeat self-check from
      tracked clean-clone input with `sdk/` absent and without first
      running `dagger develop`; the self-check itself must make its matching
      ephemeral SDK available.
- [x] Run the deterministic tests for
      [`../test/scripts/run-oci-acceptance.sh`](../test/scripts/run-oci-acceptance.sh),
      including its explicit test-only endpoint override, bounded failure
      classification, cleanup, and captured log-redaction checks. Run the actual
      project-controlled disposable trusted-TLS namespace in Phase 10.
- [x] Repeat the release-candidate verification from a clean checkout with no
      developer-only env or cached generated docs masking failures.

### Phase 9 Exit Gate

- [x] All pre-merge unit, schema, contract, docs, site, security, compatibility,
      Dagger, deterministic OCI, and live-workflow contract gates pass from a
      clean checkout, and the resulting guarantees match the written production
      guide exactly. Actual registry mutation remains the explicit pre-tag
      Phase 10 gate.

Pre-merge evidence recorded on 2026-08-05 for code/docs candidate
`2a1086c74628ecd26129e27644d48e6c5c46e757`:

- tracked Git-archive self-check with no generated SDK or installed dependencies:
  Dagger `v0.20.7`, frozen Yarn install, typecheck, and 405 tests passed;
- both documentation implementations passed sync, static-asset sync, typecheck,
  production check, and production build; the clean site installs also passed;
- Trunk checked 873 files with no remaining finding, `git diff --check` passed,
  and every current third-party production Action reference is contract-tested
  as a reviewed full commit SHA;
- Dagger Cosign-preflight and evidence-symlink engine regressions passed, and the
  real local deterministic OCI/legacy compatibility matrix passed.

No live registry result is claimed here. The tracked project-owned GHCR matrix
remains the exact merged-candidate gate below.

## Phase 10: Commit, Publish, Tag, And Verify `v0.8.1`

Do not tag or publish the release while an earlier gate is incomplete. Creating
the implementation commits, pushing the branch, and merging the reviewed
candidate are the steps that make the newly tracked live workflow available on
the default branch; they may begin after the pre-merge Phase 9 gate passes. The
exact merged candidate must then pass every deferred live gate before tagging.

### First Merged-Candidate Attempt And Corrective Gate

The first exact-merged-candidate dispatch on 2026-08-05, GitHub Actions
[run 30990272963](https://github.com/BootstrapLaboratory/rush-delivery/actions/runs/30990272963),
tested merge commit `a0843f177cbb4916db5fc94ab789d56842b453c6` and
failed both live jobs. It is diagnostic history, not release evidence, and does
not satisfy any live completion criterion below.

The retained evidence and logs established the matrix results and exposed two
independent harness defects:

- the five key-negative scenarios reached their required prepublication
  failures, independently observed zero package inventory, and completed
  namespace cleanup;
- all three multi-target fixtures failed metadata validation because their
  synthetic `matrix-worker` and `matrix-later` package/deploy targets had no
  matching Rush projects; and
- the single-target v1 artifact reported only `product-contract` and
  `not-started`; the retained GitHub Actions output did not establish the exact
  GHCR failure stage. A later controlled local non-routable-registry
  reproduction showed that `dagger --silent` suppressed the publication
  boundary and could make the v1 classifier report `not-started` after the
  boundary. That reproduction justified correcting the harness, but it is not
  retroactive proof that the failed GHCR attempt reached publication. Cleanup
  completed, and the exact GHCR stage remains unresolved until a corrected
  exact-candidate rerun passes.

A correction-branch rehearsal on 2026-08-05, GitHub Actions
[run 31000299709](https://github.com/BootstrapLaboratory/rush-delivery/actions/runs/31000299709),
tested branch commit `0fde2deca45ff17281ddd5fcff5b99e2b12e114d` and is also
diagnostic history rather than release evidence. All five key-negative scenarios
and the multi-target preparation-failure scenario passed, while the positive and
injected-finalization scenarios both stopped at the first target's allowlisted
but over-broad `cosign-publication` stage. Every scenario cleanup and the
independent recovery sweep succeeded.

The exact-stage correction-branch rehearsal on 2026-08-05, GitHub Actions
[run 31001542904](https://github.com/BootstrapLaboratory/rush-delivery/actions/runs/31001542904),
tested commit `fd1cfb238c81dba7376dd32118457633be51f76e`. The single
live path, multi-target success path, and injected-finalization path all stopped
at the first target's exact `cosign-sign` stage after subject publication. All
five key-negative scenarios and the multi-target preparation-failure scenario
passed; every cleanup and the independent recovery sweep succeeded. This is
diagnostic history, not release evidence. It narrowed the failure boundary to
the framework's first Cosign step, but did not prove that Cosign itself started
or that GHCR evaluated either bundle-storage mode.

The legacy-storage correction-branch rehearsal on 2026-08-05, GitHub Actions
[run 31003076982](https://github.com/BootstrapLaboratory/rush-delivery/actions/runs/31003076982),
tested commit `f7c40718dba657db64500f06f68af7f053e438cd`. Its single
live path, multi-target success path, and injected-finalization path again
reported the exact `cosign-sign` stage. The five key-negative scenarios and the
multi-target preparation-failure scenario passed. Cleanup for both jobs and the
matrix's independent recovery sweep succeeded. This run is also diagnostic
history rather than release evidence.

A controlled reproduction against the pinned Dagger `v0.20.7` engine then
proved the shared cause: `redirectStdout: "/dev/null"` fails before Cosign
executes with
`Error: open redirect stdout file: cannot resolve path "/dev/null"`. The exact
pinned Cosign `3.1.2` sign command succeeds without stdout redirection and with a
writable regular target at `/tmp/rush-delivery-cosign-sign.stdout`. The
correction assigns all six sign, attest, and verify stages distinct regular
`/tmp/rush-delivery-cosign-*.stdout` files in the ephemeral Cosign container;
none is exported or retained. This pre-execution defect does not change the
intentional registry-compatible legacy `.sig`/shared-`.att` storage contract,
which still requires exact live verification before release.

Complete this corrective gate before the next exact-candidate dispatch:

- [x] Give every synthetic multi-target package/deploy target a matching Rush
      project, deterministic lockfile entry, and executable no-op Rush scripts;
      exercise both corrected multi-target fixtures through real provider-off
      Dagger Package planning before any live registry call.
- [x] Capture mutating Package progress with pinned Dagger `logs` mode, retain
      only exact allowlisted stage/mutation diagnostics (including every fixed
      Cosign sign, attest, and verify stage), and regression-test that the
      progress mode exposes the controlled marker without exposing a secret
      sentinel.
- [x] Use a distinct writable regular stdout sink for each of the six registry
      Cosign commands. Keep those files inside the ephemeral Cosign container,
      never export or retain them, and regression-test the pinned Dagger engine's
      rejection of `/dev/null` alongside successful regular-file redirection.
- [ ] Treat every paginated GHCR package version, including untagged partial
      uploads and signature/attestation attachment history, as inventory. Zero and
      skipped-target assertions must require zero total versions. For completed
      targets, explicitly pin Cosign `3.1.2` legacy tag storage on publication
      and independent verification, require exactly one subject plus at least
      two non-subject package versions without using `.sig`/`.att` suffixes as
      the acceptance predicate, run real Cosign verification for the signature
      and both attestations, and retain a stable post-verification inventory
      snapshot. The current `.att` attachment contains both predicates, while a
      registry may retain additional untagged historical versions. For the injected
      post-publication fault, require exactly the failed subject and zero
      non-subject package versions so the evidence proves the hook ran before
      any Cosign finalization. Serialize the inventory ledger canonically by
      selected target and package-version ID, and do not treat IDs as a
      cross-package chronology signal.
- [x] Keep raw matrix fixtures, logs, and Package output outside the
      always-uploaded artifact tree. Promote only validated regular JSON/local
      evidence files after their own protected-value scans and cleanup; retain
      a validated non-secret disposable-namespace record before mutation.
- [x] Consume every matrix namespace record in an always-run, bounded recovery
      sweep; fail the job if absence cannot be re-proven, retain the recovery
      evidence, and explicitly include the scanned hidden `.dagger` evidence in
      the uploaded artifact.
- [x] Bound and narrow the single-target destructive cleanup hook, prove absence
      with a GitHub-host-pinned readback whose HTTP status line authoritatively
      reports `404`, classify protected-output failures only after
      conservatively deriving mutation state, and give EXIT cleanup enough job
      time to complete.
- [x] Map untrusted registry errors to fixed authentication, authorization,
      transport, or generic publication stages without retaining the original
      exception; document that every stage remains possibly mutating, and sync
      the canonical troubleshooting update into both generated sites.
- [ ] Re-run all focused and clean release-candidate gates after these
      corrections, merge them through normal review, and dispatch the live
      workflow on that new exact merge commit. Do not reuse the failed run as
      evidence and do not create the release tag before both live jobs pass.

- [x] Review the complete diff for accidental generated-file edits, secret/key
      material, unrelated scope, and changes to immutable release snapshots.
- [x] Confirm no private key, password, token, Docker config, real registry
      credential, or local exported bundle is tracked.
- [x] Commit in reviewable semantic slices: behavior/tests, canonical example,
      tutorial/production docs, and version/release preparation as appropriate.
- [x] Include compatibility/security notes in commit bodies without claiming
      transactionality, Rekor, or Deploy-time Cosign verification.
- [ ] Push the implementation branch and use the repository's normal review and
      merge flow.
- [ ] Re-run the clean release-candidate gates on the exact commit that will be
      tagged.
- [ ] Dispatch the tracked `oci-acceptance.yml` workflow on the exact merged
      release candidate. Verify both the single-target and eight-scenario GHCR
      jobs, retained non-secret diagnostics/evidence, independent inventory,
      zero-publication key/preparation failures, bounded partial-publication
      evidence, acceptance of the documented empty configuration by the pinned
      Grype image, and cleanup of every disposable namespace before tagging.
- [ ] Create annotated tag `v0.8.1` on that exact release commit and verify the
      tag target before pushing it.
- [ ] Push the `v0.8.1` tag.
- [ ] Publish a GitHub Release containing the compatibility statement, security
      corrections, OCI upgrade checklist, offline-Cosign trust model,
      multi-target/nontransactional warning, and links to the tutorial,
      production guide, recipes, and troubleshooting.
- [ ] Verify the Pages deployment and live current documentation show `v0.8.1`.
- [ ] Verify every public `schemas/v0.8.1/*.schema.json` URL returns the expected
      content and `$id`.
- [ ] Verify the remote Dagger module and GitHub Action work when pinned to
      `v0.8.1` in filesystem-only dry-run and OCI provider-off dry-run smoke
      tests. Dispatch the tracked `release-smoke.yml` workflow against the
      `v0.8.1` ref and verify all four surface/scenario matrix jobs and their
      exact head SHA.
- [ ] Verify the release tag contains the frozen `v0.8.0` docs snapshot and did
      not mutate the `v0.8.0` schema snapshot.
- [ ] Move this task to `tasks/completed` only after tag, GitHub Release, Pages,
      schema URL, Action, and remote-module verification all pass.
- [ ] Immediately before the one-time archive move, while this file is still
      active, rewrite its repository-relative `../` links for the additional
      `tasks/completed` depth and rewrite the sibling compatibility-task link
      through `../`; verify every local link after the move. Do not edit the
      completed copy afterward.
- [ ] Commit and push that final task-archive move as a post-release bookkeeping
      commit; do not move or retarget the already verified `v0.8.1` tag.

## Explicit Non-Goals

- [x] Do not add multi-platform indexes.
- [x] Do not add Docker build arguments, Docker build secrets, SSH mounts, or
      arbitrary Dockerfile target selection.
- [x] Do not add keyless/OIDC signing, configurable Rekor use, transparency-log
      publication, or trusted timestamping.
- [x] Do not add Deploy-time registry login or Cosign verification.
- [x] Do not add a signed package-bundle format or package-manifest v3.
- [x] Do not reinterpret `scan.fail_on` as a threshold.
- [x] Do not add vendor-specific deployment branches to framework source.
- [x] Do not add automatic registry deletion or claim transactional rollback.
- [x] Do not add custom-CA or insecure-registry configuration in this patch.
- [x] Do not change the GitHub Action Docker-socket compatibility default.
- [x] Do not change the Dagger engine, generated SDK contract, or tracked SDK
      policy unless a separately justified requirement is discovered and the
      full engine upgrade flow is followed. The internal self-check repair may
      generate or provision the existing matching SDK ephemerally; it must not
      hand-edit or commit generated output.
- [x] Do not add environment-selected provider coordinates, project-owned Rush
      toolchain metadata, or a repository-configurable source-exclusion API in
      this patch; each is deferred to
      [`2026-08-03-1729_RUSH_DELIVERY_DEPLOYMENT_ENVIRONMENT_COMPATIBILITY.md`](2026-08-03-1729_RUSH_DELIVERY_DEPLOYMENT_ENVIRONMENT_COMPATIBILITY.md)
      as a separate minor-release public-contract decision.
- [x] Do not edit completed task archives or any released documentation/schema
      snapshot by hand.

## Final Completion Criteria

This task is complete only when all of the following are true:

- [ ] A filesystem-only `v0.7.x` or `v0.8.0` consumer that does not shadow
      framework-reserved runtime names can pin `v0.8.1` without adding
      application-image metadata, credentials, or `.dagger` changes; any
      reserved-name rename is explicit and actionable.
- [x] A named global application provider cannot break a selected plan that has
      no OCI artifacts.
- [ ] A selected live OCI target either completes the existing verified v2
      Package contract or fails before Deploy with accurate, sanitized side
      effects.
- [x] Application-provider credentials cannot enter project Build, npm Release,
      Deploy, Docker image content, package bundle, evidence, results, or logs
      merely by selecting the application provider or through a protected
      metadata aliasing path. Separately configured framework adapters and
      deliberate same-value reuse remain the documented caller capability
      boundary.
- [x] Project metadata cannot shadow `ARTIFACT_*`, `GIT_SHA`, or `DRY_RUN`.
- [ ] Invalid, locked, or mismatched Cosign key material fails before any
      application-image build or destination-registry mutation.
- [ ] A failure in any selected filesystem package operation or OCI
      build/SBOM/scan preparation publishes none of the selected OCI targets.
- [ ] Later publication/signing failures identify every known or skipped target
      deterministically, never start Deploy, and provide safe cleanup guidance.
- [x] Full, partial, filesystem, OCI, and mixed Deploy workspaces expose no
      unrelated framework evidence.
- [x] Docs describe exact-set scan behavior, mutable vulnerability data,
      key-backed offline Cosign, Package-versus-Deploy verification, trusted
      split-stage bundles, nontransactional publication, and all `v0.8.1`
      limitations without overclaiming.
- [x] Baseline docs remain provider-off, while the OCI tutorial is complete,
      linear, executable, and backed by the same canonical example as acceptance
      tests.
- [x] Registry setup, key bootstrap, CI, inspection, deployment, split-stage
      handoff, rollback, retention, cleanup, and troubleshooting are operationally
      actionable.
- [x] Every security/integrity guarantee has an automated test and every runnable
      documentation artifact is parsed, linted, or executed.
- [ ] `dagger call self-check` passes from tracked clean-clone input without a
      pre-existing generated SDK or a manual `dagger develop`, and live OCI
      acceptance has a stable project-controlled trusted-TLS endpoint plus
      bounded, side-effect-safe retry and failure-classification tests.
- [ ] Root docs, both sites, schemas, provenance, Action/module examples, tag,
      GitHub Release, and live Pages agree on `v0.8.1`.
- [x] All `v0.8.0` and older published artifacts remain immutable.
