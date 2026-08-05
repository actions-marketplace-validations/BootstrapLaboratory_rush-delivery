# Rush Delivery Deployment Environment Compatibility

Status: planned for `v0.9.0`. Do not begin implementation until `v0.8.1` is
released and verified through
[`2026-08-05-0051_HARDEN_OCI_APPLICATION_IMAGES_AND_COMPLETE_PRODUCTION_GUIDES.md`](completed/2026-08-05-0051_HARDEN_OCI_APPLICATION_IMAGES_AND_COMPLETE_PRODUCTION_GUIDES.md).

Historical customer-requirement baseline: `BootstrapLaboratory/rush-delivery`
tag `v0.8.0`, commit `d98d666e17845a5d7089571fe7c8b256484e6a25`.

Released contract baseline: annotated tag `v0.8.1`, peeled release commit
`b90f4d7894254c58df35a39f69fe20bbf1004553`. Working baseline: post-release
bookkeeping commit `50170d07246eee554671f11e70317e2dddafa120`, which includes
the remote-smoke correction and archives the completed hardening task. All
compatibility goldens come from the immutable released tag; implementation
starts from the working baseline.

Target release: `v0.9.0`.

This task adds two opt-in public metadata contracts and one local-copy import
contract: environment-selected application image coordinates, caller-side
local-copy filtering, and project-owned Rush toolchain extension. Clean-clone
self-check and live-acceptance registry
reliability were discovered with these customer requirements but belong to the
internal `v0.8.1` hardening prerequisites; this task verifies rather than
reimplements them.

## Context

Rush Delivery `v0.8.0` introduced first-class OCI application images.
SoftwareTech's versioned deployment profiles then exposed three framework gaps:

- checked-in provider metadata cannot choose a registry authority and repository
  prefix from the selected deployment environment;
- local-copy calls may traverse large ignored dependency trees before module
  code can remove them; and
- the Rush workflow toolchain cannot acquire deterministic project-required
  tools such as a Python package manager before Rush lifecycle scripts run.

The requirements are compatible with the hardened OCI lifecycle, credential
boundary, immutable manifest handoff, and provider-off defaults planned for
`v0.8.1`. They are not patch fixes: they add metadata/schema or caller contracts
and therefore require a minor release.

## Goals

- [ ] Let one unchanged provider definition select public registry coordinates
      from the framework-owned workflow/deploy environment view.
- [ ] Keep static provider definitions valid and behaviorally identical.
- [ ] Prevent local-copy ingestion from uploading known dependency/cache trees
      while retaining Git history and built outputs wherever stages require them.
- [ ] Let a repository extend the Rush workflow toolchain deterministically
      without package-level bootstrap workarounds or credential exposure.
- [ ] Keep projects that use none of these features and do not intentionally
      transfer paths classified as disposable compatible without `.dagger`
      changes, new inputs, or changed default toolchain/cache identity. Provide
      an explicit pre-import inclusion migration for every required path that
      would otherwise match a new default exclusion.
- [ ] Version code, schemas, examples, docs, sites, provenance, Action/module
      references, release notes, and tags through the normal upgrade flow.

## Release And Compatibility Decision

- [ ] Release as `v0.9.0`; do not place the new public fields or inputs in the
      `v0.8.1` patch.
- [ ] Keep package manifests at `rush-delivery-package-manifest/v2` and preserve
      the digest-only Package-to-Deploy handoff.
- [ ] Keep `applicationImageProvider`/`application-image-provider` defaulting to
      `off` and keep the default Node-only Rush toolchain unchanged.
- [ ] Preserve every valid `v0.8.1` static `oci_registry` provider without
      migration. Additive environment-backed coordinates are opt-in.
- [ ] Preserve the signatures, static pre-import ignore decorators, and behavior
      of the existing top-level `workflow`, `validate`, and `releasePackages`
      functions. The bounded launcher uses a new additive local-source surface;
      it does not weaken or silently replace those released entrypoints.
