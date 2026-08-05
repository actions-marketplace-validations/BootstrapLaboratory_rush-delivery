import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseRushToolchain } from "../src/rush-toolchain/parse.ts";
import {
  CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION,
  hashToolchainImageSpec,
  normalizeToolchainImageSpec,
  rushToolchainImageSpec,
  TOOLCHAIN_IMAGE_SPEC_VERSION,
} from "../src/toolchain-images/spec.ts";
import {
  RUSH_TOOLCHAIN_CONNECT_TIMEOUT_SECONDS,
  RUSH_TOOLCHAIN_MAX_DOWNLOAD_BYTES,
  RUSH_TOOLCHAIN_MAX_REDIRECTS,
  RUSH_TOOLCHAIN_TRANSFER_IMAGE,
  RUSH_TOOLCHAIN_TRANSFER_TIMEOUT_SECONDS,
} from "../src/rush-toolchain/constants.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(testDirectory, "fixtures/rush-toolchain.yaml");
const baseImage =
  "node:24-bookworm-slim@sha256:65932751ed4073ed02f5c04e494e4b2572a891b7dbea0568a863dc80341bf848";
const uvSha256 =
  "d66e96b5f1ca3b99806eee283a8125d33a0bd669e6e6d9bc4ab7ffda63c41bf4";

test("parses a strict digest-pinned Rush toolchain extension", async () => {
  assert.deepEqual(parseRushToolchain(await readFile(fixturePath, "utf8")), {
    base_image: baseImage,
    downloads: [
      {
        archive_path: "uv-x86_64-unknown-linux-gnu/uv",
        destination: "/usr/local/bin/uv",
        format: "tar_gz",
        mode: "0755",
        sha256: uvSha256,
        url: "https://github.com/astral-sh/uv/releases/download/0.12.2/uv-x86_64-unknown-linux-gnu.tar.gz",
      },
    ],
    platform: "linux/amd64",
    version: "rush-delivery-rush-toolchain/v1",
  });
});

test("rejects mutable bases, unsafe downloads, and generic execution fields", async () => {
  const fixture = await readFile(fixturePath, "utf8");
  for (const [replacement, pattern] of [
    ["node:24-bookworm-slim", /base_image must be a normalized OCI reference/],
    ["platform: linux/arm64", /platform must be "linux\/amd64"/],
    ["url: http://example.test/tool", /must be an HTTPS URL/],
    ["url: https://user@example.test/tool", /without userinfo/],
    ["url: https://example.test/tool?token=value", /without userinfo/],
    ["sha256: ABCD", /64 lowercase hexadecimal/],
    ["archive_path: ../uv", /normalized relative archive member/],
    ["destination: /usr/local/lib/uv", /direct child of \/usr\/local\/bin/],
    ['mode: "0777"', /mode must be the string "0755"/],
    ["    command: curl", /unsupported field: command/],
  ] as const) {
    const source = replacement.startsWith("node:")
      ? fixture.replace(/^base_image:.*$/mu, `base_image: ${replacement}`)
      : replacement.startsWith("platform:")
        ? fixture.replace(/^platform:.*$/mu, replacement)
        : replacement.startsWith("url:")
          ? fixture.replace(/^  - url:.*$/mu, `  - ${replacement}`)
          : replacement.startsWith("sha256:")
            ? fixture.replace(/^    sha256:.*$/mu, `    ${replacement}`)
            : replacement.startsWith("archive_path:")
              ? fixture.replace(/^    archive_path:.*$/mu, `    ${replacement}`)
              : replacement.startsWith("destination:")
                ? fixture.replace(/^    destination:.*$/mu, `    ${replacement}`)
                : replacement.startsWith("mode:")
                  ? fixture.replace(/^    mode:.*$/mu, `    ${replacement}`)
                  : fixture.replace(/^    mode:.*$/mu, "$&\n" + replacement);

    assert.throws(() => parseRushToolchain(source), pattern);
  }
});

