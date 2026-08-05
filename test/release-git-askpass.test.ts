import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { releaseGitAskpassScript } from "../src/stages/release/git-askpass.ts";

test("release Git askpass reads credentials from process env without embedding them", async () => {
  const username = "release-user";
  const token = "release-token-sentinel";
  const script = releaseGitAskpassScript(
    "RUSH_DELIVERY_RELEASE_GIT_USERNAME",
    "RUSH_DELIVERY_RELEASE_GIT_TOKEN",
  );

  assert.equal(script.includes(username), false);
  assert.equal(script.includes(token), false);

  const tempDirectory = await mkdtemp(path.join(tmpdir(), "rd-askpass-"));
  const scriptPath = path.join(tempDirectory, "askpass.sh");

  try {
    await writeFile(scriptPath, script, "utf8");
    await chmod(scriptPath, 0o500);

    const env = {
      ...process.env,
      RUSH_DELIVERY_RELEASE_GIT_TOKEN: token,
      RUSH_DELIVERY_RELEASE_GIT_USERNAME: username,
    };

    assert.equal(
      execFileSync(scriptPath, ["Username for repository"], {
        encoding: "utf8",
        env,
      }),
      `${username}\n`,
    );
    assert.equal(
      execFileSync(scriptPath, ["Password for repository"], {
        encoding: "utf8",
        env,
      }),
      `${token}\n`,
    );

    const releaseSource = await readFile(
      path.join(process.cwd(), "src/stages/release/release-packages.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      releaseSource,
      /extraheader|AUTHORIZATION: basic|base64/u,
    );
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});

test("release Git askpass rejects unsafe env names", () => {
  assert.throws(
    () => releaseGitAskpassScript("SAFE_NAME", "unsafe-name"),
    /Release Git token env name is invalid/,
  );
});