- [ ] Treat new local-copy defaults as a documented import-boundary behavior
      change. Existing projects that intentionally transfer a matching path must
      be able to retain it through the pre-import inclusion contract; do not
      claim unconditional zero-migration compatibility for that narrow case.
- [ ] Preserve Git source-mode behavior and the GitHub Action Docker-socket
      compatibility default.
- [ ] Preserve directory/archive manifest and deploy-result shapes and behavior.
- [ ] Create a complete immutable [`../schemas/v0.9.0`](../schemas/v0.9.0)
      snapshot after root schemas are final; never edit released snapshots.
- [ ] If implementation needs a manifest-v3 contract, a provider kind, arbitrary
      project secret injection, an engine upgrade, or a signed portable bundle,
      stop and create a separate design/release task.

## Non-Negotiable Architecture

### Stage And Environment Ownership

- [ ] Detect continues to select work; Build creates compiled outputs; Package
      builds/publishes OCI images; Deploy consumes the packaged immutable digest.
- [ ] Environment-backed coordinates are Package routing inputs. Deploy must not
      reload provider metadata or resolve the current environment to reconstruct
      a repository.
- [ ] For `workflow`, resolve coordinates from the existing workflow-plus-deploy
      control-plane merge. Equal duplicates remain valid and different duplicate
      values remain an error; deploy values are not silent overrides.
- [ ] For standalone `packageDeployTargets` and
      `buildAndPackageDeployTargets`, resolve coordinates from `deployEnvFile`.
- [ ] Do not resolve coordinates from release env, project Build env, resolved
      Deploy runtime env, or runtime files. Selecting a provider does not
      automatically project coordinate values into project-controlled code.

### Provider Activation And Coordinate Resolution

- [ ] Keep raw provider metadata and resolved provider coordinates as separate
      types. Do not make static coordinate fields optional throughout downstream
      OCI code.
- [ ] Model registry authority as exactly one of `registry` or `registry_env`.
- [ ] Model repository prefix as exactly one of `repository_prefix` or
      `repository_prefix_env`.
- [ ] Repository-only validation checks known fields, XOR shape, environment-name
      syntax, and static coordinate syntax without requiring an environment file.
- [ ] Invocation validation checks selected environment values for presence,
      non-empty content, and the exact normalization rules used by static values.
- [ ] Normalize either raw form once into canonical
      `{ registry, repositoryPrefix }` coordinates before reference construction,
      preflight, build, publication, or manifest generation.
- [ ] Reject schemes, userinfo, paths in registry authorities, embedded tags or
      digests, uppercase/non-normalized repository paths, traversal, whitespace,
      control characters, and unsupported provider fields.
- [ ] Never log an invalid raw coordinate value in an error; report provider,
      coordinate role, and source environment name.

Preserve this activation table:

| Selected artifacts | Provider | Dry run | Coordinate reads | Credential reads |
| --- | --- | --- | --- | --- |
| no OCI | any value | either | none; ignore unused provider input | none |
| OCI | `off` | `true` | none; emit relative intent | none |
| OCI | named | `true` | resolve selected public coordinates | none |
| OCI | `off` | `false` | none; fail before Build/Package mutation | none |
| OCI | named | `false` | resolve selected public coordinates before Build | selected credentials only when live Package is ready |

### Coordinate And Credential Name Separation

- [ ] Treat `registry_env` and `repository_prefix_env` as public routing-input
      names, not Dagger secrets.
- [ ] Treat `username_env`, `token_env`, `signing_key_env`,
      `signing_password_env`, and `verification_key_env` as protected Package
      capability names for every declared application-image provider.
- [ ] For the selected live provider, keep token, private key, password, public
      key, and generated Docker config as Dagger secrets. Keep username as the
      framework-owned ordinary registry-auth string required by Dagger, but
      never project or log it.
- [ ] Reject either coordinate environment name when it aliases any known
      credential-capability name available to the composed invocation: every
      declared application-image provider username/token/signing name, Rush-cache
      provider username/token name, toolchain-image provider username/token name,
      npm release token name, or the configured source/deploy-tag Git token name.
      Also reject the other coordinate name in the same provider, `GIT_SHA`,
      `DRY_RUN`, and the reserved `ARTIFACT_` namespace.
