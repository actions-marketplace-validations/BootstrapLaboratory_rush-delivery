import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseGrypeReport,
  rejectedVulnerabilities,
} from "../src/application-images/scan-policy.ts";

const highAndCriticalReport = {
  matches: [
    { vulnerability: { id: "CVE-CRITICAL", severity: "Critical" } },
    { vulnerability: { id: "CVE-HIGH", severity: "HIGH" } },
  ],
};

test("treats scan fail_on as an exact normalized severity set", () => {
  assert.deepEqual(rejectedVulnerabilities(highAndCriticalReport, ["high"]), {
    count: 1,
    ids: ["CVE-HIGH"],
  });
  assert.deepEqual(
    rejectedVulnerabilities(highAndCriticalReport, ["critical"]),
    { count: 1, ids: ["CVE-CRITICAL"] },
  );
  assert.deepEqual(
    rejectedVulnerabilities(highAndCriticalReport, ["critical", "high"]),
    { count: 2, ids: ["CVE-CRITICAL", "CVE-HIGH"] },
  );
});

test("normalizes every supported scanner severity", () => {
  assert.deepEqual(
    parseGrypeReport({
      matches: [
        { vulnerability: { id: "C", severity: " CRITICAL " } },
        { vulnerability: { id: "H", severity: "High" } },
        { vulnerability: { id: "M", severity: "MEDIUM" } },
        { vulnerability: { id: "L", severity: "low" } },
        { vulnerability: { id: "N", severity: "Negligible" } },
      ],
    }).matches.map(({ vulnerability }) => vulnerability.severity),
    ["critical", "high", "medium", "low", "negligible"],
  );
});

test("accepts an explicit empty Grype matches array", () => {
  assert.deepEqual(rejectedVulnerabilities({ matches: [] }, ["high"]), {
    count: 0,
    ids: [],
  });
});

test("rejects absent or non-array Grype matches", () => {
  assert.throws(
    () => parseGrypeReport({}),
    /invalid scanner output: "matches" must be an array/,
  );
  assert.throws(
    () => parseGrypeReport({ matches: {} }),
    /invalid scanner output: "matches" must be an array/,
  );
});

test("rejects malformed vulnerability entries and missing IDs", () => {
  assert.throws(
    () => parseGrypeReport({ matches: [{}] }),
    /matches\[0\]\.vulnerability must be an object/,
  );
  assert.throws(
    () =>
      parseGrypeReport({
        matches: [{ vulnerability: { severity: "high" } }],
      }),
    /vulnerability\.id must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseGrypeReport({
        matches: [{ vulnerability: { id: " ", severity: "high" } }],
      }),
    /vulnerability\.id must be a non-empty string/,
  );
});

test("rejects missing and unsupported severities", () => {
  assert.throws(
    () =>
      parseGrypeReport({
        matches: [{ vulnerability: { id: "CVE-MISSING" } }],
      }),
    /vulnerability\.severity must be a supported string/,
  );
  assert.throws(
    () =>
      parseGrypeReport({
        matches: [
          { vulnerability: { id: "CVE-UNKNOWN", severity: "Unknown" } },
        ],
      }),
    /vulnerability\.severity "Unknown" is unsupported/,
  );
});
