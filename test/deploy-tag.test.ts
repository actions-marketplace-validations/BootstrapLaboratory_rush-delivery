import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDeployTargetCommand,
  buildGithubDeployTagUpdateRequests,
  deployTagName,
  updateDeployTagWithGithubApi,
  updateDeployTagWithGithubApiIfConfigured,
} from "../src/stages/deploy/deploy-tag.ts";

test("builds deploy tag names from environment and target", () => {
  assert.equal(deployTagName("prod", "server"), "deploy/prod/server");
  assert.equal(deployTagName("staging", "webapp"), "deploy/staging/webapp");
});

test("builds GitHub deploy tag update requests", () => {
  const requests = buildGithubDeployTagUpdateRequests({
    gitSha: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
    repository: "BeltOrg/beltapp",
    tagName: "deploy/prod/server",
  });

  assert.deepStrictEqual(requests, {
    create: {
      body: JSON.stringify({
        ref: "refs/tags/deploy/prod/server",
        sha: "abcdef1234567890abcdef1234567890abcdef12",
      }),
      method: "POST",
      url: "https://api.github.com/repos/BeltOrg/beltapp/git/refs",
    },
    update: {
      body: JSON.stringify({
        force: true,
        sha: "abcdef1234567890abcdef1234567890abcdef12",
      }),
      method: "PATCH",
      url: "https://api.github.com/repos/BeltOrg/beltapp/git/refs/tags/deploy/prod/server",
    },
  });
});

test("fails when building GitHub deploy tag requests without a full SHA", () => {
  assert.throws(
    () =>
      buildGithubDeployTagUpdateRequests({
        gitSha: "abc123",
        repository: "BeltOrg/beltapp",
        tagName: "deploy/prod/server",
      }),
    /Git SHA must be a full 40-character SHA/,
  );
});

test("accepts a credential-free GitHub Enterprise HTTPS API base", () => {
  const requests = buildGithubDeployTagUpdateRequests({
    apiUrl: "https://github.example.com/api/v3/",
    gitSha: "abcdef1234567890abcdef1234567890abcdef12",
    repository: "BeltOrg/beltapp",
    tagName: "deploy/prod/server",
  });

  assert.equal(
    requests.update.url,
    "https://github.example.com/api/v3/repos/BeltOrg/beltapp/git/refs/tags/deploy/prod/server",
  );
});

test("rejects unsafe GitHub API bases before sending bearer credentials", () => {
  for (const apiUrl of [
    "http://api.github.test",
    "https://user:password@api.github.test",
    "https://api.github.test?mirror=attacker",
    "https://api.github.test/#fragment",
    "not a URL",
  ]) {
    assert.throws(
      () =>
        buildGithubDeployTagUpdateRequests({
          apiUrl,
          gitSha: "abcdef1234567890abcdef1234567890abcdef12",
          repository: "BeltOrg/beltapp",
          tagName: "deploy/prod/server",
        }),
      /GitHub API URL must be a credential-free HTTPS URL/,
    );
  }
});

test("creates a missing deploy tag through the GitHub API", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const calls: Array<{ body?: BodyInit | null; method?: string; url: string }> =
    [];

  console.log = () => undefined;
  globalThis.fetch = (async (input, init) => {
    calls.push({
      body: init?.body,
      method: init?.method,
      url: String(input),
    });

    return new Response("", {
      status: calls.length === 1 ? 404 : 201,
    });
  }) as typeof fetch;

  try {
    const output = await updateDeployTagWithGithubApi(
      "prod",
      "server",
      "abcdef1234567890abcdef1234567890abcdef12",
      {
        GITHUB_REPOSITORY: "BeltOrg/beltapp",
        GITHUB_TOKEN: "github-token",
      },
      "GITHUB_TOKEN",
    );

    assert.equal(
      output,
      "[deploy-release] created deploy tag deploy/prod/server\n",
    );
    assert.deepStrictEqual(
      calls.map(({ method, url }) => ({ method, url })),
      [
        {
          method: "PATCH",
          url: "https://api.github.com/repos/BeltOrg/beltapp/git/refs/tags/deploy/prod/server",
        },
        {
          method: "POST",
          url: "https://api.github.com/repos/BeltOrg/beltapp/git/refs",
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("skips deploy-tag mutation when the caller did not configure that capability", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("GitHub API must not be called");
  }) as typeof fetch;

  try {
    assert.equal(
      await updateDeployTagWithGithubApiIfConfigured(
        "prod",
        "server",
        "abcdef1234567890abcdef1234567890abcdef12",
        {},
        "",
      ),
      "",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not include a GitHub response body in deploy-tag errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const reflectedToken = "reflected-github-token";

  console.log = () => undefined;
  globalThis.fetch = (async () =>
    new Response(`Authorization: Bearer ${reflectedToken}`, {
      status: 500,
    })) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        updateDeployTagWithGithubApi(
          "prod",
          "server",
          "abcdef1234567890abcdef1234567890abcdef12",
          {
            GITHUB_REPOSITORY: "BeltOrg/beltapp",
            GITHUB_TOKEN: reflectedToken,
          },
          "GITHUB_TOKEN",
        ),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).message.includes(reflectedToken), false);
        assert.equal(
          (error as Error).message,
          "Failed to update deploy/prod/server: GitHub API returned 500.",
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("builds deploy target command from the target script only", () => {
  const command = buildDeployTargetCommand(
    "deploy/cloudrun/scripts/deploy-server.sh",
  );

  assert.equal(command, "bash deploy/cloudrun/scripts/deploy-server.sh");
});