- [ ] Split collision validation correctly: repository-wide metadata validation
      checks every name discoverable from repository metadata; invocation
      validation adds credential names supplied through Dagger/Action inputs.
      Validate names only and never resolve credential values to perform this
      check.
- [ ] Keep coordinate values and all credentials out of toolchain hashes,
      application image content/history, package workspaces, Deploy input,
      returned models, and errors unless a public coordinate is intentionally
      rendered as the selected planned/published repository.

### Local-Copy Import Boundary

- [ ] Introduce optional repository file `.dagger/source-import.ignore`. It uses
      ordered Git-ignore-style patterns: blank lines and `#` comments are ignored,
      ordinary patterns exclude, and a single leading `!` re-includes. UTF-8,
      LF/CRLF, and a final line without a newline are supported.
- [ ] Publish one portable Bash 4+ host-side `rush-delivery-local` launcher as a
      checksummed `v0.9.0` release asset and bundle that byte-identical file with
      the GitHub Action. Its documented host dependencies are Bash, the pinned
      Dagger CLI selected by the caller/Action, and standard POSIX file tools; it
      must not require Node, `jq`, GNU-only `realpath`, or a project install. It
      reads the repository file before opening the Dagger session and composes
      the `repo` argument through Dagger Shell `host.directory` exclude filters.
      Local and Action parsing/precedence therefore use one implementation.
- [ ] Add Action inputs `source-import-policy` (`bounded` or `legacy`, default
      `bounded`) and `source-import-ignore-file` (default
      `.dagger/source-import.ignore`). They apply only to `local_copy`; Git mode
      ignores them with one sanitized diagnostic and never reads the ignore
      file. The local launcher exposes equivalent flags and rejects contradictory
      combinations rather than silently changing source mode.
- [ ] Under `bounded`, prepend these ordered defaults before repository patterns:
      `**/node_modules`, `**/.venv`, `**/__pycache__`, `**/.rush`,
      `**/rush-logs`, `.trunk/out`, and `.trunk/logs`. Later repository `!`
      patterns may re-include an intentionally required path. `legacy` preserves
      the `v0.8.1` Directory-import behavior and is the explicit emergency escape.
- [ ] Add an additive Dagger `localSource(repo)` object with bounded variants of
      the three source-adapter entrypoints (`workflow`, `validate`, and
      `releasePackages`). Its `repo` constructor argument has no static ignore
      decorator because the caller has already constructed the filtered object.
      Factor shared implementation rather than fork workflow logic. Keep the
      released top-level entrypoints and their static ignore decorators intact;
      `legacy` invokes those existing entrypoints, while `bounded` invokes the
      new object. Required-repo standalone stage entrypoints may receive the
      composed object directly because they have no released static ignore.
- [ ] Apply bounded exclusions at Dagger context-transfer time, not only through
      post-import `Directory` filtering. The defect is not fixed if the client
      still traverses/uploads excluded trees first. Direct calls to the existing
      top-level entrypoints retain their `v0.8.1` static-filter composition;
      documentation must use the launcher whenever repository-controlled
      pre-import filtering or re-inclusion is required.
- [ ] Do not blanket-exclude `.git`. Preserve it for local-copy workflow,
      validation, release, Detect, affected-project calculation, deploy-tag
      lookup, and every entrypoint that requires repository history.
- [ ] Define an entrypoint matrix showing which inputs require Git metadata,
      source files, installed dependencies, generated outputs, packaged runtime
      evidence, and split-stage build artifacts.
- [ ] Do not blindly apply `.gitignore`: tracked/generated build outputs needed
      by split-stage Package calls must remain transferable.
- [ ] Validate repository patterns as normalized relative ignore patterns;
      reject absolute paths, parent traversal, NUL/control characters, a lone or
      repeated `!`, unsupported escapes, shell/Dagger-expression metacharacters,
      and attempts to remove mandatory contract paths. Pass patterns as data and
      never evaluate them as Bash or Dagger Shell source.
