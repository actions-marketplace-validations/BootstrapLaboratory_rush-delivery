import { parse as parseYaml } from "yaml";

import { assertKnownKeys } from "../metadata/parse-utils.ts";
import type {
  RushToolchainDefinition,
  RushToolchainDownload,
  RushToolchainDownloadFormat,
} from "../model/rush-toolchain.ts";

const BASE_IMAGE_PATTERN =
  /^(?:[a-z0-9][a-z0-9._-]*(?::[1-9][0-9]{0,4})?\/)*(?:[a-z0-9][a-z0-9._-]*)(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;
const DESTINATION_PATTERN = /^\/usr\/local\/bin\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function parseRequiredString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return rawValue;
}

function parseDownloadFormat(
  rawValue: unknown,
  name: string,
): RushToolchainDownloadFormat {
  const value = parseRequiredString(rawValue, name);
  if (value !== "raw" && value !== "tar_gz") {
    throw new Error(`${name} must be "raw" or "tar_gz".`);
  }
  return value;
}

function parseHttpsUrl(rawValue: unknown, name: string): string {
  const value = parseRequiredString(rawValue, name);
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      `${name} must be an HTTPS URL without userinfo, query, or fragment.`,
    );
  }

  return value;
}

function parseArchivePath(rawValue: unknown, name: string): string {
  const value = parseRequiredString(rawValue, name);
  const segments = value.split("/");

  if (
    value.startsWith("/") ||
    value.startsWith("-") ||
    value.includes("\\") ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`${name} must be a normalized relative archive member.`);
  }

  return value;
}

function parseDownload(rawValue: unknown, index: number): RushToolchainDownload {
  const name = `Rush toolchain download ${index}`;
  if (
    typeof rawValue !== "object" ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw new Error(`${name} must be a mapping.`);
  }

  assertKnownKeys(
    rawValue as Record<string, unknown>,
    ["archive_path", "destination", "format", "mode", "sha256", "url"],
    name,
  );
  const format = parseDownloadFormat(
    "format" in rawValue ? rawValue.format : undefined,
    `${name} format`,
  );
  const hasArchivePath = "archive_path" in rawValue;

  if ((format === "tar_gz") !== hasArchivePath) {
    throw new Error(
      `${name} archive_path is required exactly when format is "tar_gz".`,
    );
  }

  const destination = parseRequiredString(
    "destination" in rawValue ? rawValue.destination : undefined,
    `${name} destination`,
  );
  if (!DESTINATION_PATTERN.test(destination)) {
    throw new Error(
      `${name} destination must be a normalized direct child of /usr/local/bin.`,
    );
  }

  const mode = parseRequiredString(
    "mode" in rawValue ? rawValue.mode : undefined,
    `${name} mode`,
  );
  if (mode !== "0755") {
    throw new Error(`${name} mode must be the string "0755".`);
  }

  const sha256 = parseRequiredString(
    "sha256" in rawValue ? rawValue.sha256 : undefined,
    `${name} sha256`,
  );
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`${name} sha256 must be 64 lowercase hexadecimal digits.`);
  }

  return {
    ...(hasArchivePath
      ? { archive_path: parseArchivePath(rawValue.archive_path, `${name} archive_path`) }
      : {}),
    destination,
    format,
    mode,
    sha256,
    url: parseHttpsUrl(
      "url" in rawValue ? rawValue.url : undefined,
      `${name} url`,
    ),
  };
}

export function parseRushToolchain(contents: string): RushToolchainDefinition {
  const parsedValue = parseYaml(contents);
  if (
    typeof parsedValue !== "object" ||
    parsedValue === null ||
    Array.isArray(parsedValue)
  ) {
    throw new Error("Rush toolchain metadata must define a top-level mapping.");
  }

  assertKnownKeys(
    parsedValue as Record<string, unknown>,
    ["base_image", "downloads", "platform", "version"],
    "Rush toolchain metadata",
  );
  const version = parseRequiredString(
    "version" in parsedValue ? parsedValue.version : undefined,
    "Rush toolchain version",
  );
  if (version !== "rush-delivery-rush-toolchain/v1") {
    throw new Error(
      'Rush toolchain version must be "rush-delivery-rush-toolchain/v1".',
    );
  }

  const baseImage = parseRequiredString(
    "base_image" in parsedValue ? parsedValue.base_image : undefined,
    "Rush toolchain base_image",
  );
  if (!BASE_IMAGE_PATTERN.test(baseImage)) {
    throw new Error(
      "Rush toolchain base_image must be a normalized OCI reference with a lowercase sha256 digest.",
    );
  }

  const platform = parseRequiredString(
    "platform" in parsedValue ? parsedValue.platform : undefined,
    "Rush toolchain platform",
  );
  if (platform !== "linux/amd64") {
    throw new Error('Rush toolchain platform must be "linux/amd64".');
  }

  const rawDownloads =
    "downloads" in parsedValue ? parsedValue.downloads : undefined;
  if (
    !Array.isArray(rawDownloads) ||
    rawDownloads.length < 1 ||
    rawDownloads.length > 16
  ) {
    throw new Error("Rush toolchain downloads must contain 1 to 16 records.");
  }
  const downloads = rawDownloads.map(parseDownload);
  const destinations = new Set<string>();
  for (const download of downloads) {
    if (destinations.has(download.destination)) {
      throw new Error(
        `Rush toolchain download destination "${download.destination}" must be unique.`,
      );
    }
    destinations.add(download.destination);
  }

  return {
    base_image: baseImage,
    downloads,
    platform,
    version,
  };
}
