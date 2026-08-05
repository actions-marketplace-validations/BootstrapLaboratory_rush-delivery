import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCiPlan,
  formatCiPlan,
  parseCiPlan,
} from "../src/ci-plan/parse-ci-plan.ts";

test("parses canonical CI plan handoff", () => {
  assert.deepStrictEqual(
    parseCiPlan(`{
      "mode": "release",
      "pr_base_sha": "",
      "affected_projects_by_deploy_target": {
        "server": ["server"],
        "webapp": ["webapp"]
      },
      "validate_targets": [],
      "deploy_targets": ["server", "webapp"],
      "release_targets": ["npm"]
    }`),
    {
      affected_projects_by_deploy_target: {
        server: ["server"],
        webapp: ["webapp"],
      },
      deploy_targets: ["server", "webapp"],
      mode: "release",
      pr_base_sha: "",
      release_targets: ["npm"],
      validate_targets: [],
    },
  );
});

test("parses old CI plan handoff without release targets", () => {
  assert.deepStrictEqual(
    parseCiPlan(`{
      "mode": "release",
      "pr_base_sha": "",
      "affected_projects_by_deploy_target": {},
      "validate_targets": [],
      "deploy_targets": []
    }`),
    {
      affected_projects_by_deploy_target: {},
      deploy_targets: [],
      mode: "release",
      pr_base_sha: "",
      release_targets: [],
      validate_targets: [],
    },
  );
});

test("fails when deploy targets are malformed", () => {
  assert.throws(
    () =>
      parseCiPlan(`{
        "mode": "release",
        "pr_base_sha": "",
        "affected_projects_by_deploy_target": {},
        "validate_targets": [],
        "deploy_targets": ["server", 42]
      }`),
    /CI plan field "deploy_targets" must contain only strings\./,
  );
});

test("stably deduplicates target arrays before a target can run twice", () => {
  const ciPlan = parseCiPlan(`{
    "mode": "release",
    "pr_base_sha": "",
    "affected_projects_by_deploy_target": {},
    "validate_targets": ["lint", "test", "lint"],
    "deploy_targets": ["server", "webapp", "server"],
    "release_targets": ["npm", "container", "npm"]
  }`);

  assert.deepEqual(ciPlan.validate_targets, ["lint", "test"]);
  assert.deepEqual(ciPlan.deploy_targets, ["server", "webapp"]);
  assert.deepEqual(ciPlan.release_targets, ["npm", "container"]);
});

test("fails when mode is unsupported", () => {
  assert.throws(
    () =>
      parseCiPlan(`{
        "mode": "manual",
        "pr_base_sha": "",
        "affected_projects_by_deploy_target": {},
        "validate_targets": [],
        "deploy_targets": []
      }`),
    /CI plan field "mode" must be either "pull_request" or "release"\./,
  );
});

test("creates and formats canonical CI plan handoff JSON", () => {
  const ciPlan = createCiPlan({
    affectedProjectsByDeployTarget: {
      server: ["api-contract", "server"],
    },
    deployTargets: ["server"],
    mode: "release",
    prBaseSha: "",
    releaseTargets: ["npm"],
    validateTargets: [],
  });

  assert.deepStrictEqual(JSON.parse(formatCiPlan(ciPlan)), {
    affected_projects_by_deploy_target: {
      server: ["api-contract", "server"],
    },
    deploy_targets: ["server"],
    mode: "release",
    pr_base_sha: "",
    release_targets: ["npm"],
    validate_targets: [],
  });
});