- [ ] Escape every accepted repository path, ignore-file path, and pattern into
      a Dagger Shell literal with a round-trip test; never concatenate raw
      repository text into Dagger Shell. Existing caller-controlled `extra-args`
      remains an explicitly trusted Action/CLI escape hatch and is tested
      separately from repository-owned patterns.
- [ ] Define mandatory retained paths per entrypoint and validate the filtered
      `Directory` before starting workflow work. At minimum, require `.git` for
      history-dependent local-copy entrypoints, require Rush configuration and
      the `.dagger` metadata tree, and preserve existing
      `.dagger/runtime`/package evidence for split-stage Package input. Reject a
      filtered result that removed a mandatory path; a caller-reincluded custom
      split-stage output remains an explicit project responsibility.
- [ ] Keep Git source mode unchanged because Dagger obtains the committed tree
      and full history through the existing source adapter.
- [x] Prototype outcome recorded on 2026-08-05: Dagger `v0.20.7`
      `host.directory --exclude` honors ordered Git-ignore negation, a filtered
      object can be passed through a Shell variable to a module function, and
      pinned `dagger/dagger-for-github` `v8.4.1` supports a Shell script input.
      The prototype also proved that an existing function-argument ignore
      decorator re-filters that object, which requires the additive
      `localSource(repo)` surface above. Phase 2 must still prove actual Action
      execution and excluded-tree transfer evidence. If both callers cannot be
      supported without an engine upgrade or post-import filtering, stop this
      phase and split the import feature into a separately versioned task rather
      than weakening its acceptance claim.

### Project-Owned Rush Toolchain

- [ ] Add `.dagger/toolchains/rush.yaml`, validated by new root schema
      [`../schemas/rush-toolchain.schema.json`](../schemas/rush-toolchain.schema.json).
      Require `version: rush-delivery-rush-toolchain/v1`, `base_image`,
      `platform`, and `downloads`; reject every unknown field. Do not overload
      deploy-executor metadata or hardcode customer project names.
- [ ] Require `base_image` to be an OCI image reference containing an immutable
      `sha256` digest and require `platform: linux/amd64` for this single-platform
      release. Metadata absence preserves the current mutable default Node image
      as an explicit compatibility exception; any extension must supply its own
      pinned base.
- [ ] Define `downloads` as an ordered array of typed records with exactly:
      HTTPS `url`, lowercase 64-hex `sha256`, `format` (`raw` or `tar_gz`),
      optional `archive_path` required only for `tar_gz`, absolute `destination`
      restricted to a normalized direct child of `/usr/local/bin`, and
      executable string `mode` fixed to quoted `"0755"`. Require 1-16 records,
      unique destinations, and no URL query, fragment, userinfo, redirects to
      non-HTTPS, interpolation, or credentials.
- [ ] Implement downloads through framework-owned operations: fetch bytes,
      verify SHA-256 before use, extract only the named normalized archive member
      without links/traversal, and copy it with the declared fixed mode. Do not
      expose generic exec/install steps, shells, interpreter `-c` modes,
      environment maps, package-manager commands, or arbitrary destinations in
      `v0.9.0` metadata.
- [ ] Pin every framework-owned downloader/verifier/extractor container by
      immutable digest and include those pins in repository dependency tests.
      Enforce HTTPS on the initial URL and every redirect at the transfer client;
      cap redirects, connection/transfer time, compressed bytes, and selected
      member bytes with documented framework limits; do not claim redirect
      validation from `dag.http` because Dagger `v0.20.7` does not expose the
      final redirect URL. Verify the declared byte checksum before
      extraction/copy, preflight the selected archive member, and keep download
      bytes out of module-process strings and logs.
- [ ] Project-owned toolchain construction receives no workflow/deploy host env,
      application-provider values, runtime files, or arbitrary secrets. Existing
      framework-owned toolchain registry authentication remains a separate
      explicit capability and never becomes a shell environment variable.