test("requires archive_path only for tar_gz and unique destinations", async () => {
  const fixture = await readFile(fixturePath, "utf8");
  assert.throws(
    () => parseRushToolchain(fixture.replace(/^    archive_path:.*\n/mu, "")),
    /archive_path is required exactly/,
  );
  assert.equal(
    parseRushToolchain(
      fixture
        .replace("format: tar_gz", "format: raw")
        .replace(/^    archive_path:.*\n/mu, ""),
    ).downloads[0].archive_path,
    undefined,
  );
  assert.throws(
    () =>
      parseRushToolchain(
        `${fixture}${fixture.slice(fixture.indexOf("  - url:"))}`,
      ),
    /destination.+must be unique/,
  );
});

test("configured v2 specs hash every ordered project input while absence stays v1", async () => {
  const definition = parseRushToolchain(await readFile(fixturePath, "utf8"));
  const defaultSpec = rushToolchainImageSpec("node:24-bookworm-slim", [
    "apt-get update",
  ]);
  const configured = rushToolchainImageSpec("ignored", ["apt-get update"], definition);

  assert.equal(defaultSpec.version, TOOLCHAIN_IMAGE_SPEC_VERSION);
  assert.deepEqual(normalizeToolchainImageSpec(defaultSpec), {
    base_image: "node:24-bookworm-slim",
    env: {},
    install: ["apt-get update"],
    kind: "rush",
    name: "workflow",
    version: TOOLCHAIN_IMAGE_SPEC_VERSION,
  });
  assert.equal(
    configured.version,
    CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION,
  );
  assert.deepEqual(normalizeToolchainImageSpec(configured), {
    base_image: baseImage,
    downloads: definition.downloads,
    env: {},
    install: ["apt-get update"],
    kind: "rush",
    name: "workflow",
    platform: "linux/amd64",
    version: CONFIGURED_RUSH_TOOLCHAIN_IMAGE_SPEC_VERSION,
  });

  for (const changed of [
    { ...configured, baseImage: configured.baseImage.replace("node", "library/node") },
    { ...configured, platform: undefined },
    {
      ...configured,
      downloads: configured.downloads?.map((download) => ({
        ...download,
        sha256: "a".repeat(64),
      })),
    },
  ]) {
    assert.notEqual(hashToolchainImageSpec(configured), hashToolchainImageSpec(changed));
  }

  const first = configured.downloads![0];
  const second = { ...first, destination: "/usr/local/bin/uvx" };
  assert.notEqual(
    hashToolchainImageSpec({ ...configured, downloads: [first, second] }),
    hashToolchainImageSpec({ ...configured, downloads: [second, first] }),
  );
});

test("download implementation pins transfer identity and strict resource bounds", async () => {
  assert.match(RUSH_TOOLCHAIN_TRANSFER_IMAGE, /@sha256:[a-f0-9]{64}$/u);
  assert.equal(RUSH_TOOLCHAIN_MAX_REDIRECTS, 5);
  assert.equal(RUSH_TOOLCHAIN_CONNECT_TIMEOUT_SECONDS, 30);
  assert.equal(RUSH_TOOLCHAIN_TRANSFER_TIMEOUT_SECONDS, 300);
  assert.equal(RUSH_TOOLCHAIN_MAX_DOWNLOAD_BYTES, 256 * 1024 * 1024);

  const source = await readFile(
    path.join(testDirectory, "../src/rush-toolchain/build.ts"),
    "utf8",
  );
  assert.match(source, /--proto '=https' --proto-redir '=https'/u);
  assert.match(source, /--max-redirs/u);
  assert.match(source, /--connect-timeout/u);
  assert.match(source, /--max-time/u);
  assert.match(source, /--max-filesize/u);
  assert.ok(source.indexOf("sha256sum") < source.indexOf("tar -tzf"));
  assert.match(source, /archive member must be a regular file/u);
  assert.ok(
    source.indexOf("archive member exceeds the byte limit") <
      source.indexOf("tar -xzf"),
  );
  assert.match(source, /\[ ! -f "\$selected" \] \|\| \[ -L "\$selected" \]/u);
  assert.match(source, /command -v apt-get/u);
  assert.match(source, /node --version.+\^v24/u);
});
