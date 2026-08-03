import * as assert from "node:assert/strict";
import { test } from "node:test";

import { rejectedVulnerabilities } from "../src/application-images/scan-policy.ts";

test("enforces normalized OCI scanner severity policy", () => {
  assert.deepEqual(
    rejectedVulnerabilities(
      {
        matches: [
          { vulnerability: { id: "CVE-CRITICAL", severity: "Critical" } },
          { vulnerability: { id: "CVE-LOW", severity: "low" } },
          { vulnerability: { id: "CVE-HIGH", severity: "HIGH" } },
          { vulnerability: { id: "CVE-HIGH", severity: "high" } },
        ],
      },
      ["critical", "high"],
    ),
    {
      count: 3,
      ids: ["CVE-CRITICAL", "CVE-HIGH"],
    },
  );
});

test("accepts a scan without policy-matching findings", () => {
  assert.deepEqual(
    rejectedVulnerabilities(
      { matches: [{ vulnerability: { id: "CVE-LOW", severity: "low" } }] },
      ["critical", "high"],
    ),
    { count: 0, ids: [] },
  );
});