- [ ] Use `rush-delivery-toolchain-image/v2` for configured project toolchains and
      normalize/hash metadata version, pinned base image, platform, and every
      ordered download field. Do not hash resolved secrets or environment-specific
      OCI coordinates. Metadata absence continues to produce the exact existing
      `rush-delivery-toolchain-image/v1` normalized spec and hash.
- [ ] Define the configured-base compatibility floor explicitly: the pinned base
      must provide Linux/amd64, Bash, Node.js 24, and the Debian package tooling
      required by the existing Rush image bootstrap. Run fixed capability/version
      preflight before project downloads and document the supported pinned
      `node:24-bookworm-slim` pattern. This contract extends the Rush toolchain;
      it does not turn Rush Delivery into an arbitrary base-image builder.
- [ ] Include the resulting spec hash in the existing provider cache reference.
- [ ] When metadata is absent, prove the base image, install commands, normalized
      spec, hash, cache tag/reference, and provider-off execution are identical to
      `v0.8.1`.
- [ ] Make the resolved tools available before Rush install, Detect, Build,
      validation, Package lifecycle, and package Release operations that use the
      shared Rush workflow container.
- [ ] Apply configured metadata consistently to `workflow`, `validate`,
      `releasePackages`, standalone `detect`, `buildDeployTargets`,
      `buildAndPackageDeployTargets`, and Rush-requiring
      `packageDeployTargets`. Stage-only entrypoints without provider inputs use
      the provider-off local build; OCI-only Package must not build a Rush
      toolchain it does not need.

## Phase 0: Rebaseline And Freeze `v0.8.1`

- [x] Verify the exact `v0.8.1` tag/release commit and the later bookkeeping
      commit that archives the hardening task; record both near the top of this
      task. Verify the GitHub Release, Pages output, schemas, Action, and remote
      module from the tag.
- [x] Verify the completed hardening task was archived and that `v0.8.1`
      clean-clone self-check and trusted-registry acceptance gates pass.
- [ ] Add `v0.8.1` to the Docusaurus published-version source before modifying
      current docs, and generate frozen documentation only from the immutable tag.
- [ ] Prove generated frozen docs match `git show v0.8.1:...`; do not hand-edit
      the snapshot or any released schema directory.
- [ ] Capture static-provider reference/plan/manifest, provider-off, default
      Rush-toolchain spec/hash/cache, filesystem manifest, and local-copy behavior
      as compatibility goldens.
- [ ] Add failing focused reproductions for the three customer gaps before
      changing behavior.

### Phase 0 Exit Gate

- [ ] The released baseline is immutable and reproducible, current docs are not
      yet edited, and every intended compatibility invariant has a golden.

## Phase 1: Implement Environment-Selected Coordinates

- [ ] Update model, parser, root application-provider schema, metadata-contract
      validation, runtime resolution, reference construction, and error model from
      the raw/resolved design above.
- [ ] Preserve schema/parser parity for both XOR pairs and all invalid mixtures.
- [ ] Thread only the canonical resolved coordinates through planning and live
      Package; do not spread four optional raw fields into downstream code.
- [ ] Keep hardening validation order: no-OCI ignores providers; selected named
      dry run reads only coordinates; live credentials remain deferred.
- [ ] Ensure publication, signatures, attestations, evidence, manifest, returned
      result, and cleanup diagnostics use the same canonical repository.
- [ ] Preserve exact static-provider output with golden tests.

### Phase 1 Exit Gate

- [ ] One provider definition selects two valid environment-specific repositories
      without source edits, while static/no-OCI/provider-off behavior and the
      hardened credential boundary remain unchanged.

## Phase 2: Implement Bounded Local-Copy Ingestion

- [ ] Prototype and freeze the exact Dagger Shell `host.directory` composition,
      launcher arguments, ignore-file grammar, Action inputs, pattern ordering,
      quoting, mandatory-path checks, output/trace behavior, and error messages.
      Commit any required task amendment before feature code.
