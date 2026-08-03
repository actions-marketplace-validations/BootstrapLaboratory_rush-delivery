#!/usr/bin/env bash
set -euo pipefail

OCI_FIXTURE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${OCI_FIXTURE_DIR}"

: "${ARTIFACT_IMAGE_REFERENCE:?ARTIFACT_IMAGE_REFERENCE is required}"
: "${ARTIFACT_IMAGE_DIGEST:?ARTIFACT_IMAGE_DIGEST is required}"
: "${ARTIFACT_EVIDENCE_DIR:?ARTIFACT_EVIDENCE_DIR is required}"

[[ ${ARTIFACT_IMAGE_REFERENCE} == *"@${ARTIFACT_IMAGE_DIGEST}" ]]
[[ ${ARTIFACT_IMAGE_DIGEST} == sha256:* ]]
[[ -z ${ARTIFACT_PATH+x} ]]
[[ -f ${ARTIFACT_EVIDENCE_DIR}/sbom.spdx.json ]]
[[ -f ${ARTIFACT_EVIDENCE_DIR}/scan.json ]]
[[ -f ${ARTIFACT_EVIDENCE_DIR}/provenance.json ]]

printf 'swarm digest handoff verified: %s\n' "${ARTIFACT_IMAGE_REFERENCE}"
