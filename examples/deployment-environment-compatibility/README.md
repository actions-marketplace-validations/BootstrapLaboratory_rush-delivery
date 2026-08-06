# Deployment Environment Compatibility Examples

These are credential-free `v0.9.1` configuration fragments for the three
opt-in contracts:

- copy `application-image-providers.yaml` to
  `.dagger/application-images/providers.yaml` and supply one coordinate profile;
- copy `rush-toolchain.yaml` to `.dagger/toolchains/rush.yaml` only when the Rush
  lifecycle requires the pinned tool; and
- copy `source-import.ignore` to `.dagger/source-import.ignore` only after
  reviewing each project path.

The plan env files contain public coordinate examples only. They intentionally
contain no registry token or signing key. Follow the
[environment-profile tutorial](../../docs/tutorial/oci-application-images/08-environment-profiles.md),
[toolchain tutorial](../../docs/tutorial/15-mixed-node-python-toolchain.md), and
[local-copy guide](../../docs/local-copy-source-imports.md) for complete use and
production gates.