- [ ] Keep the composite Action on the pinned `dagger/dagger-for-github`
      `v8.4.1` implementation unless a separately justified dependency update is
      required. For bounded local copy, make `prepare-workflow.sh` emit the
      launcher's generated Dagger Shell script and pass it through the pinned
      Action's supported `shell` input; preserve output and trace URL contracts.
      Git source mode and `legacy` local copy retain the existing `call` path.
- [ ] Implement one shared parser/composer used by the release-asset local
      launcher and Action wrapper; do not maintain two subtly different pattern
      engines.
- [ ] Apply the bounded defaults, repository exclusions, and later re-inclusions
      in the specified order before constructing the `repo` Directory.
- [ ] Keep post-import cleanup only as defense in depth; do not use it as proof of
      bounded host traversal.
- [ ] Add fixtures with large ignored virtual environments, nested caches,
      intentionally tracked similarly named directories, Git history/tags, and
      required generated build outputs.
- [ ] Instrument the caller/import boundary and prove excluded paths are not
      traversed or transferred, rather than merely absent from the final container.
- [ ] Prove `legacy` exactly preserves raw `v0.8.1` local-copy behavior and that
      Git source mode does not consult local-copy patterns.
- [ ] Prove existing direct top-level `dagger call` invocations retain their
      released static ignore behavior, and prove bounded re-inclusion survives
      the new `localSource(repo)` boundary instead of being removed by a second
      filter.

### Phase 2 Exit Gate

- [ ] Long-lived local workspaces transfer a bounded context, history-dependent
      plans still work, and split-stage artifacts are neither silently excluded
      nor rebuilt.

## Phase 3: Implement The Project Toolchain Contract

- [ ] Add the versioned metadata parser/schema and reject unsafe or unknown input
      before creating a container or contacting a provider.
- [ ] Build the normalized spec and cache identity from every declared input.
- [ ] Fetch, checksum, extract when required, and install typed downloads through
      framework-owned operations without project-supplied commands, implicit
      interpolation, or raw environment projection.
- [ ] Preserve existing provider-off and provider-backed pull/build/publish
      policies and missing-image/authentication error classification.
- [ ] Add a Node/Python fixture using a digest- and checksum-pinned toolchain that
      makes its Python package manager available before Rush lifecycle scripts.
- [ ] Add unique application-provider credential sentinels and prove none enters
      toolchain input, downloads, image config/history/filesystem, hash,
      cache reference, logs, or errors.

### Phase 3 Exit Gate

- [ ] The mixed-language fixture works with provider off and with toolchain image
      caching, while an unconfigured project retains the exact `v0.8.1` toolchain.

## Phase 4: Version Schemas And Release Inputs

- [ ] Update root application-provider metadata for coordinate XOR fields and add
      root Rush-toolchain metadata plus any source-import editor contract that is
      schema-expressible.
- [ ] After root schemas are final, copy every root schema into
      [`../schemas/v0.9.0`](../schemas/v0.9.0) and change only snapshot `$id`
      values to immutable `v0.9.0` URLs.
- [ ] Add schema-snapshot tests requiring every root schema to have an exact
      `v0.9.0` counterpart and never modify `v0.8.1` or older snapshots.
- [ ] Update provenance builder identity, current Action/module/schema references,
      both site version displays, and Docusaurus current/archive configuration to
      `v0.9.0`; preserve the frozen `v0.8.1` docs generated in Phase 0.
- [ ] Add repository-wide version-consistency tests before documentation
      acceptance consumes the new snapshot.

### Phase 4 Exit Gate

- [ ] Root and `v0.9.0` schemas agree, all current release inputs identify
      `v0.9.0`, and every `v0.8.1` or older artifact remains unchanged.

## Phase 5: Documentation, Tutorial, And Upgrade Guidance

- [ ] Add an environment-profile tutorial showing one unchanged provider YAML,
      staging/production env files containing only names/sample public values,
      named dry runs, live publication, manifest inspection, and digest deployment.
- [ ] Clearly label registry coordinates public and credential values protected;
      never place real credentials or private keys in examples.
- [ ] Document workflow/deploy overlay conflict behavior and standalone Package
      environment ownership.
- [ ] Document local-copy default exclusions, the caller-side extension syntax,
      mandatory retained paths, inclusion escape, Git-mode differences, and
      performance verification.
- [ ] Add a separate mixed Node/Python toolchain tutorial with pinned inputs,
      checksum verification, cache behavior, update procedure, and failure modes.
- [ ] Update API, entrypoints, workflows, metadata, provider, Action, tutorial,
      production, troubleshooting, README, docs index, and both site navigation
      sources without duplicating schema regexes in prose.
- [ ] Add a `v0.8.1` to `v0.9.0` upgrade guide stating that static providers and
      default-toolchain projects require no migration, documenting the narrow
      local-copy inclusion/`legacy` escape, and listing every new field/input and
      the checksummed local-launcher installation/update path.
- [ ] Generate both sites through their sync commands; do not hand-edit generated
      copies when a source path exists.

### Phase 5 Exit Gate

- [ ] A new operator can configure both deployment profiles and a mixed-language
      toolchain without guessing environment ownership, security boundaries,
      import behavior, or cache invalidation.

## Phase 6: Tests And Release Acceptance

### Contract And Compatibility Tests

- [ ] Schema/parser tests cover static, environment-backed, mixed/conflicting,
      missing, empty, malformed, unknown, and aliasing coordinate definitions.
- [ ] Exercise all four valid coordinate combinations: static/static reads zero
      coordinate env values, static/env and env/static each read one, and env/env
      reads two. Every named dry run reads zero credential values.
- [ ] No-OCI tests prove provider metadata and coordinate/credential values are
      not read even when a named global provider input is malformed.
- [ ] Explicit repository metadata validation parses every provider and reports
      XOR, syntax, unknown-field, and repository-discoverable alias errors even
      though no-OCI execution intentionally ignores an unused malformed file.
- [ ] Provider-off dry runs read no provider data; named dry runs read exactly
      the coordinate env values required by their selected raw form and none of
      the five credential values.
- [ ] Live tests prove the resolved repository is exactly the published,
      signed/attested, evidenced, manifested, returned, and cleanup repository.
- [ ] Cross-provider alias tests prove a coordinate cannot expose another
      provider's username/token/key/password/public-key value. Invocation tests
      cover source, deploy-tag, Rush-cache, toolchain-provider, and npm credential
      names without resolving any credential value during alias validation.
- [ ] Use unique public-coordinate sentinels and assert their only allowed
      appearances are the planned/published canonical repository, related
      evidence/manifest/result fields, and sanitized repository diagnostics.
      Prove they do not enter project Build/Deploy env, toolchain spec/hash/cache,
      image config/history/filesystem, unrelated workspace files, or credentials.
- [ ] Two environment profiles over the same source prove repository selection
      changes while source/digest and provenance rules remain deterministic.
- [ ] Static-provider and default-toolchain goldens remain byte-for-byte stable.
- [ ] Local-copy tests cover every entrypoint matrix row, retained Git history,
      ignored/unignored names, import bounds, escape behavior, and split-stage
      outputs; Git source-mode goldens remain unchanged.
- [ ] Toolchain tests cover v1 metadata parsing, v2 spec normalization/hash
      sensitivity, ordered downloads, pinned base/platform enforcement, HTTPS and
      redirect rules, raw/tar extraction, archive traversal/link rejection,
      checksum failure before installation, unique safe destinations, unknown
      fields, provider policies, auth-vs-miss errors, and credential isolation.
- [ ] Entry-point tests prove each Rush-using workflow/stage receives the custom
      toolchain before its first Rush command, while no-Rush Package and
      no-metadata calls preserve their prior execution graph.

### Documentation And Repository Gates

- [ ] Validate all new YAML/JSON examples against root and `v0.9.0` schemas and
      parse/lint/execute every complete documented script or command path.
- [ ] Run `yarn install --frozen-lockfile`, `yarn typecheck`, and `yarn test`.
- [ ] Run both site sync/check/build pipelines, link validation, `git diff --check`,
      and `trunk check -a -y`.
- [ ] Confirm Dagger CLI/module engine alignment, then run module load, `ping`,
      clean-clone `self-check`, provider-off acceptance, static-provider
      acceptance, dynamic-coordinate live acceptance, local-copy ingestion
      acceptance, and provider-backed mixed-toolchain acceptance.
- [ ] Repeat the release-candidate gates from a clean checkout without local SDK,
      dependency, generated-doc, toolchain, or registry cache state masking defects.

### Phase 6 Exit Gate

- [ ] Code, schema, tests, examples, docs, sites, and runtime behavior enforce one
      contract, and all compatibility/security claims have automated evidence.

## Phase 7: Publish, Tag, And Verify `v0.9.0`

Do not begin this phase while an earlier checkbox or exit gate is incomplete.

- [ ] Review for unrelated changes, credentials, mutable pins, generated-file
      mistakes, and changes to `v0.8.1` or older immutable artifacts.
- [ ] Build the local launcher release asset reproducibly, publish its SHA-256 in
      the release, and verify the Action-bundled and release-asset implementations
      are generated from or byte-match the same source.
- [ ] Generalize the released-consumer smoke workflow before the release
      candidate: make the target ref and expected peeled commit explicit dispatch
      inputs, fail on a mismatch, and cover the `v0.9.0` Action, remote module,
      bounded local launcher, and opt-out compatibility paths. Do not require a
      post-tag source commit merely to hard-code a SHA that was unknowable in the
      release candidate.
- [ ] Commit in semantic, reviewable slices; push the implementation branch and
      follow the repository's normal review/merge flow.
- [ ] Re-run every release-candidate gate on the exact merged release commit.
- [ ] Create and push annotated tag `v0.9.0` on that commit and publish a GitHub
      Release with compatibility, upgrade, examples, limitations, and recovery
      links.
- [ ] Verify Pages, every public `schemas/v0.9.0` URL, the remote Dagger module,
      and the GitHub Action from the tag.
- [ ] Move this task to `tasks/completed` only after every remote verification
      passes; commit/push that archive move without retargeting the tag.

## Explicit Non-Goals

- [ ] Do not add another artifact/provider kind or package-manifest version.
- [ ] Do not move OCI publication or provider resolution into Deploy.
- [ ] Do not expose arbitrary host environment or secrets to custom toolchain
      steps.
- [ ] Do not support arbitrary shell scripts as toolchain metadata.
- [ ] Do not make `.gitignore` the implicit framework source contract or remove
      Git history from entrypoints that require it.
- [ ] Do not add insecure registries, custom CA configuration, automatic OCI
      cleanup, keyless signing, Rekor, or transactional publication claims.
- [ ] Do not change the Dagger engine or edit generated SDK files by hand.
- [ ] Do not edit released documentation/schema snapshots or completed tasks.

## Final Completion Criteria

- [ ] Existing static-provider, provider-off, filesystem-only, and default
      Node-toolchain projects that do not intentionally transfer a newly excluded
      disposable path can upgrade from `v0.8.1` without configuration changes or
      cache churn; affected local-copy users have a tested inclusion or `legacy`
      migration.
- [ ] One unchanged provider definition publishes through two deployment-selected
      registry coordinates while credentials remain isolated and Deploy uses only
      the packaged digest.
- [ ] Local-copy calls avoid excluded dependency/cache traversal without breaking
      Git planning or split-stage output handoff.
- [ ] A mixed Node/Python repository deterministically extends the shared Rush
      toolchain without package bootstrap workarounds or credential exposure.
- [ ] Root docs, both sites, schemas, examples, provenance, Action/module pins,
      release tag, GitHub Release, and Pages agree on `v0.9.0`.
- [ ] All released `v0.8.1` and older artifacts remain immutable.
